#!/usr/bin/env node
/**
 * 复现用户报的场景：**旧会话文件**下的切标签回顶。
 *
 * 我在此之前的所有诊断都用全新的临时数据目录，因此会话文件是空的，
 * `topLine` 由新代码写入正确值——测不出来。
 *
 * 用户机器上早就有 session.json，里面是我上一版写进去的 `topLine: 0`。
 * 加载后 `scrollToSourceLine(0)` 会把文档滚到顶部**并返回 true**，
 * 于是压住了像素兜底，表现就是「切标签回顶」。
 *
 * 这个脚本故意构造那份旧文件，验证修复是否真的覆盖它。
 *
 * 用法：node scripts/dev/probe-stale-session.mjs
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const ELECTRON = join(ROOT, 'apps/desktop/node_modules/electron/dist/electron.exe')
const APP_DIR = join(ROOT, 'apps/desktop')
const TAG = `ss${Date.now().toString(36)}`
const PORT = 9450 + Math.floor(Math.random() * 40)
const DATA = mkdtempSync(join(tmpdir(), `docvi-ss-data-${TAG}-`))
const WS = mkdtempSync(join(tmpdir(), `docvi-ss-ws-${TAG}-`))

const DOC = `# 旧会话验证

${Array.from(
  { length: 40 },
  (_, index) => `## 第 ${index + 1} 节

第 ${index + 1} 节的正文，用来把文档撑长。

- 列表 A${index + 1}
`,
).join('\n')}
`

let child = null
const log = (...args) => console.log('[stale]', ...args)

function connect(url) {
  const socket = new WebSocket(url)
  let nextId = 0
  const pending = new Map()
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    const call = pending.get(message.id)
    if (!call) return
    pending.delete(message.id)
    call(message.result ?? message.error)
  })
  return new Promise((done, fail) => {
    socket.addEventListener('open', done, { once: true })
    socket.addEventListener('error', () => fail(new Error('CDP 连接失败')), { once: true })
  }).then(() => ({
    send(method, params = {}) {
      return new Promise(done => {
        const id = ++nextId
        pending.set(id, message => done(message))
        socket.send(JSON.stringify({ id, method, params }))
      })
    },
    async evaluate(expression) {
      const result = await this.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      })
      if (result?.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description ?? '页面脚本报错')
      }
      return result?.result?.value
    },
    close() {
      socket.close()
    },
  }))
}

function cleanup() {
  if (child) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    child = null
  }
  for (const dir of [DATA, WS]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
    } catch {
      // 忽略
    }
  }
}

const TOP_LINE = `(() => {
  const el = document.querySelector('.reader')
  const surface = document.querySelector('.at-doc')
  if (!el || !surface) return null
  const base = el.getBoundingClientRect().top
  let best = null
  for (const block of surface.querySelectorAll('[data-source-line]')) {
    if (block.getBoundingClientRect().top - base <= 2) best = Number(block.dataset.sourceLine)
  }
  return best
})()`

async function boot(port, tag) {
  const proc = spawn(ELECTRON, [APP_DIR, '--no-sandbox'], {
    env: {
      ...process.env,
      DOCVI_HEADLESS: '1',
      DOCVI_DATA_DIR: DATA,
      DOCVI_INSTANCE: `docvi-ss-${tag}`,
      DOCVI_DEBUG_PORT: String(port),
    },
    stdio: 'ignore',
    detached: process.platform !== 'win32',
  })
  let target = null
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await sleep(300)
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      target = list.find(item => item.type === 'page' && item.url.includes('index.html'))
      if (target) break
    } catch {
      // 端口还没开
    }
  }
  if (!target) throw new Error('应用窗口没有出现')
  return { proc, client: await connect(target.webSocketDebuggerUrl) }
}

async function main() {
  writeFileSync(join(WS, '旧会话验证.md'), DOC, 'utf8')

  /* ---------- 第一轮：建会话，滚到中部，让它写盘 ---------- */
  let { proc, client } = await boot(PORT, `${TAG}a`)
  child = proc
  await sleep(3500)
  await client.evaluate(`window.docvi.workspaceAddAt(${JSON.stringify(WS)}).then(r => r)`)
  await client.evaluate('location.reload()')
  await sleep(3200)
  await client.evaluate(`(() => {
    [...document.querySelectorAll('.card')]
      .find(el => (el.textContent || '').includes(${JSON.stringify(WS)}))?.click()
  })()`)
  await sleep(2200)
  await client.evaluate(`(() => {
    [...document.querySelectorAll('[data-tree-path]')]
      .find(el => (el.dataset.treePath || '').endsWith('旧会话验证.md'))?.click()
  })()`)
  await sleep(4500)

  const scrolled = await client.evaluate(`(() => {
    const el = document.querySelector('.reader')
    const range = el.scrollHeight - el.clientHeight
    el.scrollTop = Math.round(range * 0.5)
    return Math.round(el.scrollTop)
  })()`)
  await sleep(1200)

  /* 关掉应用，让 session.json 落定 */
  client.close()
  spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' })
  child = null
  await sleep(1500)

  const sessionFile = join(DATA, 'session.json')
  if (!existsSync(sessionFile)) throw new Error('没写出 session.json')
  const session = JSON.parse(readFileSync(sessionFile, 'utf8'))
  log(
    `第一轮滚到 ${scrolled}，会话里 topLine=${JSON.stringify(session.tabs?.flatMap(t => (t.history ?? []).map(d => d.topLine)))}`,
  )

  /*
   * 模拟用户机器上的**旧会话**：把 topLine 抹成 0。
   *
   * 上一版代码把「没有源行信息」也存成 0，两者无法区分。加载后
   * scrollToSourceLine(0) 会滚到顶部并返回 true，压住像素兜底。
   */
  for (const tab of session.tabs ?? []) {
    for (const doc of tab.history ?? []) doc.topLine = 0
  }
  writeFileSync(sessionFile, `${JSON.stringify(session, null, 2)}\n`, 'utf8')
  log('已把会话改成旧格式（topLine 全为 0）')

  /* ---------- 第二轮：带旧会话启动 ---------- */
  const second = await boot(PORT + 1, `${TAG}b`)
  child = second.proc
  client = second.client
  await sleep(5000)

  const restored = await client.evaluate(
    '(() => ({ hasReader: Boolean(document.querySelector(".reader")) }))()',
  )
  log('第二轮启动后:', JSON.stringify(restored))
  if (!restored.hasReader) {
    log('❗ 旧会话没能恢复到阅读视图，用例不成立')
    process.exitCode = 1
    return
  }

  const lineBefore = await client.evaluate(TOP_LINE)
  const topBefore = await client.evaluate(
    '(() => { const el = document.querySelector(".reader"); return el ? Math.round(el.scrollTop) : null })()',
  )
  log(`恢复后 scrollTop=${topBefore}，顶部源行=${lineBefore}`)

  /* 切到设置再切回 */
  await client.evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')]
      .find(b => (b.getAttribute('aria-label') || '').includes('设置'))
    btn?.click()
  })()`)
  await sleep(2000)
  await client.evaluate(`(() => {
    const tabs = [...document.querySelectorAll('.tab')]
    tabs.find(el => (el.textContent || '').includes('旧会话验证'))?.click()
  })()`)
  await sleep(4000)

  const lineAfter = await client.evaluate(TOP_LINE)
  const topAfter = await client.evaluate(
    '(() => { const el = document.querySelector(".reader"); return el ? Math.round(el.scrollTop) : null })()',
  )
  log(`切回后 scrollTop=${topAfter}，顶部源行=${lineAfter}`)

  const ok = lineAfter !== null && lineAfter > 5
  if (ok) {
    log(`✓ 旧会话下位置也保住了（源行 ${lineBefore} → ${lineAfter}）`)
  } else {
    log(`❗ 旧会话下仍然回顶（源行 ${lineBefore} → ${lineAfter}）`)
    process.exitCode = 1
  }

  client.close()
}

main()
  .catch(error => {
    log('失败:', error.message)
    process.exitCode = 1
  })
  .finally(async () => {
    cleanup()
  })
