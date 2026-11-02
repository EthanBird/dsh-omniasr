/**
 * OmniASR speech-to-text tools for the Harness Host.
 *
 * Three model-facing tools are registered against the documented OmniASR API
 * (`https://omniasr.vip/api`, Bearer auth):
 *
 * - `omniasr_transcribe` — a local audio/video file, a public media URL, or a
 *   Bilibili/Douyin share text / BV id -> transcript, SRT, VTT or Markdown.
 *   Short local files go through the synchronous endpoint; everything else
 *   goes through the async pipeline (submit, then poll) because that path
 *   accepts long media and remote links.
 * - `omniasr_task` — re-read one async task by id (results are kept 3 days).
 * - `omniasr_usage` — calls, transcribed seconds and remaining quota.
 *
 * The module intentionally imports only Node builtins: a bundle installed from
 * a local directory must not depend on packages resolved inside the dsh
 * installation. `parameters` and `output.schema` are plain JSON Schema, the
 * shape `ctx.tools.register` expects.
 *
 * @module @local/dsh-omniasr
 */

import { open, readFile, stat } from 'node:fs/promises'
import { basename, extname, resolve } from 'node:path'

export const name = 'omniasr'

/** Hard dependency: nothing to do until the tool registry exists. */
export const inject = ['tools']

const DEFAULT_BASE_URL = 'https://omniasr.vip/api'
const DEFAULT_ENGINE = '16k_zh'
const DEFAULT_WAIT_SECONDS = 180
const DEFAULT_SYNC_MAX_BYTES = 20 * 1024 * 1024
const DEFAULT_CHUNK_THRESHOLD_BYTES = 20 * 1024 * 1024
const DEFAULT_MAX_UPLOAD_BYTES = 512 * 1024 * 1024
const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024

/** Formats `omniasr_transcribe` / `omniasr_task` can produce. */
const FORMATS = ['text', 'srt', 'vtt', 'md']

/** Documented hot-word bounds; the service silently ignores or trims beyond them. */
const MAX_HOTWORDS = 20
const MAX_HOTWORD_CHARS = 32
/** Documented `context` bound; the vendor console slices to the same length. */
const MAX_CONTEXT_CHARS = 120

/** Failure codes that mean the socket never opened, so resending is safe even for POST. */
const CONNECT_STAGE_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
])

/** Media MIME hints; the service also sniffs content, this only helps browsers/gateways. */
const MIME_BY_EXTENSION = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.amr': 'audio/amr',
  '.wma': 'audio/x-ms-wma',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
  '.ts': 'video/mp2t',
  '.flv': 'video/x-flv',
}

/** Link shapes the async endpoint resolves itself (Bilibili and Douyin). */
const LINK_PATTERN = /BV[0-9A-Za-z]{10}|bilibili\.com|b23\.tv|douyin\.com|iesdouyin\.com/i
const URL_IN_TEXT = /https?:\/\/[^\s，。、"）)】\]]+/i

/**
 * Resolve the row config into one immutable settings object.
 *
 * @param raw - the Loader row `config` value (unvalidated: this plugin declares no Config schema).
 * @returns resolved settings, with numeric bounds clamped to sane values.
 */
function resolveSettings(raw) {
  const config = raw !== null && typeof raw === 'object' ? raw : {}
  const apiKey = String(
    config.apiKey ?? process.env.OMNIASR_API_KEY ?? process.env.ASR_API_KEY ?? '',
  ).trim()
  const baseUrl = String(config.baseUrl ?? DEFAULT_BASE_URL).trim().replace(/\/+$/, '')
  const positive = (value, fallback) => {
    const number = Number(value)
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback
  }
  return {
    apiKey,
    baseUrl: baseUrl.length > 0 ? baseUrl : DEFAULT_BASE_URL,
    defaultEngine: String(config.defaultEngine ?? DEFAULT_ENGINE).trim() || DEFAULT_ENGINE,
    defaultWaitSeconds: positive(config.defaultWaitSeconds, DEFAULT_WAIT_SECONDS),
    syncMaxBytes: positive(config.syncMaxBytes, DEFAULT_SYNC_MAX_BYTES),
    chunkThresholdBytes: positive(config.chunkThresholdBytes, DEFAULT_CHUNK_THRESHOLD_BYTES),
    maxUploadBytes: positive(config.maxUploadBytes, DEFAULT_MAX_UPLOAD_BYTES),
  }
}

/**
 * Perform one OmniASR HTTP call and decode its payload.
 *
 * OmniASR reports failures as a non-2xx status with `{"error":{"message":...}}`
 * and can also return a bare `error` field on 200; both become thrown Errors so
 * the tool registry materializes them as failed results. A transport failure is
 * retried once for idempotent reads only — a retried submission could create a
 * second billable task.
 *
 * @param settings - resolved plugin settings.
 * @param path - API path beginning with `/v1/...`.
 * @param options - request method, body, extra headers and cancellation.
 * @returns the decoded JSON payload (or the raw text when `asText` is set).
 */
async function callApi(settings, path, options = {}) {
  const method = options.method ?? 'POST'
  // Reads may be retried after any transport failure. A write is retried only
  // for failures that prove the socket never opened: resending a submission
  // that may have reached the server would create a second billable task.
  const maxAttempts = method === 'GET' ? 2 : 3
  let lastError
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await callApiOnce(settings, path, options)
    } catch (error) {
      lastError = error
      const retryable = isConnectStageFailure(error)
        || (method === 'GET' && isTransportFailure(error))
      if (!retryable || attempt >= maxAttempts) break
      await sleep(attempt === 1 ? 700 : 1_800, options.signal).catch(() => {})
    }
  }
  throw lastError
}

/** Whether a failure happened before any request bytes could be delivered. */
function isConnectStageFailure(error) {
  return typeof error?.code === 'string' && CONNECT_STAGE_CODES.has(error.code)
}

/** Whether a failure was a fetch-level transport error at all (no HTTP response). */
function isTransportFailure(error) {
  return error?.name === 'TransportError'
    || (error?.name === 'TypeError' && /fetch failed|terminated/i.test(String(error?.message ?? '')))
}

/** One attempt at an OmniASR request, with transport failures given a usable message. */
async function callApiOnce(settings, path, options) {
  const { method = 'POST', body, headers = {}, signal, asText = false } = options
  const url = `${settings.baseUrl}${path}`
  let response
  try {
    response = await fetch(url, {
      method,
      body,
      headers: { Authorization: `Bearer ${settings.apiKey}`, ...headers },
      signal,
    })
  } catch (error) {
    if (signal?.aborted) throw error
    const cause = error?.cause
    const code = cause?.code ?? cause?.cause?.code
    const detail = cause?.message ?? error?.message ?? String(error)
    const wrapped = new Error(
      `OmniASR network error on ${path}${code === undefined ? '' : ` (${code})`}: ${detail}`,
    )
    // Name/`code` keep the failure classifiable by the retry policy while the
    // message stays model-facing.
    wrapped.name = 'TransportError'
    if (typeof code === 'string') wrapped.code = code
    throw wrapped
  }
  const text = await response.text()
  let payload
  try {
    payload = text.length > 0 ? JSON.parse(text) : undefined
  } catch {
    payload = undefined
  }
  if (!response.ok) {
    const detail = payload?.error?.message ?? payload?.error ?? text.slice(0, 400)
    throw new Error(`OmniASR ${response.status} on ${path}: ${formatDetail(detail)}`)
  }
  if (asText) return text
  if (payload === undefined) {
    throw new Error(`OmniASR returned a non-JSON response on ${path}: ${text.slice(0, 300)}`)
  }
  if (payload.error !== undefined) {
    throw new Error(`OmniASR on ${path}: ${formatDetail(payload.error?.message ?? payload.error)}`)
  }
  return payload
}

/** Render an error detail that may be a string or an object. */
function formatDetail(detail) {
  if (typeof detail === 'string') return detail
  try {
    return JSON.stringify(detail)
  } catch {
    return String(detail)
  }
}

/** Pick the first non-empty string among candidates. */
function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  return ''
}

/** Format whole seconds as `HH:MM:SS,mmm` (SRT) or `HH:MM:SS.mmm` (VTT). */
function timestamp(seconds, separator) {
  const total = Math.max(0, Math.round(Number(seconds) * 1000))
  const hours = Math.floor(total / 3_600_000)
  const minutes = Math.floor((total % 3_600_000) / 60_000)
  const secs = Math.floor((total % 60_000) / 1000)
  const millis = total % 1000
  const pad = (value, width = 2) => String(value).padStart(width, '0')
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)}${separator}${pad(millis, 3)}`
}

/** Build SRT text from `result.segments` when the service did not return one. */
function srtFromSegments(segments) {
  if (!Array.isArray(segments) || segments.length === 0) return ''
  const blocks = segments.map((segment, index) => {
    const start = timestamp(segment?.start ?? 0, ',')
    const end = timestamp(segment?.end ?? segment?.start ?? 0, ',')
    return `${index + 1}\n${start} --> ${end}\n${String(segment?.text ?? '').trim()}`
  })
  return `${blocks.join('\n\n')}\n`
}

/** Build WebVTT text from `result.segments` when the service did not return one. */
function vttFromSegments(segments) {
  if (!Array.isArray(segments) || segments.length === 0) return ''
  const blocks = segments.map((segment) => {
    const start = timestamp(segment?.start ?? 0, '.')
    const end = timestamp(segment?.end ?? segment?.start ?? 0, '.')
    return `${start} --> ${end}\n${String(segment?.text ?? '').trim()}`
  })
  return `WEBVTT\n\n${blocks.join('\n\n')}\n`
}

/**
 * Normalize one sync response or one async task snapshot.
 *
 * Both endpoints return the same transcription body, either at the top level or
 * nested under `result`, so every representation (text, SRT, VTT, Markdown) is
 * read from one place.
 */
function normalizeTranscript(payload) {
  const nested = payload?.result !== null && typeof payload?.result === 'object' ? payload.result : payload
  const text = firstString(
    nested?.organized_text,
    nested?.text,
    payload?.text,
    nested?.raw_text,
  )
  const duration = Number(payload?.audio_duration ?? nested?.duration ?? payload?.audio_duration_sec)
  return {
    text,
    srt: firstString(nested?.srt),
    vtt: firstString(nested?.vtt),
    markdown: firstString(nested?.markdown),
    segments: Array.isArray(nested?.segments) ? nested.segments : [],
    language: firstString(nested?.language, payload?.language),
    engine: firstString(payload?.engine, nested?.engine),
    duration: Number.isFinite(duration) && duration > 0 ? duration : undefined,
    taskId: firstString(payload?.task_id, payload?.request_id),
    status: firstString(payload?.status),
  }
}

/** Choose the requested representation from a normalized transcript. */
function selectFormat(transcript, format) {
  if (format === 'srt') {
    return transcript.srt || srtFromSegments(transcript.segments) || transcript.text
  }
  if (format === 'vtt') {
    return transcript.vtt || vttFromSegments(transcript.segments) || transcript.text
  }
  if (format === 'md') return transcript.markdown || transcript.text
  return transcript.text
}

/** Coerce a model-supplied format argument. */
function pickFormat(value) {
  return FORMATS.includes(value) ? value : 'text'
}

/**
 * Accept either documented `hotwords` spelling and return the canonical list.
 *
 * A string is split on ASCII/Chinese commas, enumeration commas, semicolons and
 * newlines; array items are treated the same way. Duplicates collapse, each word
 * is cut to the documented 32 characters, and the list stops at 20 entries —
 * the boundaries the service itself documents.
 */
function normalizeHotwords(value) {
  const words = []
  const absorb = (raw) => {
    for (const part of String(raw).split(/[,，、;；\r\n]+/u)) {
      const word = part.trim()
      if (word.length === 0) continue
      const clipped = word.slice(0, MAX_HOTWORD_CHARS)
      if (!words.includes(clipped)) words.push(clipped)
      if (words.length >= MAX_HOTWORDS) return
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (words.length >= MAX_HOTWORDS) break
      if (typeof item === 'string') absorb(item)
    }
  } else if (typeof value === 'string') {
    absorb(value)
  }
  return words
}

/** Normalize the one-sentence `context` background to its documented length. */
function normalizeContext(value) {
  if (typeof value !== 'string') return ''
  return value.trim().replace(/\s+/gu, ' ').slice(0, MAX_CONTEXT_CHARS)
}

/** Resolve a source into a local file or a remote link the API can fetch. */
function classifySource(settings, source) {
  const trimmed = source.trim()
  if (/^https?:\/\//i.test(trimmed)) return { kind: 'remote', value: trimmed }
  const embedded = trimmed.match(URL_IN_TEXT)
  if (embedded) return { kind: 'remote', value: embedded[0] }
  if (LINK_PATTERN.test(trimmed)) {
    const id = trimmed.match(/BV[0-9A-Za-z]{10}(?:\?p=\d+)?/)
    if (id) return { kind: 'remote', value: id[0] }
  }
  const path = resolve(trimmed)
  return { kind: 'file', value: path }
}

/** MIME hint for one file name. */
function mimeOf(filename) {
  return MIME_BY_EXTENSION[extname(filename).toLowerCase()] ?? 'application/octet-stream'
}

/** Read a whole local file into an upload Blob. */
async function readUploadBlob(settings, filePath) {
  const info = await stat(filePath).catch(() => undefined)
  if (info === undefined || !info.isFile()) {
    throw new Error(`local media file not found: ${filePath}`)
  }
  if (info.size > settings.maxUploadBytes) {
    throw new Error(
      `local media file is ${Math.round(info.size / 1_048_576)} MiB, above the configured ${Math.round(settings.maxUploadBytes / 1_048_576)} MiB upload limit; pass a public URL or raise maxUploadBytes`,
    )
  }
  const bytes = await readFile(filePath)
  return new Blob([bytes], { type: mimeOf(filePath) })
}

/**
 * Upload a large local file through the documented 8 MiB chunk protocol.
 *
 * Streams one chunk at a time from disk so multi-gigabyte files never sit in
 * memory, and returns the `upload_id` the async endpoint accepts.
 */
async function uploadInChunks(settings, filePath, signal) {
  const init = await callApi(settings, '/v1/upload/init', {
    body: JSON.stringify({ filename: basename(filePath) }),
    headers: { 'Content-Type': 'application/json' },
    signal,
  })
  const uploadId = firstString(init?.upload_id)
  if (uploadId.length === 0) throw new Error('OmniASR upload init did not return an upload_id')
  const advertised = Number(init?.chunk_size)
  const chunkSize = Number.isFinite(advertised) && advertised > 0
    ? Math.floor(advertised)
    : DEFAULT_CHUNK_SIZE
  const handle = await open(filePath, 'r')
  try {
    const buffer = Buffer.allocUnsafe(chunkSize)
    let position = 0
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, chunkSize, position)
      if (bytesRead === 0) break
      await callApi(settings, '/v1/upload/chunk', {
        body: buffer.subarray(0, bytesRead),
        headers: {
          'X-Upload-Id': uploadId,
          'Content-Type': 'application/octet-stream',
        },
        signal,
      })
      position += bytesRead
      if (bytesRead < chunkSize) break
    }
  } finally {
    await handle.close()
  }
  return uploadId
}

/** Abortable delay used between task polls. */
function sleep(ms, signal) {
  return new Promise((resolvePromise, rejectPromise) => {
    if (signal?.aborted) {
      rejectPromise(new Error('aborted'))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      rejectPromise(new Error('aborted'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort)
      resolvePromise()
    }, ms)
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

/**
 * Submit one async job and poll it until it finishes or the wait budget ends.
 *
 * @returns the last task snapshot; `status` tells the caller whether it settled.
 */
async function runAsyncJob(settings, source, options, signal) {
  const payload = {
    engine: options.engine,
    organize: options.organize,
  }
  const hotwordText = hotwordField(options.hotwords)
  if (hotwordText.length > 0) payload.hotwords = hotwordText
  if (options.context.length > 0) payload.context = options.context
  let submitted
  if (source.kind === 'remote') {
    submitted = await callApi(settings, '/v1/audio/transcriptions/async', {
      body: JSON.stringify({ url: source.value, ...payload }),
      headers: { 'Content-Type': 'application/json' },
      signal,
    })
  } else {
    const info = await stat(source.value).catch(() => undefined)
    if (info === undefined || !info.isFile()) {
      throw new Error(`local media file not found: ${source.value}`)
    }
    if (info.size > settings.maxUploadBytes) {
      throw new Error(
        `local media file is ${Math.round(info.size / 1_048_576)} MiB, above the configured ${Math.round(settings.maxUploadBytes / 1_048_576)} MiB upload limit`,
      )
    }
    if (info.size > settings.chunkThresholdBytes) {
      const uploadId = await uploadInChunks(settings, source.value, signal)
      submitted = await callApi(settings, '/v1/audio/transcriptions/async', {
        body: JSON.stringify({ upload_id: uploadId, ...payload }),
        headers: { 'Content-Type': 'application/json' },
        signal,
      })
    } else {
      const form = new FormData()
      form.append('file', await readUploadBlob(settings, source.value), basename(source.value))
      form.append('engine', options.engine)
      form.append('organize', options.organize ? 'true' : 'false')
      if (hotwordText.length > 0) form.append('hotwords', hotwordText)
      if (options.context.length > 0) form.append('context', options.context)
      submitted = await callApi(settings, '/v1/audio/transcriptions/async', {
        body: form,
        signal,
      })
    }
  }

  const taskId = firstString(submitted?.task_id)
  if (taskId.length === 0) throw new Error('OmniASR did not return a task_id')
  const deadline = Date.now() + options.waitSeconds * 1000
  let delay = 1_500
  let snapshot = submitted
  for (;;) {
    const status = firstString(snapshot?.status)
    if (status === 'completed') return snapshot
    if (status === 'failed') {
      throw new Error(`OmniASR task ${taskId} failed: ${formatDetail(snapshot?.error?.message ?? snapshot?.error ?? 'unknown error')}`)
    }
    if (Date.now() + delay > deadline) return snapshot
    await sleep(delay, signal)
    snapshot = await callApi(settings, `/v1/audio/transcriptions/async/${encodeURIComponent(taskId)}`, {
      method: 'GET',
      signal,
    })
    delay = Math.min(delay + 1_000, 5_000)
  }
}

/** Shared value builder so `transcribe` and `task` return one shape. */
function buildValue(transcript, format, mode, fallbackEngine, extras) {
  const value = {
    text: selectFormat(transcript, format),
    engine: transcript.engine.length > 0 ? transcript.engine : fallbackEngine,
    mode,
    status: transcript.status.length > 0 ? transcript.status : (transcript.text.length > 0 ? 'completed' : 'unknown'),
  }
  if (transcript.duration !== undefined) value.audio_duration = transcript.duration
  if (transcript.language.length > 0) value.language = transcript.language
  if (transcript.taskId.length > 0) value.task_id = transcript.taskId
  if (extras !== undefined) {
    const appliedHotwords = hotwordField(extras.hotwords)
    if (appliedHotwords.length > 0) value.hotwords = appliedHotwords
    if (typeof extras.context === 'string' && extras.context.length > 0) value.context = extras.context
  }
  return value
}

/** Model-facing text for a transcription value. */
function renderTranscript(value) {
  const status = typeof value?.status === 'string' ? value.status : 'unknown'
  if (typeof value?.text === 'string' && value.text.length > 0) return value.text
  if (status === 'completed') {
    return 'OmniASR completed the task but recognized no speech in this media.'
  }
  const task = typeof value?.task_id === 'string' && value.task_id.length > 0 ? ` (task_id ${value.task_id})` : ''
  return `OmniASR task ${status}${task}: no text yet. Fetch it later with omniasr_task.`
}

/** Human-readable quota summary. */
function renderUsage(value) {
  const lines = [
    `OmniASR key: ${value.name || '(unnamed)'}${value.enabled ? '' : ' — DISABLED'}`,
    `Calls: ${value.calls}`,
    `Transcribed: ${value.used_seconds.toFixed(1)} s (${(value.used_seconds / 60).toFixed(1)} min)`,
    `Remaining: ${value.remaining_seconds.toFixed(1)} s = ${(value.remaining_seconds / 60).toFixed(1)} min ≈ ${(value.remaining_seconds / 3600).toFixed(2)} h`,
  ]
  return lines.join('\n')
}

/** The wire form of a hot-word list: the documented comma-separated string. */
function hotwordField(words) {
  return Array.isArray(words) ? words.join(', ') : ''
}

const TRANSCRIBE_DESCRIPTION = [
  'Transcribe speech to text with OmniASR.',
  'Accepts a local audio/video file path, a public media URL, or a Bilibili/Douyin share text (b23.tv link, BV id with ?p=N, or a Douyin share口令).',
  'Short local files (≤20 MiB) use the synchronous endpoint; everything else is submitted to the async pipeline and polled. Results are retained 3 days; if the wait budget expires, the returned task_id can be read later with omniasr_task.',
  'Pass `hotwords` for names, brands and model names that must be spelled exactly (fixes homophones such as "iPhone do no" -> "iPhone Duo"), and `context` for one sentence of background that steers the written-formatting pass (e.g. naming 熵减实验室 so it is not written as 商检实验室).',
  'Return format `text` (default) gives the organized transcript; `srt`/`vtt` give subtitles and `md` the formatted report.',
].join(' ')

const ENGINE_DESCRIPTION = [
  'Recognition engine. Default 16k_zh.',
  'Common: 16k_zh (Mandarin), 16k_zh_large (large model, dialects), 16k_zh_en (Chinese+English), 16k_multi_lang (15 languages), 16k_yue (Cantonese), 16k_en, 16k_ja, 16k_ko, 16k_sichuan, 16k_dongbei, 16k_henan;',
  'telephone 8k: 8k_zh, 8k_zh_large, 8k_en.',
].join(' ')

/**
 * Register the three tools. Every registration is effect-scoped: unloading the
 * plugin unregisters them.
 *
 * @param ctx - context whose `tools` registry receives the definitions.
 * @param rawConfig - the Loader row config.
 */
export function apply(ctx, rawConfig) {
  const settings = resolveSettings(rawConfig)

  ctx.tools.register({
    name: 'omniasr_transcribe',
    description: TRANSCRIBE_DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['source'],
      properties: {
        source: {
          type: 'string',
          description: 'Local audio/video path, public media URL, or Bilibili/Douyin share text / BV id (e.g. BV1am4y1D73g?p=15).',
        },
        engine: { type: 'string', description: ENGINE_DESCRIPTION },
        organize: {
          type: 'boolean',
          description: 'Smart written formatting (default true). false keeps the raw verbatim transcript.',
        },
        format: {
          type: 'string',
          enum: FORMATS,
          description: 'Output representation: text (default), srt, vtt or md.',
        },
        mode: {
          type: 'string',
          enum: ['auto', 'sync', 'async'],
          description: 'auto (default) picks sync for small local files and async for links/large files; sync and async force one pipeline.',
        },
        hotwords: {
          oneOf: [
            {
              type: 'string',
              description: 'Comma-separated hot words, e.g. "iPhone Duo, 三星 Fold7".',
            },
            {
              type: 'array',
              items: { type: 'string' },
              description: 'Hot word list, e.g. ["iPhone Duo", "三星 Fold7"].',
            },
          ],
          description:
            'Proper nouns the recognition/organize pass should spell exactly (names, brands, models). Up to 20 words, each at most 32 characters; extras are trimmed. Works on both the sync and async paths, and corrects homophone mis-writes such as "iPhone do no" -> "iPhone Duo".',
        },
        context: {
          type: 'string',
          description:
            'One-sentence background (at most 120 characters, e.g. "数码博主米奇沃克斯评测苹果折叠屏 iPhone Duo"). The written-formatting pass uses it to restore domain wording, e.g. it turns 商检实验室 into 熵减实验室 when the context names 熵减实验室. Longer text is cut to 120 characters.',
        },
        wait_seconds: {
          type: 'integer',
          description: `How long to wait for an async job before returning its task_id (default ${DEFAULT_WAIT_SECONDS}).`,
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'engine', 'mode', 'status'],
        properties: {
          text: { type: 'string' },
          engine: { type: 'string' },
          mode: { type: 'string' },
          status: { type: 'string' },
          audio_duration: { type: 'number' },
          language: { type: 'string' },
          task_id: { type: 'string' },
          hotwords: { type: 'string' },
          context: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderTranscript(value) }],
    },
    timeoutMs: 900_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (settings.apiKey.length === 0) {
        throw new Error('OmniASR apiKey is not configured (plugin config `apiKey` or OMNIASR_API_KEY)')
      }
      const source = classifySource(settings, String(args?.source ?? ''))
      const engine = String(args?.engine ?? settings.defaultEngine).trim() || settings.defaultEngine
      const organize = args?.organize === undefined ? true : Boolean(args.organize)
      const format = pickFormat(args?.format)
      const hotwords = normalizeHotwords(args?.hotwords)
      const context = normalizeContext(args?.context)
      const waitSeconds = Math.min(Math.max(Number(args?.wait_seconds ?? settings.defaultWaitSeconds), 5), 1_800)
      const requestedMode = args?.mode === 'sync' || args?.mode === 'async' ? args.mode : 'auto'

      let payload
      let mode = 'async'
      if (requestedMode !== 'async' && source.kind === 'file') {
        const info = await stat(source.value).catch(() => undefined)
        if (info !== undefined && info.isFile() && info.size <= settings.syncMaxBytes) {
          try {
            payload = await transcribeSync(settings, source, {
              engine,
              organize,
              hotwords,
              context,
              signal: exec.signal,
            })
            mode = 'sync'
          } catch (error) {
            if (requestedMode === 'sync') throw error
            payload = undefined
          }
        }
      }
      if (payload === undefined) {
        payload = await runAsyncJob(
          settings,
          source,
          { engine, organize, hotwords, context, waitSeconds },
          exec.signal,
        )
        mode = 'async'
      }

      const transcript = normalizeTranscript(payload)
      return buildValue(transcript, format, mode, engine, { hotwords, context })
    },
  })

  ctx.tools.register({
    name: 'omniasr_task',
    description:
      'Read one OmniASR asynchronous transcription task by id: its status, and its text/SRT/VTT/Markdown once completed. Results stay readable for 3 days after submission.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['task_id'],
      properties: {
        task_id: {
          type: 'string',
          description: 'The task_id returned by omniasr_transcribe or by an async submission (e.g. task_84236fa3c8e43cd2a35b).',
        },
        format: {
          type: 'string',
          enum: FORMATS,
          description: 'Output representation: text (default), srt, vtt or md.',
        },
        wait_seconds: {
          type: 'integer',
          description: 'Keep polling for up to this many seconds while the task is still running (default 0).',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'engine', 'mode', 'status'],
        properties: {
          text: { type: 'string' },
          engine: { type: 'string' },
          mode: { type: 'string' },
          status: { type: 'string' },
          audio_duration: { type: 'number' },
          language: { type: 'string' },
          task_id: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderTranscript(value) }],
    },
    timeoutMs: 900_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (settings.apiKey.length === 0) {
        throw new Error('OmniASR apiKey is not configured (plugin config `apiKey` or OMNIASR_API_KEY)')
      }
      const taskId = String(args?.task_id ?? '').trim()
      if (taskId.length === 0) throw new Error('task_id is required')
      const format = pickFormat(args?.format)
      const waitSeconds = Math.min(Math.max(Number(args?.wait_seconds ?? 0), 0), 1_800)
      const deadline = Date.now() + waitSeconds * 1000
      const readTask = async () => {
        try {
          return await callApi(settings, `/v1/audio/transcriptions/async/${encodeURIComponent(taskId)}`, {
            method: 'GET',
            signal: exec.signal,
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const detail = message.replace(/^OmniASR (?:network error on |\d+ on )?[^:]*: /u, '')
          throw new Error(`OmniASR task ${taskId}: ${detail}`)
        }
      }
      let payload = await readTask()
      while (waitSeconds > 0 && Date.now() < deadline) {
        const status = firstString(payload?.status)
        if (status === 'completed' || status === 'failed') break
        await sleep(2_000, exec.signal)
        payload = await readTask()
      }
      const transcript = normalizeTranscript(payload)
      if (transcript.taskId.length === 0) transcript.taskId = taskId
      return buildValue(transcript, format, 'async', settings.defaultEngine)
    },
  })

  ctx.tools.register({
    name: 'omniasr_usage',
    description:
      'Show the OmniASR account usage behind the configured API key: total calls, transcribed seconds and remaining quota in seconds/minutes/hours.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'enabled', 'calls', 'used_seconds', 'remaining_seconds'],
        properties: {
          name: { type: 'string' },
          enabled: { type: 'boolean' },
          calls: { type: 'integer' },
          used_seconds: { type: 'number' },
          remaining_seconds: { type: 'number' },
          remaining_minutes: { type: 'number' },
          remaining_hours: { type: 'number' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderUsage(value) }],
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      if (settings.apiKey.length === 0) {
        throw new Error('OmniASR apiKey is not configured (plugin config `apiKey` or OMNIASR_API_KEY)')
      }
      const payload = await callApi(settings, '/v1/usage', { method: 'GET', signal: exec.signal })
      return mapUsage(payload)
    },
  })

  mountUsageRoute(ctx, settings)
}

/**
 * Project one `/v1/usage` payload onto the shape both the tool and the Client
 * UI consume, so the number a person reads in Settings is the same number the
 * Agent reports.
 */
function mapUsage(payload) {
  const usedSeconds = Number(payload?.used_seconds ?? payload?.audio_seconds ?? 0)
  const remainingSeconds = Number(payload?.remaining_seconds ?? 0)
  return {
    name: firstString(payload?.name),
    enabled: payload?.enabled !== false,
    calls: Number(payload?.calls ?? payload?.total_requests ?? 0),
    used_seconds: Number.isFinite(usedSeconds) ? usedSeconds : 0,
    remaining_seconds: Number.isFinite(remainingSeconds) ? remainingSeconds : 0,
    remaining_minutes: Number.isFinite(Number(payload?.remaining_minutes))
      ? Number(payload.remaining_minutes)
      : Number((remainingSeconds / 60).toFixed(1)),
    remaining_hours: Number.isFinite(Number(payload?.remaining_hours))
      ? Number(payload.remaining_hours)
      : Number((remainingSeconds / 3600).toFixed(2)),
  }
}

/**
 * Serve the quota to the browser half at a same-origin path.
 *
 * The page never sees the API key: it asks this Host route, which performs the
 * authenticated request itself. The route is registered when a web carrier
 * exists (it is optional so the tools still work in a non-web composition).
 */
function mountUsageRoute(ctx, settings) {
  let mounted = false

  const mount = (scope) => {
    if (mounted) return
    const server = typeof scope.get === 'function' ? scope.get('webServer') : scope.webServer
    if (server === undefined || server === null) return
    mounted = true
    scope.effect(() =>
      server.register({
        kind: 'exact',
        path: '/omniasr/usage',
        async handler(_request, response) {
          const send = (status, body) => {
            response.writeHead(status, {
              'Content-Type': 'application/json; charset=utf-8',
              'Cache-Control': 'no-store',
            })
            response.end(JSON.stringify(body))
          }
          if (settings.apiKey.length === 0) {
            send(200, { ok: false, error: '未配置 OmniASR apiKey' })
            return
          }
          try {
            send(200, { ok: true, account: mapUsage(await callApi(settings, '/v1/usage', { method: 'GET' })) })
          } catch (error) {
            send(200, { ok: false, error: error instanceof Error ? error.message : String(error) })
          }
        },
      }),
    )
  }

  mount(ctx)
  if (!mounted && typeof ctx.inject === 'function') ctx.inject(['webServer'], mount)
}

/**
 * Call the synchronous endpoint (≤60 s of audio) with a local file or a URL.
 *
 * `verbose_json` is requested so one round trip also carries SRT/VTT/Markdown
 * and segment timing for the caller's chosen output format.
 */
async function transcribeSync(settings, source, options) {
  const fields = {
    engine: options.engine,
    organize: options.organize ? 'true' : 'false',
    response_format: 'verbose_json',
  }
  const hotwordText = hotwordField(options.hotwords)
  if (hotwordText.length > 0) fields.hotwords = hotwordText
  if (options.context.length > 0) fields.context = options.context
  if (source.kind === 'remote') {
    return callApi(settings, '/v1/audio/transcriptions', {
      body: JSON.stringify({ url: source.value, ...fields }),
      headers: { 'Content-Type': 'application/json' },
      signal: options.signal,
    })
  }
  const form = new FormData()
  form.append('file', await readUploadBlob(settings, source.value), basename(source.value))
  for (const [key, value] of Object.entries(fields)) form.append(key, value)
  return callApi(settings, '/v1/audio/transcriptions', { body: form, signal: options.signal })
}
