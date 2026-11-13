#!/usr/bin/env node
/**
 * 最苛刻的时序：滚完**立刻**切标签，赶在 200ms 节流与 600ms 防抖之前。
 *
 * 这是「持续上报」与「切走前补一刀」的交接点：如果 flushScroll 没生效，
 * 最后那段滚动会丢；如果 setScroll 之后没有落盘机会，重启后也会丢。
 * 两种丢失都表现为「回来位置不对」。
 *
 * 用法：node scripts/dev/probe-scroll-race.mjs
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const ELECTRON = join(ROOT, 'apps/desktop/node_modules/electron/dist/electron.exe')
const APP_DIR = join(ROOT, 'apps/desktop')
const TAG = `rc${Date.now().toString(36)}`
const PORT = 9500 + Math.floor(Math.random() * 40)
const DATA = mkdtempSync(join(tmpdir(), `docvi-rc-data-${TAG}-`))
const WS = mkdtempSync(join(tmpdir(), `docvi-rc-ws-${TAG}-`))

const DOC = `# 竞态验证

${Array.from(
  { length: 40 },
  (_, index) => `## 第 ${index + 1} 节

第 ${index + 1} 节的正文，撑长度用。

- 条目 A${index + 1}
`,
).join('\n')}
`

let child = null
const log = (...args) => console.log('[race]', ...args)

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

async function main() {
  writeFileSync(join(WS, '竞态验证.md'), DOC, 'utf8')

  child = spawn(ELECTRON, [APP_DIR, '--no-sandbox'], {
    env: {
      ...process.env,
      DOCVI_HEADLESS: '1',
      DOCVI_DATA_DIR: DATA,
      DOCVI_INSTANCE: `docvi-rc-${TAG}`,
      DOCVI_DEBUG_PORT: String(PORT),
    },
    stdio: 'ignore',
    detached: process.platform !== 'win32',
  })

  let target = null
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await sleep(300)
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      target = list.find(item => item.type === 'page' && item.url.includes('index.html'))
      if (target) break
    } catch {
      // 端口还没开
    }
  }
  if (!target) throw new Error('应用窗口没有出现')

  const client = await connect(target.webSocketDebuggerUrl)
  await sleep(3500)
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: 1100,
    height: 700,
    deviceScaleFactor: 1,
    mobile: false,
  })
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
      .find(el => (el.dataset.treePath || '').endsWith('竞态验证.md'))?.click()
  })()`)
  await sleep(4500)

  /*
   * 滚动与切标签放在**同一个**页面脚本里，中间不 await、不给定时器机会。
   *
   * 上一版诊断里两步之间有 CDP 往返（几十毫秒）＋ sleep，节流和防抖都有机会
   * 跑完，于是掩盖了「最后一段滚动没 flush」的问题。这里要的就是最坏时序。
   */
  const verdict = await client.evaluate(`(async () => {
    const reader = document.querySelector('.reader')
    const surface = document.querySelector('.at-doc')
    if (!reader || !surface) return { error: 'no reader' }

    const range = reader.scrollHeight - reader.clientHeight
    reader.scrollTop = Math.round(range * 0.62)

    const readLine = () => {
      const base = reader.getBoundingClientRect().top
      let best = null
      for (const block of surface.querySelectorAll('[data-source-line]')) {
        if (block.getBoundingClientRect().top - base <= 2) best = Number(block.dataset.sourceLine)
      }
      return best
    }
    const lineBefore = readLine()

    /* 同一帧内点设置按钮：节流定时器还没到，只能靠 flushScroll */
    const btn = [...document.querySelectorAll('button')]
      .find(b => (b.getAttribute('aria-label') || '').includes('设置'))
    btn.click()

    return { lineBefore, scrollBefore: Math.round(reader.scrollTop) }
  })()`)
  log('滚完立刻切走:', JSON.stringify(verdict))
  if (verdict?.error) throw new Error(verdict.error)

  await sleep(2000)
  await client.evaluate(`(() => {
    const tabs = [...document.querySelectorAll('.tab')]
    tabs.find(el => (el.textContent || '').includes('竞态验证'))?.click()
  })()`)
  await sleep(4000)

  const lineAfter = await client.evaluate(TOP_LINE)
  log(`切回后顶部源行=${lineAfter}`)

  const ok = lineAfter !== null && Math.abs(lineAfter - verdict.lineBefore) <= 8
  if (ok) {
    log(`✓ 最坏时序下位置仍保住（源行 ${verdict.lineBefore} → ${lineAfter}）`)
  } else {
    log(`❗ 最坏时序下位置丢失（源行 ${verdict.lineBefore} → ${lineAfter}）`)
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
