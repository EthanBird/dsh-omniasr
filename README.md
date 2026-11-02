# OmniASR tools for DeepSeek Harness

A Host bundle plus a small Client half that gives this Harness profile three
tools backed by the [OmniASR](https://omniasr.vip/docs) speech-to-text API, and
a Settings page showing the live quota.

## Install

1. Drop this folder into the Harness profile's `plugins/` directory, or link it
   as a local package.
2. Create the instance config from the template and fill in your own key:

   ```bash
   cp cordis.patch.example.yml cordis.patch.yml
   # then set config.apiKey in cordis.patch.yml
   ```

   `cordis.patch.yml` is git-ignored on purpose — it holds a live API key. You can
   also leave `apiKey` empty and export `OMNIASR_API_KEY` (or `ASR_API_KEY`).
3. Reload the profile. The three tools appear on the Host side and **Settings →
   OmniASR** shows the live quota. Refresh the page after installing, because the
   Client half is served at boot.

The browser never receives the key: the Host makes the authenticated upstream
call through its own same-origin `GET /omniasr/usage` route.

| Tool | Purpose |
| --- | --- |
| `omniasr_transcribe` | Local audio/video path, public media URL, or Bilibili/Douyin share text or BV id → transcript, SRT, VTT or Markdown; accepts `hotwords` and `context` |
| `omniasr_task` | Re-read one async task by `task_id` (results are retained 3 days) |
| `omniasr_usage` | Calls, transcribed seconds, and remaining quota |

## Hot words and context (site v6.6)

Both are optional on the sync and async endpoints and are forwarded by the tool:

- `hotwords` — names, brands and model names that must be spelled exactly.
  Accepts a comma-separated string or a string array. The plugin normalizes
  to the documented comma string, dedupes, cuts each word to 32 characters and
  stops at 20 words. Measured effect on one clip: `iPhone do no` / `fold 七`
  → `iPhone Duo` / `三星 Fold7 和 Fold8` with
  `hotwords: "iPhone Duo, 三星 Fold7"`. The correction runs through the
  organize pass, so it steers rather than guarantees: in 4 identical runs the
  spelling came back `iPhone Duo` three times and `iPhone dual` once.
- `context` — one sentence of background (≤120 characters) that steers the
  written-formatting pass. Measured effect: the same clip was written as
  `商检实验室` with no context and `熵减实验室` when the context sentence named
  `熵减实验室`.
- Both are echoed back in the tool result (`hotwords`, `context`) so a caller can
  see exactly what was applied, including any trimming.
- Practical split measured on this deployment: `hotwords` fixed Latin brand and
  model spellings (`iPhone do no` → `iPhone Duo`) but did **not** fix a Chinese
  homophone (`商检实验室` stayed wrong even with `hotwords: "熵减实验室"`);
  naming that term in `context` did fix it. Use `context` for Chinese proper
  nouns and meeting background, `hotwords` for brands and model numbers.

## How it talks to the API

Base `https://omniasr.vip/api`, `Authorization: Bearer <apiKey>`.

- Short local files (≤ `syncMaxBytes`, default 20 MiB) use
  `POST /v1/audio/transcriptions` with `response_format=verbose_json`, so one
  round trip already carries text, SRT, VTT, Markdown and segment timing.
- Links and larger files use `POST /v1/audio/transcriptions/async` and are
  polled with `GET /v1/audio/transcriptions/async/{task_id}`. Files above
  `chunkThresholdBytes` (default 20 MiB) go through the 8 MiB chunk upload
  (`POST /v1/upload/init`, `POST /v1/upload/chunk`) and are submitted by
  `upload_id`, matching the vendor console, so large videos never sit in memory.
- When the poll budget (`wait_seconds`, default 180) runs out, the tool returns
  the pending `task_id` and the caller finishes with `omniasr_task`.

## Configuration

```yaml
- insert:
    - id: omniasr
      name: '@local/dsh-omniasr'
      config:
        apiKey: 'sk-omni-...'
        baseUrl: 'https://omniasr.vip/api'
        defaultEngine: '16k_zh'
        defaultWaitSeconds: 180
```

| Key | Default | Meaning |
| --- | --- | --- |
| `apiKey` | `OMNIASR_API_KEY`, then `ASR_API_KEY` | Bearer key |
| `baseUrl` | `https://omniasr.vip/api` | API root |
| `defaultEngine` | `16k_zh` | Engine when a call omits `engine` |
| `defaultWaitSeconds` | `180` | Async poll budget |
| `syncMaxBytes` | `20971520` | Largest file attempted on the sync endpoint |
| `chunkThresholdBytes` | `20971520` | Above this, upload in 8 MiB chunks |
| `maxUploadBytes` | `536870912` | Hard local-file ceiling |

Engines include `16k_zh`, `16k_zh_large`, `16k_zh_en`, `16k_multi_lang`,
`16k_yue`, `16k_en`, `16k_ja`, `16k_ko`, `16k_sichuan`, `16k_dongbei`,
`16k_henan`, and the telephone set `8k_zh`, `8k_zh_large`, `8k_en`.

## Settings UI

The bundle ships a Client half (`client.js`) beside the Host half, so the Web
GUI renders:

- **Settings → OmniASR** (`settings.section`, id `omniasr`): the live quota —
  key name, state, call count, transcribed minutes, remaining hours — with a
  refresh button and a one-line summary of the three tools.
- **Plugins → @local/dsh-omniasr** (`plugins.bundle.config`, key
  `@local/dsh-omniasr`): a summary cell beside the bundle description, and the
  same quota card on the bundle page.

Both read `GET /omniasr/usage`, a same-origin Host route this plugin registers
on `ctx.webServer`. The browser never receives the API key; the Host performs
the authenticated upstream call. A plugin without a Client half and without a
`Config` schema has no settings surface at all, which is why the first version
of this bundle showed nothing in Settings.

A Client half is served at page boot, so a refresh is required after installing
or changing it.

## Notes

- The plugin imports only Node builtins, so it works from a locally linked
  package without depending on modules resolved inside the dsh installation.
- `organize: true` (default) returns the polished written form; `false`
  returns the verbatim transcript.
- `format: 'srt' | 'vtt'` synthesizes subtitles from segment timing when the
  service did not return its own SRT/VTT body.

## License

MIT — see [LICENSE](LICENSE).
