#!/usr/bin/env node
/**
 * 用用户实际那篇文档验证单文件图片链路（只读：不改用户的任何文件）。
 *
 * 打开 `临时文件夹/前端功能文档-数据货架/数据货架-前端功能文档.md`，
 * 断言 17 张相对路径图片全部解码成功，并截图存证。
 *
 * 用法：node scripts/dev/probe-user-doc-images.mjs   （需先 pnpm docvi:build）
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const ELECTRON = join(ROOT, 'apps/desktop/node_modules/electron/dist/electron.exe')
const APP_DIR = join(ROOT, 'apps/desktop')
const TAG = `probe${Date.now().toString(36)}`
const PORT = 9900 + Math.floor(Math.random() * 90)
const DATA = mkdtempSync(join(tmpdir(), `docvi-probe-data-${TAG}-`))
const DOC =
  'C:\\Fanki\\Notes\\fanki-lib\\临时文件夹\\前端功能文档-数据货架\\数据货架-前端功能文档.md'

let child = null
const log = (...args) => console.log('[probe]', ...args)

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
    // 收尾失败不影响结论
  }
}

async function main() {
  if (!existsSync(DOC)) throw new Error(`文档不存在：${DOC}`)

  child = spawn(ELECTRON, [APP_DIR, DOC, '--no-sandbox'], {
    env: {
      ...process.env,
      DOCVI_HEADLESS: '1',
      DOCVI_DATA_DIR: DATA,
      DOCVI_INSTANCE: `docvi-probe-${TAG}`,
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
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await client.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await sleep(4000)

  const report = await client.evaluate(`(() => {
    const imgs = [...document.querySelectorAll('.at-doc img')]
    const broken = imgs.filter(img => !(img.complete && img.naturalWidth > 0))
    /*
     * 检查「磁盘路径是否进了 URL」。只看 pathname：协议头里的 \`docvi:\` 也长得像
     * 盘符（\`i:/\`），直接对整串做正则会把正常 URL 判成泄漏。
     */
    const leaks = imgs.filter(img => {
      const src = img.getAttribute('src') || ''
      const rest = src.replace(/^[a-z][a-z0-9+.-]*:\\/\\//i, '')
      return /^[A-Za-z]:[\\\\/]/.test(rest) || rest.includes(':/')
    })
    return {
      total: imgs.length,
      broken: broken.length,
      brokenSrc: broken.slice(0, 5).map(img => img.getAttribute('src')),
      sampleSrc: imgs[0]?.getAttribute('src') ?? null,
      leaked: leaks.map(img => img.getAttribute('src')).slice(0, 3),
      title: document.querySelector('.reader__crumb-item:last-child')?.textContent?.trim() ?? null,
    }
  })()`)
  log('图片检查：', JSON.stringify(report))

  if (report.total === 0) throw new Error('页面里没有图片元素（文档没打开？）')
  if (report.broken > 0) throw new Error(`${report.broken}/${report.total} 张图片加载失败`)
  if (report.leaked.length) {
    throw new Error(`图片 src 里泄漏了磁盘路径：${JSON.stringify(report.leaked)}`)
  }

  // 截图：滚到有图的区域
  await client.evaluate(`(() => {
    const first = document.querySelector('.at-doc img')
    first?.scrollIntoView({ block: 'center' })
  })()`)
  await sleep(1200)
  const shot = await client.send('Page.captureScreenshot', { format: 'png' })
  mkdirSync(join(ROOT, '.temp'), { recursive: true })
  const out = join(ROOT, '.temp', 'user-doc-images.png')
  writeFileSync(out, Buffer.from(shot.data, 'base64'))
  log('截图：', out)

  log(`通过：${report.total} 张图片全部正常`)
  client.close()
}

main()
  .then(() => {
    cleanup()
    process.exit(0)
  })
  .catch(error => {
    console.error('[probe] 失败：', error.message)
    cleanup()
    process.exit(1)
  })
