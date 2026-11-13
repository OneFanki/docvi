#!/usr/bin/env node
/** 导出成功后提示条的截图（含「打开所在文件夹」按钮） */
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const ELECTRON = join(ROOT, 'apps/desktop/node_modules/electron/dist/electron.exe')
const APP_DIR = join(ROOT, 'apps/desktop')
const TAG = `nt${Date.now().toString(36)}`
const PORT = 9500 + Math.floor(Math.random() * 90)
const DATA = mkdtempSync(join(tmpdir(), `docvi-nt-data-${TAG}-`))
const WS = mkdtempSync(join(tmpdir(), `docvi-nt-ws-${TAG}-`))
const EXPORT_DIR = mkdtempSync(join(tmpdir(), `docvi-nt-out-${TAG}-`))
const OUT = join(ROOT, '.temp/export-shots')
mkdirSync(OUT, { recursive: true })

let child = null
const log = (...args) => console.log('[notice]', ...args)

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
  for (const dir of [DATA, WS, EXPORT_DIR]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
    } catch {
      // 忽略
    }
  }
}

async function main() {
  writeFileSync(join(WS, '提示条验证.md'), '# 提示条验证\n\n正文内容。\n', 'utf8')

  child = spawn(ELECTRON, [APP_DIR, '--no-sandbox'], {
    env: {
      ...process.env,
      DOCVI_HEADLESS: '1',
      DOCVI_DATA_DIR: DATA,
      DOCVI_INSTANCE: `docvi-nt-${TAG}`,
      DOCVI_DEBUG_PORT: String(PORT),
      DOCVI_EXPORT_DIR: EXPORT_DIR,
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
  if (!target) throw new Error('应用窗口没有出现（CDP 不可达）')

  const client = await connect(target.webSocketDebuggerUrl)
  await sleep(3500)
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: 1100,
    height: 760,
    deviceScaleFactor: 2,
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
      .find(el => (el.dataset.treePath || '').endsWith('提示条验证.md'))?.click()
  })()`)
  await sleep(3500)

  // 触发导出（PDF）
  await client.evaluate(`(async () => {
    const btn = [...document.querySelectorAll('.reader__meta button')]
      .find(b => (b.getAttribute('aria-label') || '').includes('导出'))
    btn?.click()
    await new Promise(r => setTimeout(r, 400))
    const item = [...document.querySelectorAll('.menu__item')]
      .find(el => (el.textContent || '').includes('PDF'))
    item?.click()
    await new Promise(r => setTimeout(r, 2000))
  })()`)

  const data = await client.send('Page.captureScreenshot', { format: 'png' })
  const file = join(OUT, 'notice-with-action.png')
  writeFileSync(file, Buffer.from(data.data, 'base64'))
  log('已存', file)
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
