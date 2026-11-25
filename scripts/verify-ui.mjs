/**
 * UI 几何回归：大纲在右侧 / 树工具条靠右 / 工作区弹窗底栏单行。
 *
 * 三条都读 `getBoundingClientRect` 而不是「元素存在」：
 * 大纲掉到窗口底部、按钮被换行挤到第二行时，元素一样存在——只有坐标能说明问题。
 * 这三处都是「改布局时很容易顺手改坏、看截图才发现」的位置。
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

const root = mkdtempSync(join(tmpdir(), 'docvi-ui-'))
const wsA = join(root, 'ws-a')
const wsB = join(root, 'ws-b')
for (const [dir, name] of [
  [wsA, 'A'],
  [wsB, 'B'],
]) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'docs.config.yaml'),
    `title: 工作区${name}\nsidebar:\n  - text: 首页\n    path: index.md\n`,
  )
  writeFileSync(join(dir, 'index.md'), `# ${name} 首页\n\n## 第一节\n\n正文\n\n## 第二节\n\n正文\n`)
}

const dataDir = mkdtempSync(join(tmpdir(), 'docvi-ui-data-'))
const port = await freePort()
let child = null
let socket = null

try {
  child = spawn(ELECTRON, [APP_DIR, '--no-sandbox'], {
    env: {
      ...process.env,
      DOCVI_HEADLESS: '1',
      DOCVI_DATA_DIR: dataDir,
      DOCVI_INSTANCE: 'docvi-ui',
      DOCVI_DEBUG_PORT: String(port),
    },
    stdio: 'ignore',
  })

  let target = null
  for (let i = 0; i < 120; i += 1) {
    await wait(300)
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      target = list.find(x => x.type === 'page' && x.url.includes('index.html'))
      if (target) break
    } catch {
      /* 端口未开 */
    }
  }
  if (!target) throw new Error('调试端口没开')

  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((ok, fail) => {
    socket.addEventListener('open', ok)
    socket.addEventListener('error', fail)
  })
  let id = 0
  const pending = new Map()
  socket.addEventListener('message', e => {
    const m = JSON.parse(e.data)
    const cb = pending.get(m.id)
    if (cb) {
      pending.delete(m.id)
      cb(m)
    }
  })
  const send = (method, params = {}) =>
    new Promise((ok, fail) => {
      const n = ++id
      socket.send(JSON.stringify({ id: n, method, params }))
      pending.set(n, m => (m.error ? fail(new Error(m.error.message)) : ok(m.result)))
    })
  await send('Runtime.enable')
  const ev = async expr =>
    (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }))
      ?.result?.value

  // 视口固定成常见桌面尺寸：几何断言要有确定的参照
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1680,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await wait(800)

  await ev(`(async () => {
    let app = null
    for (let i = 0; i < 60; i += 1) {
      const el = document.querySelector('#app')
      app = el && el.__vue_app__
      if (app) break
      await new Promise(r => setTimeout(r, 200))
    }
    const pinia = app?.config?.globalProperties?.$pinia
    const store = pinia._s.get('app')
    await store.addWorkspaceAt(${JSON.stringify(wsA)})
    await store.addWorkspaceAt(${JSON.stringify(wsB)})
    return store.workspaces.length
  })()`)
  await wait(1500)

  // 打开一篇文档，让大纲有内容
  await ev(`(async () => {
    for (let i = 0; i < 40; i += 1) {
      const row = [...document.querySelectorAll('[data-tree-path]')].find(el =>
        (el.textContent || '').includes('首页'),
      )
      if (row) {
        row.click()
        await new Promise(r => setTimeout(r, 2200))
        return true
      }
      await new Promise(r => setTimeout(r, 200))
    }
    return false
  })()`)
  await wait(1200)

  const report = {}

  // ---- 1. 大纲必须在画布右侧，不是下方 ----
  report.outline = await ev(`(() => {
    // 大纲可能默认收起：先点标题栏的大纲开关
    const el = document.querySelector('.outline, [class*="outline"]')
    const canvas = document.querySelector('.canvas')
    if (!el || !canvas) return { present: Boolean(el), hasCanvas: Boolean(canvas), outlineHtml: document.querySelector('.shell__content')?.className }
    const o = el.getBoundingClientRect()
    const c = canvas.getBoundingClientRect()
    return {
      present: true,
      outline: { left: Math.round(o.left), top: Math.round(o.top), w: Math.round(o.width), h: Math.round(o.height) },
      canvas: { left: Math.round(c.left), right: Math.round(c.right), top: Math.round(c.top) },
      // 大纲应在画布右边界之外，且顶部与画布顶部接近（不是被推到窗口底部）
      toTheRight: o.left >= c.right - 1,
      topAligned: Math.abs(o.top - c.top) < 40,
    }
  })()`)

  // ---- 2. 树工具条靠右 ----
  report.treeTools = await ev(`(() => {
    const header = document.querySelector('.tree__header')
    const tools = document.querySelector('.tree__tools')
    const sidebar = document.querySelector('.sidebar')
    if (!header || !tools || !sidebar) return { error: '缺元素', hasHeader: Boolean(header) }
    const h = header.getBoundingClientRect()
    const t = tools.getBoundingClientRect()
    return {
      headerRight: Math.round(h.right),
      toolsRight: Math.round(t.right),
      // 工具右缘应贴着头部右缘（允许几像素内边距误差）
      rightAligned: Math.abs(h.right - t.right) < 12,
      // 且不在左侧
      notLeft: t.left > h.left + 40,
    }
  })()`)

  // ---- 3. 工作区弹窗底栏：一行，危险项在最右 ----
  report.dialog = await ev(`(async () => {
    document.querySelector('.sidebar__ws-btn')?.click()
    await new Promise(r => setTimeout(r, 500))
    const rows = document.querySelectorAll('.wsrow')
    const actions = document.querySelector('.wsdialog__actions')
    if (!actions) return { error: '弹窗没打开', rows: rows.length }
    const buttons = [...actions.querySelectorAll('.wsaction')].filter(b => b.offsetParent !== null)
    const tops = new Set(buttons.map(b => Math.round(b.getBoundingClientRect().top)))
    const danger = actions.querySelector('.wsaction--danger')
    const last = buttons[buttons.length - 1]
    return {
      rowCount: rows.length,
      actionCount: buttons.length,
      distinctRows: tops.size,
      // 单行：所有按钮 top 一致
      singleLine: tops.size === 1,
      dangerIsLast: Boolean(danger) && danger === last,
    }
  })()`)

  // ---- 4. Ctrl+1 打开工作区弹窗（命令面板那条也走同一入口）----
  report.hotkey = await ev(`(async () => {
    // 先确认弹窗是关着的，再按键——否则「本来开着」会被误判成按键生效
    document.querySelector('.wsdialog__close')?.click()
    await new Promise(r => setTimeout(r, 300))
    const before = Boolean(document.querySelector('.wsdialog'))
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: '1', ctrlKey: true, bubbles: true, cancelable: true }),
    )
    await new Promise(r => setTimeout(r, 500))
    return { before, after: Boolean(document.querySelector('.wsdialog')) }
  })()`)

  const failures = []
  const expect = (ok, message, detail) => {
    if (!ok) failures.push({ message, detail })
  }

  const outline = report.outline ?? {}
  expect(outline.present, '大纲面板应存在', report.outline)
  expect(outline.toTheRight, '大纲必须在画布右侧，不能掉到下方', {
    outline: outline.outline,
    canvas: outline.canvas,
  })
  expect(outline.topAligned, '大纲顶部应与画布顶部对齐', outline.outline)

  const tt = report.treeTools ?? {}
  expect(!tt.error, '树工具条探针应能跑通', tt)
  expect(tt.rightAligned, '树的工具按钮应靠右对齐', tt)
  expect(tt.notLeft, '树的工具按钮不该挤在左侧', tt)

  const dlg = report.dialog ?? {}
  expect(!dlg.error, '工作区弹窗应能打开', dlg)
  expect(dlg.singleLine, '弹窗底栏按钮必须在一行（不能错开成两行）', {
    actionCount: dlg.actionCount,
    distinctRows: dlg.distinctRows,
  })
  expect(dlg.dangerIsLast, '移除工作区应在最右', dlg)

  const hot = report.hotkey ?? {}
  expect(hot.before === false, '按键前弹窗应是关着的（否则断言无效）', hot)
  expect(hot.after === true, 'Ctrl+1 应打开工作区弹窗', hot)

  if (failures.length) {
    console.error(`[verify:ui-geometry] ${failures.length} 项不变量失守：`)
    for (const f of failures) {
      console.error(`  ✖ ${f.message}`)
      if (f.detail !== undefined) console.error(`    实际：${JSON.stringify(f.detail)}`)
    }
    process.exitCode = 1
  } else {
    console.log(
      '[verify:ui-geometry] 通过：大纲在右侧、树工具靠右、弹窗底栏单行且危险项在最右、Ctrl+1 打开弹窗',
    )
  }
} finally {
  try {
    socket?.close()
  } catch {
    /* 已断开 */
  }
  child?.kill()
  await wait(600)
  rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 })
}
