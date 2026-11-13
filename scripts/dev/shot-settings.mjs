#!/usr/bin/env node
/**
 * 设置页外观分区的截图，用于人工确认「说明文本已收敛」。
 *
 * 只做一件事：打开设置 → 外观，截图存到 .temp/。清理类改动的验收靠眼睛，
 * 断言只能证明文案键没了，证不了界面上是否还挤着别的东西。
 *
 * 用法：node scripts/dev/shot-settings.mjs  （需先 pnpm docvi:build）
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const ELECTRON = join(ROOT, 'apps/desktop/node_modules/electron/dist/electron.exe')
const APP_DIR = join(ROOT, 'apps/desktop')
const TAG = `st${Date.now().toString(36)}`
const PORT = 9800 + Math.floor(Math.random() * 90)
const DATA = mkdtempSync(join(tmpdir(), `docvi-st-data-${TAG}-`))
const OUT = join(ROOT, '.temp/settings-shots')
mkdirSync(OUT, { recursive: true })

let child = null
const log = (...args) => console.log('[shot]', ...args)

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
  return new Promise((done, fail) => {
    socket.addEventListener('open', done, { once: true })
    socket.addEventListener('error', () => fail(new Error('CDP 连接失败')), { once: true })
  }).then(() => ({
    send(method, params = {}) {
      return new Promise(done => {
        const id = ++nextId
        pending.set(id, message => done(message.result))
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
  try {
    rmSync(DATA, { recursive: true, force: true, maxRetries: 5 })
  } catch {
    // 忽略
  }
}

async function main() {
  child = spawn(ELECTRON, [APP_DIR, '--no-sandbox'], {
    env: {
      ...process.env,
      DOCVI_HEADLESS: '1',
      DOCVI_DATA_DIR: DATA,
      DOCVI_INSTANCE: `docvi-st-${TAG}`,
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
  if (!target) throw new Error('应用窗口没有出现（CDP 不可达）')

  const client = await connect(target.webSocketDebuggerUrl)
  await sleep(4000)
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: 1180,
    height: 900,
    deviceScaleFactor: 2,
    mobile: false,
  })

  // 打开设置页：命令面板 → 设置
  await client.evaluate(`(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'k', ctrlKey: true, bubbles: true, cancelable: true,
    }))
  })()`)
  await sleep(700)
  await client.evaluate(`(() => {
    const input = document.querySelector('.palette__input')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, '设置')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await sleep(700)
  await client.evaluate(`(() => {
    // 必须精确匹配「打开设置」：搜「设置」会先命中「标签页设置」，那是另一个页面
    const item = [...document.querySelectorAll('.palette__item-title')]
      .find(el => (el.textContent || '').trim() === '打开设置')
    item?.closest('.palette__item')?.click()
  })()`)
  await sleep(1800)

  async function shoot(name) {
    const data = await client.send('Page.captureScreenshot', { format: 'png' })
    const file = join(OUT, `${name}.png`)
    writeFileSync(file, Buffer.from(data.data, 'base64'))
    log(`已存 ${file}`)
  }

  await shoot('appearance')
  log('输出目录:', OUT)
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
