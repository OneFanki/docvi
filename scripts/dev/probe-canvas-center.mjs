#!/usr/bin/env node
/**
 * 一次性探针：验证流程图全屏 / 覆盖层后**横向居中**。
 *
 * 用户报的现象：点全屏后图挤在左边，右边一大片空白。
 *
 * 根因在不变量本身：「装下才居中」被写成了全有全无——高度超出时把横向也一并
 * 贴左。长流程图（窄而高）正好命中这个组合：宽度明明有余量，横向却永远靠左。
 *
 * 断言两件事：
 *   1. 复现前提成立：进入覆盖层后内容高度确实超出视口（否则测的不是这条分支）；
 *   2. 横向居中：内容左右两侧留白之差 ≤ 2px。
 *
 * 用法：node scripts/dev/probe-canvas-center.mjs   （需先 pnpm docvi:build）
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
const TAG = `probe${Date.now().toString(36)}`
const PORT = 9900 + Math.floor(Math.random() * 90)
const DATA = mkdtempSync(join(tmpdir(), `docvi-center-data-${TAG}-`))
const WS = mkdtempSync(join(tmpdir(), `docvi-center-ws-${TAG}-`))
const DOC = join(WS, '居中探针.md')

/**
 * 窄而高的流程图：一条 26 个节点的单列链。
 *
 * 单列链宽度只有一列节点那么宽（约 130px），高度却有一千多像素。即便按可读
 * 下限（fitFloor=0.55）缩小，高度仍然超出视口——「宽度放得下、高度放不下」
 * 正是用户截图里的组合，也是旧代码把横向一并贴左的那条分支。
 *
 * 节点数不是随手写的：10 个节点只有 654px 高，fit 能整个装下（走的是居中分支，
 * 测不出问题）；要缩到下限后仍超高，才落进「装不下」分支。
 */
const CHAIN = Array.from({ length: 26 }, (_, i) => `      - { id: n${i}, label: 第 ${i + 1} 步 }`)
const EDGES = Array.from({ length: 25 }, (_, i) => `      - { from: n${i}, to: n${i + 1} }`)

const CONTENT = `---
title: 居中探针
components:
  tall:
    kind: flow-diagram
    title: 窄高流程
    nodes:
${CHAIN.join('\n')}
    edges:
${EDGES.join('\n')}
---

# 居中探针

<at-flow-diagram data-key="tall"></at-flow-diagram>
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
    close() {
      socket.close()
    },
  }))
}

function killTree() {
  if (!child) return
  spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  child = null
}

function cleanup() {
  killTree()
  for (const dir of [DATA, WS]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
    } catch {
      // 收尾失败不影响结论
    }
  }
}

/**
 * 量出居中情况。
 *
 * 只量 `.at-flow__svg`（真正被 transform 的那个元素）与画布视口的左/右间距差；
 * 用缩放后的实际渲染尺寸，不假设 scale 是多少。
 */
const MEASURE = `(() => {
  const canvas = document.querySelector('.at-flow.is-overlay .at-flow__canvas')
    || document.querySelector('.at-flow:fullscreen .at-flow__canvas')
    || document.querySelector('.at-flow__canvas')
  const svg = document.querySelector('.at-flow__svg')
  if (!canvas || !svg) return { ok: false, why: '没找到画布或 SVG' }
  const c = canvas.getBoundingClientRect()
  const s = svg.getBoundingClientRect()
  return {
    ok: true,
    overlay: Boolean(document.querySelector('.at-flow.is-overlay')),
    native: Boolean(document.querySelector('.at-flow:fullscreen')),
    viewport: { w: Math.round(c.width), h: Math.round(c.height) },
    content: { w: Math.round(s.width), h: Math.round(s.height) },
    left: Math.round(s.left - c.left),
    right: Math.round(c.right - s.right),
    top: Math.round(s.top - c.top),
    bottom: Math.round(c.bottom - s.bottom),
    transform: svg.style.transform || getComputedStyle(svg).transform,
  }
})()`

async function main() {
  mkdirSync(WS, { recursive: true })
  writeFileSync(DOC, CONTENT, 'utf8')

  child = spawn(ELECTRON, [APP_DIR, '--no-sandbox'], {
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
  await sleep(3000)
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await client.send('Emulation.setFocusEmulationEnabled', { enabled: true })

  /*
   * 强制走降级覆盖层：用户截图就是这一种（顶部还能看到应用自己的标题栏与
   * 窗口按钮）。原生全屏会换窗口模式，几何不可比，而且它走的是同一条 fit()。
   *
   * ⚠️ 必须在 location.reload() **之后**打补丁：reload 会重建整个页面上下文，
   * 之前改的 Element.prototype 随旧上下文一起丢掉（实测踩到——patch 打早了，
   * 点击走的是原生全屏，探针找不到 is-overlay）。
   */
  const patchFullscreen = `(() => {
    Element.prototype.requestFullscreen = () => Promise.reject(new Error('probe: force overlay'))
    return typeof Element.prototype.requestFullscreen === 'function'
  })()`

  const added = await client.evaluate(
    `window.docvi.workspaceAddAt(${JSON.stringify(WS)}).then(r => r)`,
  )
  if (!added?.ok) throw new Error(`登记工作区失败：${JSON.stringify(added)}`)

  await client.evaluate('location.reload()')
  await sleep(3200)
  await client.evaluate(patchFullscreen)

  const opened = await client.evaluate(`(() => {
    const cards = [...document.querySelectorAll('.card')]
    const hit = cards.find(el => (el.textContent || '').includes(${JSON.stringify(WS)}))
    if (!hit) return { ok: false, texts: cards.map(c => (c.textContent || '').trim().slice(0, 60)) }
    hit.click()
    return { ok: true }
  })()`)
  if (!opened?.ok) throw new Error(`找不到工作区卡片：${JSON.stringify(opened?.texts ?? [])}`)
  await sleep(3000)

  const clicked = await client.evaluate(`(() => {
    const row = [...document.querySelectorAll('[data-tree-path]')]
      .find(el => (el.dataset.treePath || '').endsWith('居中探针.md'))
    if (!row) return { ok: false, paths: [...document.querySelectorAll('[data-tree-path]')].map(el => el.dataset.treePath) }
    row.click()
    return { ok: true }
  })()`)
  if (!clicked?.ok) throw new Error(`找不到文档：${JSON.stringify(clicked?.paths ?? [])}`)
  await sleep(3000)

  const before = await client.evaluate(MEASURE)
  log('正文态：', JSON.stringify(before))

  /* ---------- 点全屏（走降级覆盖层） ---------- */

  const entered = await client.evaluate(`(() => {
    const btn = [...document.querySelectorAll('.at-flow__head button')]
      .find(b => (b.textContent || '').includes('全屏'))
    if (!btn) {
      return {
        ok: false,
        buttons: [...document.querySelectorAll('.at-flow__head button')].map(b => (b.textContent || '').trim()),
      }
    }
    btn.click()
    return { ok: true }
  })()`)
  if (!entered?.ok) throw new Error(`点不到全屏按钮：${JSON.stringify(entered?.buttons ?? [])}`)

  // 进覆盖层后组件会 fit 数次（0/60/200/600ms 的重试），等它稳定
  await sleep(1600)

  let measured = null
  for (let i = 0; i < 12; i += 1) {
    const now = await client.evaluate(MEASURE)
    if (now?.ok && now.overlay) {
      measured = now
      break
    }
    await sleep(250)
  }
  if (!measured) throw new Error('没能进入降级覆盖层')
  log('覆盖层态：', JSON.stringify(measured))

  /* ---------- 断言一：前提成立（高度超出、宽度有余） ---------- */

  if (measured.content.h <= measured.viewport.h) {
    throw new Error(
      `前提不成立：内容高度 ${measured.content.h} 未超出视口 ${measured.viewport.h}，测不到这条分支`,
    )
  }
  log(
    `前提成立：内容 ${measured.content.w}×${measured.content.h} 高于视口 ${measured.viewport.w}×${measured.viewport.h}`,
  )

  /* ---------- 断言二：横向居中 ---------- */

  const diff = Math.abs(measured.left - measured.right)
  log(`左右留白：left=${measured.left} right=${measured.right} 差=${diff}`)
  if (diff > 2) {
    throw new Error(
      `全屏后横向没有居中：左 ${measured.left}px / 右 ${measured.right}px（差 ${diff}px）。` +
        `用户看到的就是「图挤在左边、右侧一片空白」。`,
    )
  }

  log('通过：覆盖层内横向居中')
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
