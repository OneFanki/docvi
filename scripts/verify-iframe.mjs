/**
 * 无头端到端验证：md 里的原生 `<iframe>` 能否加载本地 html 并执行脚本。
 *
 * 验的是完整链路而不是单元里的字符串：
 *   渲染管线补资产前缀 → `docvi://asset/<id>/…` 协议伺服 html
 *   → CSP 放行子文档 → iframe 内联 script 真的跑起来。
 *
 * 任何一环断了，最终读数都是「iframe 内容为空」——这正是单元测试测不到的。
 *
 * 判据不用截图（那些像素无法自动判定），改用 CDP 在页面里读 iframe 的
 * `contentDocument`：`sandbox="allow-scripts"` 只给脚本不给 same-origin，
 * 所以父页**读不到**子文档 DOM——那就换个可观测信号：子文档的 `postMessage`
 * 回传。那才是「脚本真的执行了」的证据。
 *
 * 回传用**握手**而不是单向广播：子文档加载完主动上报一次，同时响应父页的
 * `ping`。只靠「加载时广播一次」会有竞态——文档渲染完 → 脚本立刻发消息 →
 * 探针才挂上监听，消息已经丢了，读数会误报成「脚本没跑」。
 *
 * 用法：node scripts/verify-iframe.mjs
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

const wait = ms => new Promise(done => setTimeout(done, ms))

/** 让系统分配一个空闲端口，避免固定端口撞上本机其它进程 */
function findFreePort() {
  return new Promise((done, fail) => {
    const server = createServer()
    server.unref()
    server.on('error', fail)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => done(port))
    })
  })
}

/* ---------------------------------------------------------------- 内容根 */

/** 造一个最小内容根：一篇 md + 一个自包含 html */
function seedContentRoot() {
  const root = mkdtempSync(join(tmpdir(), 'docvi-iframe-'))
  const ws = join(root, 'ws')
  mkdirSync(ws, { recursive: true })

  writeFileSync(
    join(ws, 'docs.config.yaml'),
    'title: iframe 验证\nsidebar:\n  - text: 首页\n    path: index.md\n',
    'utf8',
  )

  writeFileSync(
    join(ws, 'index.md'),
    [
      '# iframe 验证',
      '',
      '下面内嵌一个本地 html，它会在加载后 postMessage 回传。',
      '',
      '<iframe src="./demo.html" sandbox="allow-scripts" height="200"></iframe>',
      '',
    ].join('\n'),
    'utf8',
  )

  writeFileSync(
    join(ws, 'demo.html'),
    [
      '<!doctype html>',
      '<html><head><meta charset="utf-8"><title>demo</title></head><body>',
      '<div id="box">iframe loaded</div>',
      '<script>',
      "  parent.postMessage({ type: 'iframe-ready', from: 'load', stamp: Date.now() }, '*');",
      "  window.addEventListener('message', event => {",
      "    if (!event.data || event.data.type !== 'ping') return;",
      "    parent.postMessage({ type: 'iframe-ready', from: 'pong', stamp: Date.now() }, '*');",
      '  });',
      '</script>',
      '</body></html>',
    ].join('\n'),
    'utf8',
  )

  return { root, ws }
}

/* ---------------------------------------------------------------- CDP */

function connect(url) {
  const socket = new WebSocket(url)
  let nextId = 0
  const pending = new Map()
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    const call = pending.get(message.id)
    if (!call) return
    pending.delete(message.id)
    call(message)
  })
  const opened = new Promise((done, fail) => {
    socket.addEventListener('open', () => done())
    socket.addEventListener('error', () => fail(new Error('CDP 连接失败')))
  })
  return opened.then(() => ({
    send(method, params = {}) {
      const id = ++nextId
      socket.send(JSON.stringify({ id, method, params }))
      return new Promise((done, fail) => {
        pending.set(id, message => {
          if (message.error) fail(new Error(message.error.message))
          else done(message.result)
        })
        setTimeout(() => fail(new Error(`CDP 超时：${method}`)), 15000)
      })
    },
    close() {
      socket.close()
    },
  }))
}

/** 在页面里求值并取回 JSON 结果 */
async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  return result?.result?.value
}

/* ---------------------------------------------------------------- 主流程 */

const { root, ws } = seedContentRoot()
const dataDir = mkdtempSync(join(tmpdir(), 'docvi-iframe-data-'))
const port = await findFreePort()
let child = null
let client = null

try {
  child = spawn(ELECTRON, [APP_DIR, '--no-sandbox', `--workspace=${ws}`], {
    env: {
      ...process.env,
      DOCVI_HEADLESS: '1',
      DOCVI_DATA_DIR: dataDir,
      DOCVI_INSTANCE: 'docvi-iframe-verify',
      DOCVI_DEBUG_PORT: String(port),
    },
    stdio: 'ignore',
  })

  // 等调试端口开出来
  let target = null
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await wait(300)
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      target = list.find(item => item.type === 'page' && item.url.includes('index.html'))
      if (target) break
    } catch {
      // 端口还没开
    }
  }
  if (!target) throw new Error('应用没有在预期时间内打开调试端口')

  client = await connect(target.webSocketDebuggerUrl)
  await client.send('Runtime.enable')

  // 打开内容根：走一次 addWorkspace 会让树/文档就位
  console.log('[step] 打开内容根…')
  const opened = await evaluate(
    client,
    `(async () => {
      const ws = ${JSON.stringify(ws)}
      const added = await window.docvi.workspaceAddAt(ws)
      if (!added.ok) return { error: JSON.stringify(added) }
      return { ok: true, id: added.data?.id ?? null }
    })()`,
  )
  if (!opened?.ok) throw new Error(`打开内容根失败：${opened?.error ?? '未知'}`)

  /*
   * 走界面路径打开：文档库 → 工作区卡片 → 进标签 → 点树根节点（落地页 index.md）。
   *
   * 不能只调 IPC：`docRead` 只返回内容、不驱动界面渲染，iframe 永远不会出现。
   * 端到端验证要的正是「用户点开文档后看到什么」。
   */
  console.log('[step] 点卡片与树…')
  const shown = await evaluate(
    client,
    `(async () => {
      // 1) 回文档库（标签栏第一个是库标签）
      const lib = document.querySelector('.tab--library')
      if (lib) { lib.click(); await new Promise(r => setTimeout(r, 300)) }

      // 2) 点工作区卡片进标签
      for (let i = 0; i < 60; i += 1) {
        const card = document.querySelector('.library .card')
        if (card) { card.click(); break }
        await new Promise(r => setTimeout(r, 200))
      }

      // 3) 点文档树的根节点（其 landing 就是 index.md）。
      //
      // ⚠️ 必须限定在 .tree 容器里：侧栏顶部的工作区列表也是 role="treeitem"，
      // 而且排在文档树之前——不限定就会点到工作区行（那只是切换工作区，
      // 正文不会打开任何文档），读数表现为「正文里没有 iframe」。
      for (let i = 0; i < 60; i += 1) {
        const row = document.querySelector('.tree [role="treeitem"]')
        if (row) { row.click(); return { ok: true } }
        await new Promise(r => setTimeout(r, 200))
      }
      return { ok: false, reason: '树里没有任何节点' }
    })()`,
  )
  if (!shown?.ok) throw new Error('打开文档失败：' + (shown?.reason ?? '未知'))

  /*
   * 两路证据：
   *  1. iframe 元素存在且 src 已指向 docvi://asset/…
   *  2. 子文档脚本回传消息（说明 html 真的加载并执行了）
   *
   * 监听在找元素**之前**挂：子文档可能早于探针就开始跑脚本了，而握手
   * （ping/pong）保证即使首次广播错过，重发一次也能拿到回执。
   */
  console.log('[step] 等待 iframe…')
  const probe = await evaluate(
    client,
    `(async () => {
      const inbox = []
      window.addEventListener('message', event => {
        if (event.data && event.data.type === 'iframe-ready') inbox.push(event.data)
      })

      let frame = null
      for (let i = 0; i < 80; i += 1) {
        frame = document.querySelector('.at-doc iframe')
        if (frame) break
        await new Promise(r => setTimeout(r, 150))
      }
      if (!frame) {
        return { ok: false, reason: '正文里没有 iframe 元素', html: document.querySelector('.at-doc')?.innerHTML?.slice(0, 300) ?? null }
      }

      // 补握手：上一次广播可能发生在监听挂上之前
      for (let i = 0; i < 20 && inbox.length === 0; i += 1) {
        try {
          frame.contentWindow?.postMessage({ type: 'ping' }, '*')
        } catch {
          // contentWindow 还没就绪，下一轮再试
        }
        await new Promise(r => setTimeout(r, 200))
      }

      return {
        ok: inbox.length > 0,
        src: frame.getAttribute('src'),
        sandbox: frame.getAttribute('sandbox'),
        ready: inbox[0] ?? null,
        reason: inbox.length ? null : 'iframe 在但脚本没回传（sandbox 限制或 html 未加载）',
      }
    })()`,
  )

  if (probe?.ok) {
    console.log('✓ iframe 内嵌本地 html 验证通过')
    console.log(`  src:   ${probe.src}`)
    console.log(`  回传:  ${JSON.stringify(probe.ready)}`)
    process.exitCode = 0
  } else {
    console.error('✗ iframe 验证失败')
    console.error(`  原因: ${probe?.reason ?? '未知'}`)
    console.error(`  src:   ${probe?.src ?? '(无)'}`)
    if (probe?.sandbox !== undefined) console.error(`  sandbox: ${probe.sandbox}`)
    if (probe?.html) console.error(`  正文片段: ${probe.html}`)
    process.exitCode = 1
  }
} catch (error) {
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
} finally {
  client?.close()
  if (child) {
    child.kill()
    await wait(500)
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 })
}
