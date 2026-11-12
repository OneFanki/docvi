#!/usr/bin/env node
/**
 * 实时预览块级展开行为验证。
 *
 * 目标（用户要求）：表格与 mermaid 图在实时预览下**不应**因为光标进入而退回源码
 * ——这两类块源码与渲染结果高度差极大，展开会让整页跳一下。
 * 但编辑能力不能丢：表格点本体开网格编辑器，mermaid 双击开源码弹窗。
 *
 * 判据（全是可观测的 DOM 事实，不看代码）：
 *  1. 打开实时预览，表格与 mermaid 都以渲染形态出现（不是源码）；
 *  2. 让光标进入表格块区间（键盘）→ 仍保持渲染形态，且页面高度不变；
 *  3. 双击 mermaid 块 → 出现源码弹窗；
 *  4. 普通代码块仍保留「光标进入即展开」（对照组，确认豁免只作用于两类块）。
 *
 * 用法：node scripts/dev/probe-live-preview-blocks.mjs （需先 pnpm docvi:build）
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
const TAG = `lp${Date.now().toString(36)}`
const PORT = 9500 + Math.floor(Math.random() * 90)
const DATA = mkdtempSync(join(tmpdir(), `docvi-lp-data-${TAG}-`))
const WS = mkdtempSync(join(tmpdir(), `docvi-lp-ws-${TAG}-`))
const DOC = join(WS, '实时预览探针.md')

const COLS = ['模块', '类型', '主键', '外键', '必填', '默认值', '索引']
const TABLE = [
  `| ${COLS.join(' | ')} |`,
  `| ${COLS.map(() => '---').join(' | ')} |`,
  ...Array.from(
    { length: 6 },
    (_, i) => `| 模块${i} | 类型${i} | id_${i} | ref_${i} | 是 | 无 | 普通 |`,
  ),
].join('\n')

const DOC_TEXT = `# 实时预览探针

## 表格

${TABLE}

## Mermaid

\`\`\`mermaid
flowchart TD
  A[入口] --> B{判断}
  B -->|通过| C[完成]
\`\`\`

## 普通代码块（对照组）

\`\`\`js
const answer = 42
\`\`\`

结尾段落。
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
    async key(key, code, keyCode) {
      await this.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key,
        code,
        windowsVirtualKeyCode: keyCode,
        nativeVirtualKeyCode: keyCode,
      })
      await this.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key,
        code,
        windowsVirtualKeyCode: keyCode,
        nativeVirtualKeyCode: keyCode,
      })
    },
    async click(x, y, clickCount = 1) {
      await this.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x,
        y,
        button: 'left',
        buttons: 1,
        clickCount,
      })
      await this.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x,
        y,
        button: 'left',
        buttons: 0,
        clickCount,
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

/** 切到实时预览（默认阅读态，需要点一下模式按钮） */
const CLICK_LIVE = `(() => {
  const btn = [...document.querySelectorAll('button')].find(b =>
    (b.textContent || '').trim() === '实时预览')
  if (!btn) return 'no-button'
  btn.click()
  return 'clicked'
})()`

async function main() {
  mkdirSync(WS, { recursive: true })
  writeFileSync(DOC, DOC_TEXT, 'utf8')

  child = spawn(ELECTRON, [APP_DIR, '--no-sandbox'], {
    env: {
      ...process.env,
      DOCVI_HEADLESS: '1',
      DOCVI_DATA_DIR: DATA,
      DOCVI_INSTANCE: `docvi-lp-${TAG}`,
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
      .find(el => (el.dataset.treePath || '').endsWith('实时预览探针.md'))
    row?.click()
  })()`)
  await sleep(3500)

  const live = await client.evaluate(CLICK_LIVE)
  log('切实时预览:', live)
  await sleep(3500)

  /* 1. 两类块都以渲染形态出现 */
  const initial = await client.evaluate(`(() => {
    const cm = document.querySelector('.cm-content')
    return {
      hasCm: !!cm,
      tableBlock: !!document.querySelector('.cm-lp-block--table table'),
      mermaidBlock: !!document.querySelector('.cm-lp-block--mermaid svg'),
      docHeight: Math.round(document.querySelector('.cm-content')?.getBoundingClientRect().height ?? 0),
    }
  })()`)
  log('初始形态:', JSON.stringify(initial))

  /* 2. 光标进入表格块：高度应稳定、块仍渲染 */
  const afterTableCursor = await client.evaluate(`(async () => {
    const block = document.querySelector('.cm-lp-block--table')
    if (!block) return { error: 'no-table-block' }
    // 用真实点击把光标放进块区间
    const r = block.getBoundingClientRect()
    return { rect: { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + 20) } }
  })()`)

  let tableStable = null
  if (afterTableCursor?.rect) {
    const beforeH = await client.evaluate(
      `Math.round(document.querySelector('.cm-content').getBoundingClientRect().height)`,
    )
    await client.click(afterTableCursor.rect.x, afterTableCursor.rect.y)
    await sleep(900)
    const afterH = await client.evaluate(`(() => ({
      height: Math.round(document.querySelector('.cm-content').getBoundingClientRect().height),
      stillTable: !!document.querySelector('.cm-lp-block--table table'),
    }))()`)
    tableStable = { beforeH, afterH }
    log('点表格后:', JSON.stringify(afterH), '变化', afterH.height - beforeH)

    // 再按方向键在块区间内游走，确认也不再展开（atomicRange 生效）
    await client.key('ArrowDown', 'ArrowDown', 40)
    await sleep(500)
    await client.key('ArrowUp', 'ArrowUp', 38)
    await sleep(500)
    const afterKeys = await client.evaluate(`(() => ({
      height: Math.round(document.querySelector('.cm-content').getBoundingClientRect().height),
      stillTable: !!document.querySelector('.cm-lp-block--table table'),
    }))()`)
    log('方向键游走后:', JSON.stringify(afterKeys))
    tableStable.keys = afterKeys
  } else {
    log('❗ 找不到表格块')
  }

  /* 3. 双击 mermaid → 源码弹窗 */
  const mermaidRect = await client.evaluate(`(() => {
    const block = document.querySelector('.cm-lp-block--mermaid')
    if (!block) return null
    const r = block.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + Math.min(40, r.height / 2)) }
  })()`)
  let modalOpened = false
  if (mermaidRect) {
    await client.click(mermaidRect.x, mermaidRect.y, 1)
    await client.click(mermaidRect.x, mermaidRect.y, 2)
    await sleep(1200)
    modalOpened = await client.evaluate(`!!document.querySelector('.srcmodal')`)
    log('双击 mermaid 后出现源码弹窗:', modalOpened)
    if (modalOpened) {
      // Esc 关掉，别影响后续断言
      await client.key('Escape', 'Escape', 27)
      await sleep(500)
    }
  } else {
    log('❗ 找不到 mermaid 块')
  }

  /* 4. 对照组：普通代码块光标进入仍展开 */
  const jsExpanded = await client.evaluate(`(async () => {
    // 找到 js 代码块对应的 widget（kind 为 js）
    const block = document.querySelector('.cm-lp-block--js')
    if (!block) return { error: 'no-js-block' }
    const r = block.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + 12) }
  })()`)
  let jsStillRendered = null
  if (jsExpanded?.x) {
    await client.click(jsExpanded.x, jsExpanded.y)
    await sleep(900)
    jsStillRendered = await client.evaluate(`!!document.querySelector('.cm-lp-block--js')`)
    log('普通代码块光标进入后仍是 widget:', jsStillRendered)
  }

  const verdict = []
  if (!initial.tableBlock) verdict.push('❗ 表格初始未渲染')
  if (!initial.mermaidBlock) verdict.push('❗ mermaid 初始未渲染')
  if (tableStable?.afterH) {
    const delta = Math.abs(tableStable.afterH.height - tableStable.beforeH)
    if (tableStable.afterH.stillTable && delta <= 8)
      verdict.push(`✓ 表格不随光标展开（高度差 ${delta}px）`)
    else
      verdict.push(
        `❗ 表格随光标展开（高度差 ${delta}px, 表格仍在=${tableStable.afterH.stillTable}）`,
      )
    if (tableStable.keys?.stillTable) verdict.push('✓ 方向键游走不展开')
    else verdict.push('❗ 方向键游走后表格退化成源码')
  }
  verdict.push(modalOpened ? '✓ 双击 mermaid 可编辑' : '❗ 双击 mermaid 没有弹窗（块变成只读）')
  if (jsStillRendered !== null) {
    verdict.push(
      jsStillRendered === false
        ? '✓ 普通代码块仍按原规则展开（豁免只作用于表格/mermaid）'
        : '· 普通代码块点击后仍是 widget（对照组未触发）',
    )
  }
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
