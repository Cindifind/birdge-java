// Plain ES module, no build step: react and the SDK come from the WebUI's import map.
// The page keeps the settings form the WebUI generates from Config, plus what the Java process is doing.
import { createElement as h, useCallback, useEffect, useState } from 'react'
import { SchemaSettings, usePluginContext } from '@luckylillia/plugin-sdk/webui'

const api = '/api/java-bridge'

function useStatus() {
  const ctx = usePluginContext()
  const [status, setStatus] = useState(null)
  const load = useCallback(() => {
    return ctx.api(`${api}/status`)
      .then(setStatus)
      .catch(error => ctx.toast(error.message, 'error'))
  }, [ctx])
  useEffect(() => {
    load()
    const timer = setInterval(load, 5000)
    return () => clearInterval(timer)
  }, [load])
  return [status, load]
}

function useAction(done) {
  const ctx = usePluginContext()
  const [busy, setBusy] = useState('')
  const run = useCallback((key, path, body) => {
    setBusy(key)
    return ctx.api(path, { method: 'POST', body })
      .then(() => done())
      .catch(error => ctx.toast(error.message, 'error'))
      .finally(() => setBusy(''))
  }, [ctx, done])
  return [busy, run]
}

function Row({ label, children }) {
  return h('div', { style: { display: 'grid', gridTemplateColumns: '7em 1fr', gap: 12, alignItems: 'baseline', fontSize: 13 } },
    h('span', { className: 'text-theme-muted' }, label),
    h('div', { className: 'text-theme', style: { overflowWrap: 'anywhere', minWidth: 0 } }, children),
  )
}

function button(label, onClick, disabled) {
  return h('button', {
    type: 'button',
    className: 'btn-glass',
    disabled,
    onClick,
    style: { padding: '6px 14px', fontSize: 13, fontWeight: 500 },
  }, label)
}

function PluginRow({ plugin, busy, run }) {
  const toggle = () => run(plugin.enabled ? `unload:${plugin.id}` : `load:${plugin.id}`,
    `${api}/plugins/${plugin.enabled ? 'unload' : 'load'}`, { id: plugin.id })
  return h('div', {
    style: {
      display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0',
      borderTop: '1px solid var(--hairline)',
    },
  },
    h('div', { style: { flex: 1, minWidth: 0 } },
      h('div', { className: 'text-theme', style: { fontSize: 14, fontWeight: 500 } },
        plugin.name || plugin.id,
        plugin.version && h('span', { className: 'text-theme-muted', style: { fontSize: 12, marginLeft: 8 } }, `v${plugin.version}`)),
      h('div', { className: 'text-theme-secondary', style: { fontSize: 12, marginTop: 2 } },
        plugin.description || plugin.id),
    ),
    h('span', {
      className: 'text-theme-muted',
      style: { fontSize: 12 },
    }, plugin.enabled ? '已加载' : '未加载'),
    button(plugin.enabled ? '卸载' : '加载', toggle, Boolean(busy)),
  )
}

function RuntimeCard({ status, busy, run }) {
  if (!status) {
    return h('div', { className: 'card', style: { padding: 24 } }, h('span', { className: 'text-theme-secondary' }, '加载中…'))
  }

  const state = status.running ? '运行中' : status.starting ? '启动中…' : '未运行'
  const accounts = status.bots.length
    ? status.bots.map(bot => `${bot.name || bot.selfId}（${bot.sid}）`).join('、')
    : '没有已登录的账号'

  return h('div', { className: 'card', style: { padding: 24, display: 'grid', gap: 16 } },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 12 } },
      h('h3', { className: 'text-theme', style: { flex: 1, margin: 0, fontSize: 17, fontWeight: 600 } }, 'Java 进程'),
      button('刷新', () => run('status', `${api}/status`), Boolean(busy)),
      button('重载 Java 进程', () => run('reload', `${api}/reload`), Boolean(busy)),
    ),
    status.error && h('div', {
      style: {
        fontSize: 13, padding: '10px 12px', borderRadius: 10,
        background: 'rgb(239 68 68 / 0.1)', color: 'rgb(248 113 113)',
      },
    }, status.error),
    h(Row, { label: '状态' }, state),
    h(Row, { label: '桥接 JAR' },
      h('code', null, status.bridgeJar),
      status.bridgeJarExists ? null : h('span', { style: { color: 'rgb(248 113 113)', marginLeft: 8 } }, '（文件不存在）')),
    h(Row, { label: '插件目录' },
      h('code', null, status.javaPluginDir),
      h('div', { className: 'text-theme-muted', style: { fontSize: 12, marginTop: 4 } },
        '把 Java 插件的 .jar 放进这个目录，再点「重载 Java 进程」')),
    h(Row, { label: 'Java' }, h('code', null, status.javaPath)),
    h(Row, { label: 'QQ 账号' }, accounts),
    h('div', null,
      h('div', { className: 'text-theme-secondary', style: { fontSize: 13, fontWeight: 500, marginBottom: 4 } },
        `Java 插件（${status.plugins.length}）`),
      status.plugins.length
        ? status.plugins.map(plugin => h(PluginRow, { key: plugin.id, plugin, busy, run }))
        : h('div', { className: 'text-theme-muted', style: { fontSize: 13, paddingTop: 8 } },
          status.running ? '目录里还没有 Java 插件' : 'Java 进程没有运行，插件列表不可用'),
    ),
  )
}

function JavaBridgePage() {
  const [status, load] = useStatus()
  const [busy, run] = useAction(load)
  return h('div', { style: { display: 'grid', gap: 16 } },
    h(SchemaSettings, {
      sections: [
        { title: '进程', fields: ['javaPath', 'jvmArgs', 'callTimeout'] },
        { title: '文件', fields: ['bridgeJar', 'javaPluginDir', 'classpath'], collapsed: true },
        { title: '事件', fields: ['botSid', 'reportSelfMessage'], collapsed: true },
      ],
    }),
    h(RuntimeCard, { status, busy, run }),
  )
}

export default function apply(ctx) {
  ctx.page({
    id: 'java-bridge',
    title: 'Java 插件桥接',
    icon: 'terminal',
    component: JavaBridgePage,
    order: 15,
    settings: true,
  })
}
