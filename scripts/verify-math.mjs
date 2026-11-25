/**
 * 公式端到端探针：真实 Electron 里看阅读态 / 编辑态是否真的排版出 MathML。
 *
 * 断言的是**计算后的几何**而不是「HTML 里有 <math>」——有标签但 display:none
 * 或宽度为 0 的情况，纯 HTML 断言看不出来。
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

const root = mkdtempSync(join(tmpdir(), 'docvi-math-e2e-'))
const ws = join(root, 'ws')
mkdirSync(ws, { recursive: true })
writeFileSync(
  join(ws, 'docs.config.yaml'),
  'title: 公式验证\nsidebar:\n  - text: 公式\n    path: index.md\n',
)
writeFileSync(
  join(ws, 'index.md'),
  [
    '# 公式验证',
    '',
    '行内：播放态前向预读稳定维持在 $W/4$（如 30 帧 / 1 秒）。',
    '',
    '行内带命令：退化为热点 $\\pm 60\\text{s}$ 的局部窗口。',
    '',
    '$$',
    '\\frac{a+b}{c} = \\sqrt{x^2 + y^2}',
    '$$',
    '',
    '货币不该被吞：价格是 $5 and $10 这样。',
    '',
  ].join('\n'),
)

const dataDir = mkdtempSync(join(tmpdir(), 'docvi-math-data-'))
const port = await freePort()
let child = null
let socket = null

try {
  child = spawn(ELECTRON, [APP_DIR, '--no-sandbox'], {
    env: {
      ...process.env,
      DOCVI_HEADLESS: '1',
      DOCVI_DATA_DIR: dataDir,
      DOCVI_INSTANCE: 'docvi-math-e2e',
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
  const consoleErrors = []
  socket.addEventListener('message', e => {
    const m = JSON.parse(e.data)
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      consoleErrors.push(m.params.args.map(a => a.value ?? a.description ?? '').join(' '))
    }
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

  const report = {}

  report.setup = await ev(`(async () => {
    let app = null
    for (let i = 0; i < 60; i += 1) {
      const el = document.querySelector('#app')
      app = el && el.__vue_app__
      if (app) break
      await new Promise(r => setTimeout(r, 200))
    }
    const pinia = app?.config?.globalProperties?.$pinia
    if (!pinia) return { error: '取不到 pinia' }
    const store = pinia._s.get('app')
    const entry = await store.addWorkspaceAt(${JSON.stringify(ws)})
    return { ok: Boolean(entry), name: entry?.name }
  })()`)

  // 打开文档：点树里的「公式」行
  report.open = await ev(`(async () => {
    for (let i = 0; i < 60; i += 1) {
      const row = [...document.querySelectorAll('[data-tree-path]')]
        .find(el => (el.textContent || '').includes('公式'))
      if (row) {
        row.click()
        await new Promise(r => setTimeout(r, 2500))
        return { ok: true }
      }
      await new Promise(r => setTimeout(r, 200))
    }
    return { error: '树里没有公式这篇' }
  })()`)

  /*
   * 几何断言：MathML 真的排版出来了。
   *
   * 只看「有没有 <math>」不够——标签存在但高度为 0（CSS 没生效 / 父容器隐藏）
   * 时，用户看到的是空白。所以读 getBoundingClientRect 的宽高。
   */
  report.readMode = await ev(`(() => {
    const maths = [...document.querySelectorAll('.at-doc math')]
    const blocks = [...document.querySelectorAll('.at-math--block')]
    return {
      inlineCount: maths.length,
      blockCount: blocks.length,
      // 每个公式的实际尺寸：宽或高为 0 就说明没排出来
      sizes: maths.map(m => {
        const r = m.getBoundingClientRect()
        return { w: Math.round(r.width), h: Math.round(r.height) }
      }),
      hasErrorSpan: document.querySelectorAll('.at-doc .katex-error').length > 0,
      // 货币必须原样出字
      moneyText: (document.querySelector('.at-doc')?.textContent || '').includes('$5 and $10'),
      // 源码里的 TeX 不该裸露
      leaksTex: (document.querySelector('.at-doc')?.textContent || '').includes('\\frac'),
    }
  })()`)

  report.consoleErrors = consoleErrors.slice(0, 8)

  /* ---------- 断言 ---------- */
  const failures = []
  const expect = (ok, message, detail) => {
    if (!ok) failures.push({ message, detail })
  }

  expect(report.setup?.ok, '测试工作区应登记成功', report.setup)
  expect(report.open?.ok, '应能打开公式文档', report.open)

  const read = report.readMode ?? {}
  expect(read.inlineCount >= 2, '两个行内公式都该渲染成 MathML', read.inlineCount)
  expect(read.blockCount === 1, '块级公式应有一个 at-math--block 容器', {
    blockCount: read.blockCount,
  })
  expect(
    Array.isArray(read.sizes) && read.sizes.length > 0 && read.sizes.every(s => s.w > 0 && s.h > 0),
    '每个公式都必须有非零尺寸（有标签但没排版等于看不见）',
    read.sizes,
  )
  expect(!read.hasErrorSpan, '合法公式不该降级成错误样式', read.hasErrorSpan)
  expect(read.moneyText, '货币金额必须原样保留', read.moneyText)
  expect(!read.leaksTex, 'TeX 源码不该裸露在正文里', read.leaksTex)
  expect(
    !report.consoleErrors.some(line => /strict|KaTeX/i.test(line)),
    '公式渲染不该产生 KaTeX 警告',
    report.consoleErrors,
  )

  if (failures.length) {
    console.error(`[verify:math] ${failures.length} 项不变量失守：`)
    for (const failure of failures) {
      console.error(`  ✖ ${failure.message}`)
      if (failure.detail !== undefined) console.error(`    实际：${JSON.stringify(failure.detail)}`)
    }
    process.exitCode = 1
  } else {
    console.log(
      `[verify:math] 通过：行内 ${read.inlineCount} 个 + 块级 ${read.blockCount} 个公式都排版出非零尺寸，货币未被误伤`,
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
