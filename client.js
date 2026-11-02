/**
 * Client half of the OmniASR bundle: a Settings section plus a summary cell on
 * the bundle page, both showing the live OmniASR quota read from the Host route
 * `/omniasr/usage` (same origin, so no CORS and no key exposure to the page).
 *
 * Plain browser ESM registered through the dsh module table; React comes from
 * that table, never from a second copy.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-omniasr',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    const COLOR = {
      label: 'var(--dsw-alias-label-primary)',
      muted: 'var(--dsw-alias-label-secondary)',
      border: 'var(--dsw-alias-border-l1)',
      surface: 'var(--dsw-alias-bg-layer-1)',
      brand: 'var(--dsw-alias-brand-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
    }

    /** Read the Host-computed quota snapshot. */
    async function readUsage() {
      const response = await fetch('/omniasr/usage', {
        headers: { accept: 'application/json' },
        cache: 'no-store',
      })
      const payload = await response.json().catch(() => undefined)
      if (payload === undefined || payload.ok !== true) {
        throw new Error((payload && payload.error) || `HTTP ${response.status}`)
      }
      return payload.account
    }

    /** Load-on-mount quota state shared by both surfaces. */
    function useUsage() {
      const [state, setState] = useState({ phase: 'loading' })
      const load = useCallback(async () => {
        setState({ phase: 'loading' })
        try {
          setState({ phase: 'ready', account: await readUsage() })
        } catch (error) {
          setState({ phase: 'error', message: String((error && error.message) || error) })
        }
      }, [])
      useEffect(() => {
        load()
      }, [load])
      return [state, load]
    }

    const hours = (seconds) => (Number(seconds || 0) / 3600).toFixed(2)
    const minutes = (seconds) => (Number(seconds || 0) / 60).toFixed(1)

    function RefreshButton(props) {
      return h(
        'button',
        {
          type: 'button',
          onClick: props.onClick,
          disabled: props.disabled,
          style: {
            appearance: 'none',
            border: `1px solid ${COLOR.border}`,
            background: 'transparent',
            color: COLOR.label,
            borderRadius: '8px',
            padding: '5px 12px',
            fontSize: '12.5px',
            cursor: props.disabled ? 'default' : 'pointer',
            opacity: props.disabled ? 0.6 : 1,
          },
        },
        props.disabled ? '读取中…' : '刷新额度',
      )
    }

    function Card(props) {
      const account = props.account
      const rows = [
        ['密钥', account.name || '(未命名)'],
        ['状态', account.enabled ? '已启用' : '已停用'],
        ['调用次数', String(account.calls)],
        ['已转写', `${minutes(account.used_seconds)} 分钟`],
        ['剩余额度', `${hours(account.remaining_seconds)} 小时`],
      ]
      return h(
        'div',
        {
          style: {
            border: `1px solid ${COLOR.border}`,
            borderRadius: '10px',
            background: COLOR.surface,
            padding: '14px 16px',
            display: 'flex',
            flexDirection: 'column',
            gap: '9px',
          },
        },
        rows.map((row) =>
          h(
            'div',
            {
              key: row[0],
              style: { display: 'flex', justifyContent: 'space-between', gap: '16px', fontSize: '13px' },
            },
            h('span', { style: { color: COLOR.muted } }, row[0]),
            h(
              'span',
              { style: { color: COLOR.label, fontWeight: 500, textAlign: 'right', wordBreak: 'break-word' } },
              row[1],
            ),
          ),
        ),
      )
    }

    /** Status body shared by the settings section and the bundle page. */
    function QuotaBody(props) {
      const state = props.state
      if (state.phase === 'ready') return h(Card, { account: state.account })
      if (state.phase === 'error') {
        return h(
          'div',
          { style: { fontSize: '12.5px', color: COLOR.error, lineHeight: 1.6 } },
          `额度读取失败：${state.message}`,
        )
      }
      return h('div', { style: { fontSize: '12.5px', color: COLOR.muted } }, '正在读取额度…')
    }

    function Section() {
      const [state, load] = useUsage()
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '14px', padding: '2px 0' } },
        h(
          'div',
          null,
          h('div', { style: { fontSize: '16px', fontWeight: 600, color: COLOR.label } }, 'OmniASR 语音转写'),
          h(
            'div',
            { style: { marginTop: '4px', fontSize: '13px', color: COLOR.muted, lineHeight: 1.7 } },
            'Agent 已可调用语音识别：本地音视频、公网链接、B站/抖音分享链接都能转写，并导出 SRT/VTT/Markdown。',
          ),
          h(
            'div',
            { style: { marginTop: '4px', fontSize: '12.5px', color: COLOR.muted, lineHeight: 1.7 } },
            '支持专有名词热词（hotwords，最多 20 个）与一句话上下文背景（context，≤120 字），用于修正同音误写与还原领域用语。',
          ),
        ),
        h(
          'div',
          { style: { fontSize: '12.5px', color: COLOR.muted, lineHeight: 1.8 } },
          '工具：omniasr_transcribe（转写）、omniasr_task（续查异步任务）、omniasr_usage（额度）。',
        ),
        h(QuotaBody, { state }),
        h(
          'div',
          { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
          h(RefreshButton, { onClick: load, disabled: state.phase === 'loading' }),
        ),
        h(
          'div',
          { style: { fontSize: '12px', color: COLOR.muted, lineHeight: 1.7 } },
          'API Key、默认引擎与等待时长在插件行配置（cordis.patch.yml）中；apiKey 留空时读取环境变量 OMNIASR_API_KEY。',
        ),
      )
    }

    function BundleConfig(props) {
      const [state, load] = useUsage()
      const view = props && props.view
      if (view === 'summary') {
        if (state.phase === 'ready') {
          return h(
            'span',
            { style: { fontSize: '12.5px', color: COLOR.muted } },
            `剩余 ${hours(state.account.remaining_seconds)} 小时 · 已调用 ${state.account.calls} 次`,
          )
        }
        if (state.phase === 'error') {
          return h('span', { style: { fontSize: '12.5px', color: COLOR.error } }, '额度读取失败')
        }
        return h('span', { style: { fontSize: '12.5px', color: COLOR.muted } }, '读取额度…')
      }
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
        h(QuotaBody, { state }),
        h(RefreshButton, { onClick: load, disabled: state.phase === 'loading' }),
        h(
          'div',
          { style: { fontSize: '12px', color: COLOR.muted, lineHeight: 1.7 } },
          '该插件只向 Agent 注册工具，没有可编辑的配置项；密钥与默认引擎在插件行配置里。',
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'omniasr', order: 17, label: 'OmniASR' },
            Section,
          ),
        )
        ctx.slots.inject('plugins.bundle.config', () =>
          ctx.slots.register(
            { name: 'plugins.bundle.config', key: '@local/dsh-omniasr' },
            BundleConfig,
          ),
        )
      },
    }
  },
})
