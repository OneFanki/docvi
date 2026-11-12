#!/usr/bin/env node
/**
 * 一次性探针：灯箱里「按住拖动画布」会不会把灯箱关掉。
 *
 * 用户报「拖拽画布，连续两次比较快，会被判断成双击然后关掉」。
 * 双击本身没有监听，真正可疑的是：拖拽结束后浏览器仍会补发一次 `click`，
 * 而 viewport 上有 `@click.self="close"` —— 位移落在空白处时就会命中。
 *
 * 这里用 CDP 真实派发 pointerdown → pointermove×N → pointerup → click，
 * 复现用户手势，并对比「原地点击」与「拖拽后松手」两种结果。
 *
 * 用法：node scripts/dev/probe-lightbox-drag.mjs  （需先 pnpm docvi:build）
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
const TAG = `lb${Date.now().toString(36)}`
const PORT = 9700 + Math.floor(Math.random() * 90)
const DATA = mkdtempSync(join(tmpdir(), `docvi-lbd-data-${TAG}-`))
const WS = mkdtempSync(join(tmpdir(), `docvi-lbd-ws-${TAG}-`))
const DOC = join(WS, '拖拽探针.md')

const DOC_TEXT = `# 拖拽探针

\`\`\`mermaid
flowchart TD
  A[入口] --> B{判断}
  B -->|通过| C[完成]
  B -->|失败| D[回退]
\`\`\`
`

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
    async mouse(type, x, y, extra = {}) {
      await this.send('Input.dispatchMouseEvent', {
        type,
        x,
        y,
        button: 'left',
        buttons: type === 'mouseReleased' ? 0 : 1,
        clickCount: 1,
        ...extra,
      })
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

const LIGHTBOX_OPEN = `!!document.querySelector('.lightbox')`

/** 用 CDP 真实鼠标事件做一次拖拽（带中间移动帧，模拟人手） */
async function drag(client, from, to, steps = 6) {
  await client.mouse('mousePressed', from.x, from.y)
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps
    await client.mouse('mouseMoved', from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t)
    await sleep(30)
  }
  await client.mouse('mouseReleased', to.x, to.y)
  // 浏览器会在 pointerup 后补发 click，等一下让它落地
  await sleep(400)
}

async function main() {
  mkdirSync(WS, { recursive: true })
  writeFileSync(DOC, DOC_TEXT, 'utf8')

  child = spawn(ELECTRON, [APP_DIR, '--no-sandbox'], {
    env: {
      ...process.env,
      DOCVI_HEADLESS: '1',
      DOCVI_DATA_DIR: DATA,
      DOCVI_INSTANCE: `docvi-lbd-${TAG}`,
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
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  })

  const added = await client.evaluate(
    `window.docvi.workspaceAddAt(${JSON.stringify(WS)}).then(r => r)`,
  )
  if (!added?.ok) throw new Error(`登记工作区失败：${JSON.stringify(added)}`)

  await client.evaluate('location.reload()')
  await sleep(3200)
  await client.evaluate(`(() => {
    const cards = [...document.querySelectorAll('.card')]
    cards.find(el => (el.textContent || '').includes(${JSON.stringify(WS)}))?.click()
  })()`)
  await sleep(3000)
  await client.evaluate(`(() => {
    const row = [...document.querySelectorAll('[data-tree-path]')]
      .find(el => (el.dataset.treePath || '').endsWith('拖拽探针.md'))
    row?.click()
  })()`)
  await sleep(3500)

  await client.evaluate(`document.querySelector('.at-mermaid__expand')?.click()`)
  await sleep(1500)
  log('灯箱已打开:', await client.evaluate(LIGHTBOX_OPEN))

  // 量出 viewport 的可拖拽空白区域（左上角一带通常是空白）
  const box = await client.evaluate(`(() => {
    const vp = document.querySelector('.lightbox__viewport')
    if (!vp) return null
    const r = vp.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height }
  })()`)
  log('viewport:', JSON.stringify(box))
  if (!box) throw new Error('没有 viewport')

  // 找一个确定落在空白（.lightbox__viewport 自身）上的点
  const blank = await client.evaluate(`(() => {
    const vp = document.querySelector('.lightbox__viewport')
    const r = vp.getBoundingClientRect()
    const candidates = [
      [r.left + 24, r.top + r.height - 24],
      [r.left + 24, r.top + 60],
      [r.right - 24, r.bottom - 24],
    ]
    for (const [x, y] of candidates) {
      const el = document.elementFromPoint(x, y)
      if (el && el.classList.contains('lightbox__viewport')) return { x, y }
    }
    return null
  })()`)
  log('空白点:', JSON.stringify(blank))

  if (!blank) throw new Error('找不到落在 viewport 空白处的点')

  // 场景 1：原地点击空白（基线：这本来就该关闭）
  await client.evaluate(`document.querySelector('.lightbox__btn--close')?.click()`)
  await sleep(400)
  await client.evaluate(`document.querySelector('.at-mermaid__expand')?.click()`)
  await sleep(1200)
  const beforeClick = await client.evaluate(LIGHTBOX_OPEN)
  await client.mouse('mousePressed', blank.x, blank.y)
  await client.mouse('mouseReleased', blank.x, blank.y)
  await sleep(500)
  const afterClick = await client.evaluate(LIGHTBOX_OPEN)
  log(`1 原地点击空白：打开=${beforeClick} → 点击后=${afterClick}`)

  // 场景 2：拖拽后松手（用户报的路径）
  await client.evaluate(`document.querySelector('.at-mermaid__expand')?.click()`)
  await sleep(1200)
  const beforeDrag = await client.evaluate(LIGHTBOX_OPEN)
  await drag(client, blank, { x: blank.x + 90, y: blank.y - 60 })
  const afterDrag = await client.evaluate(LIGHTBOX_OPEN)
  log(`2 拖拽后松手：打开=${beforeDrag} → 拖拽后=${afterDrag}`)

  // 场景 3：快速两次拖拽（约等于用户说的「连续两次比较快」）
  await client.evaluate(`document.querySelector('.at-mermaid__expand')?.click()`)
  await sleep(1200)
  const beforeDouble = await client.evaluate(LIGHTBOX_OPEN)
  await drag(client, blank, { x: blank.x + 60, y: blank.y - 40 }, 4)
  await drag(client, { x: blank.x + 60, y: blank.y - 40 }, blank, 4)
  const afterDouble = await client.evaluate(LIGHTBOX_OPEN)
  log(`3 连拖两次：打开=${beforeDouble} → 之后=${afterDouble}`)

  /*
   * 场景 4（最贴近用户描述）：按住**画布**拖动，然后指针移到空白处再松手。
   * 这是真实手势——用户抓的是图，松手时手可能已经在图外。
   * 起点必须落在 SVG 上（.lightbox__svg / .lightbox__content 内），终点落在 viewport 空白。
   */
  await client.evaluate(`document.querySelector('.at-mermaid__expand')?.click()`)
  await sleep(1200)
  const beforeCanvas = await client.evaluate(LIGHTBOX_OPEN)
  const canvasPoint = await client.evaluate(`(() => {
    const svg = document.querySelector('.lightbox__svg')
    if (!svg) return null
    const r = svg.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) }
  })()`)
  log('画布中心:', JSON.stringify(canvasPoint))
  let afterCanvas = false
  if (canvasPoint) {
    // 从画布中心拖到左上角空白
    await drag(client, { x: canvasPoint.x, y: canvasPoint.y }, { x: 30, y: 860 }, 8)
    afterCanvas = await client.evaluate(LIGHTBOX_OPEN)
    log(`4 按住画布拖到空白松手：打开=${beforeCanvas} → 之后=${afterCanvas}`)
  }

  /*
   * 场景 5：双击画布（用户原话）。两次 click 都落在 SVG 上，理论上不应命中
   * `click.self`；但如果拖拽把指针带到了空白，第二次就会落在 viewport 上。
   */
  await client.evaluate(`document.querySelector('.at-mermaid__expand')?.click()`)
  await sleep(1200)
  const beforeDbl = await client.evaluate(LIGHTBOX_OPEN)
  if (canvasPoint) {
    await client.mouse('mousePressed', canvasPoint.x, canvasPoint.y, { clickCount: 1 })
    await client.mouse('mouseReleased', canvasPoint.x, canvasPoint.y, { clickCount: 1 })
    await sleep(60)
    await client.mouse('mousePressed', canvasPoint.x, canvasPoint.y, { clickCount: 2 })
    await client.mouse('mouseReleased', canvasPoint.x, canvasPoint.y, { clickCount: 2 })
    await sleep(500)
  }
  const afterDbl = await client.evaluate(LIGHTBOX_OPEN)
  log(`5 双击画布：打开=${beforeDbl} → 之后=${afterDbl}`)

  const verdict = []
  if (!beforeDrag) verdict.push('灯箱未能重新打开，场景 2 不可用')
  else verdict.push(afterDrag ? '✓ 空白处拖拽不关闭' : '❗ 空白处拖拽会关闭')
  if (beforeDouble) verdict.push(afterDouble ? '✓ 连拖两次不关闭' : '❗ 连拖两次会关闭')
  if (beforeCanvas) {
    verdict.push(afterCanvas ? '✓ 画布→空白拖拽不关闭' : '❗ 画布→空白拖拽会关闭')
  }
  if (beforeDbl) verdict.push(afterDbl ? '✓ 双击画布不关闭' : '❗ 双击画布会关闭')
  log('结论:', verdict.join(' ｜ '))

  client.close()
}

main()
  .catch(error => {
    log('探针失败:', error.message)
    process.exitCode = 1
  })
  .finally(async () => {
    cleanup()
    log('已清理')
  })
