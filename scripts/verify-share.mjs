/**
 * 分享页在**裸浏览器环境**里的渲染验证（`pnpm verify:share`）。
 *
 * 为什么必须真的开一次浏览器：分享页是服务端直出的独立 HTML，正文来自用户
 * Markdown（`html: true`），所以它带了 `script-src 'self'` 的 CSP。这条策略
 * 必须在「读者侧」验证——服务端断言只能证明 meta 写进去了，证明不了页面自己
 * 的运行时（mermaid / 高亮）还能跑。
 *
 * 做法：先起应用拿到分享 URL，再用 Electron 以 `--app=<url>` 开一个独立实例
 * 加载它——那个实例没有本应用的 preload，等价于同事用自己的浏览器打开。
 *
 * 验四件事：CSP meta 在、表格渲染、mermaid 变成 SVG、页面里没有 `window.docvi`。
 * 后两条分别防「CSP 把自己的运行时拦死」与「宿主桥泄漏到公开页面」。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const APP_DIR = join(ROOT, 'apps/desktop')
const ELECTRON = join(ROOT, 'apps/desktop/node_modules/electron/dist/electron.exe')
const wait = ms => new Promise(r => setTimeout(r, ms))

function freePort() {
  return new Promise((ok, fail) => {
    const s = createServer()
    s.unref()
    s.on('error', fail)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => ok(port))
    })
  })
}

async function connect(wsUrl) {
  const socket = new WebSocket(wsUrl)
  await new Promise((ok, fail) => {
    socket.addEventListener('open', ok, { once: true })
    socket.addEventListener('error', fail, { once: true })
  })
  let id = 0
  const pending = new Map()
  const logs = []
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    if (message.method === 'Log.entryAdded') logs.push(message.params?.entry?.text ?? '')
    const cb = pending.get(message.id)
    if (cb) {
      pending.delete(message.id)
      cb(message)
    }
  })
  const send = (method, params = {}) =>
    new Promise((ok, fail) => {
      const n = ++id
      socket.send(JSON.stringify({ id: n, method, params }))
      pending.set(n, m => (m.error ? fail(new Error(m.error.message)) : ok(m.result)))
      setTimeout(() => fail(new Error('timeout ' + method)), 30000)
    })
  const evaluate = async expression => {
    const r = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    return r?.result?.value
  }
  return { socket, send, evaluate, logs }
}

const root = mkdtempSync(join(tmpdir(), 'docvi-share-view-'))
const ws = join(root, 'ws')
mkdirSync(ws, { recursive: true })
writeFileSync(
  join(ws, 'docs.config.yaml'),
  'title: 分享验证\nsidebar:\n  - text: 首页\n    path: index.md\n',
)
writeFileSync(
  join(ws, 'index.md'),
  [
    '# 分享页验证',
    '',
    '正文第一段。',
    '',
    '```mermaid',
    'flowchart LR',
    '  A[甲] --> B[乙]',
    '```',
    '',
    '| 列一 | 列二 |',
    '| ---- | ---- |',
    '| a    | b    |',
    '',
  ].join('\n'),
)

const dataDir = mkdtempSync(join(tmpdir(), 'docvi-share-view-data-'))
const appPort = await freePort()
const pagePort = await freePort()
const children = []
const connections = []

try {
  // ---- 1. 起应用，建分享 ----
  const app = spawn(ELECTRON, [APP_DIR, '--no-sandbox'], {
    env: {
      ...process.env,
      DOCVI_HEADLESS: '1',
      DOCVI_DATA_DIR: dataDir,
      DOCVI_INSTANCE: 'docvi-share-view-app',
      DOCVI_DEBUG_PORT: String(appPort),
    },
    stdio: 'ignore',
  })
  children.push(app)

  let appTarget = null
  for (let i = 0; i < 120; i += 1) {
    await wait(300)
    try {
      const list = await (await fetch(`http://127.0.0.1:${appPort}/json/list`)).json()
      appTarget = list.find(x => x.type === 'page' && x.url.includes('index.html'))
      if (appTarget) break
    } catch {
      // 端口还没起来
    }
  }
  if (!appTarget) throw new Error('应用调试端口没开')

  const appConn = await connect(appTarget.webSocketDebuggerUrl)
  connections.push(appConn)
  await appConn.send('Runtime.enable')
  await appConn.evaluate(`(async () => {
    await window.docvi.workspaceAddAt(${JSON.stringify(ws)})
    return 1
  })()`)
  await wait(900)
  const shareUrl = await appConn.evaluate(`(async () => {
    const created = await window.docvi.shareCreatePath(${JSON.stringify(join(ws, 'index.md'))})
    return created.ok && created.data ? created.data.url : null
  })()`)
  if (!shareUrl) throw new Error('分享创建失败')

  // ---- 2. 以普通浏览器方式打开它（独立 Electron 实例，无本应用 preload）----
  const page = spawn(
    ELECTRON,
    [`--app=${shareUrl}`, '--no-sandbox', `--remote-debugging-port=${pagePort}`],
    {
      env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0' },
      stdio: 'ignore',
    },
  )
  children.push(page)

  let pageTarget = null
  for (let i = 0; i < 80; i += 1) {
    await wait(300)
    try {
      const list = await (await fetch(`http://127.0.0.1:${pagePort}/json/list`)).json()
      pageTarget = list.find(x => x.type === 'page' && !x.url.startsWith('devtools'))
      if (pageTarget) break
    } catch {
      // 端口还没起来
    }
  }
  if (!pageTarget) throw new Error('分享页调试端口没开')

  const pageConn = await connect(pageTarget.webSocketDebuggerUrl)
  connections.push(pageConn)
  await pageConn.send('Runtime.enable')
  await pageConn.send('Log.enable')
  // mermaid 异步渲染，给足时间
  await wait(4000)

  const state = await pageConn.evaluate(`(() => ({
    url: location.href,
    title: document.title,
    hasDocviBridge: typeof window.docvi !== 'undefined',
    hasCsp: Boolean(document.querySelector('meta[http-equiv="Content-Security-Policy"]')),
    hasTable: Boolean(document.querySelector('.share-article table')),
    mermaidSvgs: document.querySelectorAll('.at-mermaid svg').length,
    bodyText: (document.body.innerText || '').slice(0, 100),
  }))()`)

  const cspLogs = pageConn.logs.filter(t => /Content Security Policy|Refused to/i.test(t))
  console.log(JSON.stringify({ page: state, cspViolations: cspLogs.slice(0, 3) }, null, 2))

  const failures = []
  if (!state) failures.push('读不到分享页 DOM')
  else {
    if (state.hasDocviBridge) failures.push('分享页不该有 window.docvi（说明 preload 被注入了）')
    if (!state.hasCsp) failures.push('分享页没有 CSP')
    if (!state.hasTable) failures.push('表格没渲染出来')
    if (!state.mermaidSvgs) failures.push('mermaid 没渲染成 SVG（CSP 可能拦了运行时）')
    if (!(state.bodyText || '').includes('分享页验证')) failures.push('正文没出现')
  }
  if (cspLogs.length) failures.push(`CSP 违规 ${cspLogs.length} 条：${cspLogs[0]}`)

  if (failures.length) {
    console.error('[verify:share-view] 失败：')
    for (const item of failures) console.error('  ✖ ' + item)
    process.exitCode = 1
  } else {
    console.log(
      '[verify:share-view] 通过：裸浏览器里 CSP / 表格 / mermaid 都成立，且无 window.docvi',
    )
  }
} finally {
  for (const c of connections) {
    try {
      c.socket.close()
    } catch {
      // 已关闭
    }
  }
  for (const c of children) c.kill()
  await wait(700)
  rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 })
}
