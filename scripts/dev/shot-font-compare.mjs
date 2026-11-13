#!/usr/bin/env node
/**
 * 字体视觉对照截图：同一页同一处，分别在鸿蒙与系统字体下各截一张。
 *
 * 探针能证明「宽度不同、字体已加载」，但证明不了「看起来是鸿蒙」——字形差异
 * 只能靠眼睛。这个脚本产出一组对照图给人看。
 *
 * 用法：node scripts/dev/shot-font-compare.mjs  （需先 pnpm docvi:build）
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
const TAG = `fc${Date.now().toString(36)}`
const PORT = 9700 + Math.floor(Math.random() * 90)
const DATA = mkdtempSync(join(tmpdir(), `docvi-fc-data-${TAG}-`))
const WS = mkdtempSync(join(tmpdir(), `docvi-fc-ws-${TAG}-`))
const OUT = join(ROOT, '.temp/font-compare')
mkdirSync(OUT, { recursive: true })

const DOC = `# 字体对照样例

中文字形对照：**永字八法**、字体设计、渲染引擎、粗细对比。

Latin sample: The quick brown fox jumps over the lazy dog 0123456789

## 代码块（等宽）

\`\`\`text
┌ 应用包 apps/* ─────────────┐
│ console 平台外壳·路由装配  │
└────────────────────────────┘
\`\`\`

\`\`\`ts
const message = '中文与 ASCII 混排对齐'
interface FontFamily { id: 'harmony' | 'system' }
\`\`\`

| 列一 | 列二 | 列三 |
| --- | --- | --- |
| 鸿蒙黑体 | HarmonyOS Sans | 400/500/700 |
| 系统字体 | Segoe UI | 回退微软雅黑 |
`

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
  for (const dir of [DATA, WS]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
    } catch {
      // 忽略
    }
  }
}

async function main() {
  writeFileSync(join(WS, '字体对照.md'), DOC, 'utf8')

  child = spawn(ELECTRON, [APP_DIR, '--no-sandbox'], {
    env: {
      ...process.env,
      DOCVI_HEADLESS: '1',
      DOCVI_DATA_DIR: DATA,
      DOCVI_INSTANCE: `docvi-fc-${TAG}`,
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
  await sleep(3500)
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: 1100,
    height: 1000,
    deviceScaleFactor: 2,
    mobile: false,
  })

  const added = await client.evaluate(
    `window.docvi.workspaceAddAt(${JSON.stringify(WS)}).then(r => r)`,
  )
  if (!added?.ok) throw new Error(`登记工作区失败：${JSON.stringify(added)}`)

  await client.evaluate('location.reload()')
  await sleep(3200)
  await client.evaluate(`(() => {
    [...document.querySelectorAll('.card')]
      .find(el => (el.textContent || '').includes(${JSON.stringify(WS)}))?.click()
  })()`)
  await sleep(2500)
  await client.evaluate(`(() => {
    [...document.querySelectorAll('[data-tree-path]')]
      .find(el => (el.dataset.treePath || '').endsWith('字体对照.md'))?.click()
  })()`)
  await sleep(4500)

  async function shoot(name) {
    const data = await client.send('Page.captureScreenshot', { format: 'png' })
    const file = join(OUT, `${name}.png`)
    writeFileSync(file, Buffer.from(data.data, 'base64'))
    log(`已存 ${file}`)
  }

  // 鸿蒙（默认态，无 data-font 属性）
  await shoot('1-harmony')

  // 切到系统字体
  await client.evaluate(`document.documentElement.dataset.font = 'system'`)
  await sleep(600)
  await shoot('2-system')

  // 再切回来，确认可以往返
  await client.evaluate(`delete document.documentElement.dataset.font`)
  await sleep(600)
  await shoot('3-harmony-again')

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
