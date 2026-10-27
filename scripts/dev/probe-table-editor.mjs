#!/usr/bin/env node
/**
 * 一次性功能探针：验证「斜杠插入表格 → 自动打开网格编辑器 → 保存回写」。
 *
 * 为什么值得单独做：这条链路横跨 CM6 事务、Vue 状态、对话框与文件落盘，
 * 任何一环接不上都不报编译错误，只表现为「对话框不弹」或「文档被写坏」。
 *
 * 用法：node scripts/dev/probe-table-editor.mjs   （需先 pnpm docvi:build）
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
const WS = mkdtempSync(join(tmpdir(), `docvi-probe-ws-${TAG}-`))
const DOC = join(WS, '表格探针.md')
/** 后面那一段是关键：回写若粘连，它会被并进表格最后一行 */
const CONTENT = '# 表格探针\n\n在这里插入表格。\n\n## 下一节\n\n这段文字必须保持独立一段。\n'

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

/** 整组杀进程：只 kill 主进程会在 Windows 上留下 GPU / renderer 孤儿 */
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

  const added = await client.evaluate(
    `window.docvi.workspaceAddAt(${JSON.stringify(WS)}).then(r => r)`,
  )
  if (!added?.ok) throw new Error(`登记工作区失败：${JSON.stringify(added)}`)

  await client.evaluate('location.reload()')
  await sleep(3200)

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
    const rows = [...document.querySelectorAll('[data-tree-path]')]
    const hit = rows.find(el => (el.dataset.treePath || '').endsWith('表格探针.md'))
    if (!hit) return { ok: false, paths: rows.map(el => el.dataset.treePath) }
    hit.click()
    return { ok: true }
  })()`)
  if (!clicked?.ok) throw new Error(`找不到文档：${JSON.stringify(clicked?.paths ?? [])}`)
  await sleep(2600)

  // 切到实时预览（状态栏第 2 个模式按钮）
  const switched = await client.evaluate(`(() => {
    const btn = [...document.querySelectorAll('.status__btn')][1]
    if (!btn) return { ok: false }
    btn.click()
    return { ok: true, label: (btn.textContent || '').trim() }
  })()`)
  if (!switched?.ok) throw new Error('切不到实时预览')
  log('已切到实时预览：', switched.label)
  await sleep(2600)

  /*
   * 把光标放到「在这里插入表格。」这一行的行尾。
   *
   * 必须用真实鼠标坐标：`element.click()` 派发的事件坐标是 (0,0)，CM6 会把
   * 光标放到文档开头——上一版探针就是因此在文首插入表格，看着像产品缺陷。
   * 坐标从元素包围盒算，落在行内靠右处，走的是与用户点击完全相同的路径。
   */
  const box = await client.evaluate(`(() => {
    const line = [...document.querySelectorAll('.cm-line')]
      .find(el => (el.textContent || '').includes('在这里插入表格'))
    if (!line) return null
    const r = line.getBoundingClientRect()
    return { x: Math.round(r.right - 6), y: Math.round(r.top + r.height / 2) }
  })()`)
  if (!box) throw new Error('找不到目标正文行')
  for (const type of ['mousePressed', 'mouseReleased']) {
    await client.send('Input.dispatchMouseEvent', {
      type,
      x: box.x,
      y: box.y,
      button: 'left',
      clickCount: 1,
    })
  }
  await sleep(500)
  /*
   * 光标先回车换到新行再打斜杠。
   *
   * 斜杠菜单只认**行首**的 `/`（正文中间的 `/` 是路径或分数，产品有意不弹），
   * 所以在段落中间直接打 `/` 不会出菜单——这不是缺陷，是规则。
   */
  const keyEvent = async (key, code, keyCode) => {
    await client.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key,
      code,
      windowsVirtualKeyCode: keyCode,
    })
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key,
      code,
      windowsVirtualKeyCode: keyCode,
    })
    await sleep(200)
  }
  await keyEvent('Enter', 'Enter', 13)
  await sleep(500)

  // 用键盘真的敲 `/` 再敲查询词，走一遍用户真实路径
  for (const ch of '/') {
    await client.send('Input.dispatchKeyEvent', { type: 'char', text: ch })
    await sleep(120)
  }
  await sleep(900)
  const menuOpen = await client.evaluate(`(() => {
    const menu = document.querySelector('.slash')
    return { open: Boolean(menu), items: [...document.querySelectorAll('.slash__item, .slash__icon')].length }
  })()`)
  log('斜杠菜单：', JSON.stringify(menuOpen))
  if (!menuOpen?.open) throw new Error('斜杠菜单没有出现')

  // 用查询词过滤到唯一一项再回车：比数右键次数稳，菜单项数量会随插件变化
  for (const ch of 'table') {
    await client.send('Input.dispatchKeyEvent', { type: 'char', text: ch })
    await sleep(120)
  }
  await sleep(700)
  const label = await client.evaluate(`(() => {
    const active = document.querySelector('.slash__icon.is-active, .slash__item.is-active')
    return active ? (active.getAttribute('aria-label') || active.textContent || '').trim() : null
  })()`)
  log('当前高亮项：', label)
  if (!label || !label.includes('表格')) throw new Error(`高亮项不是表格，而是 ${label}`)

  await keyEvent('Enter', 'Enter', 13)
  await sleep(1800)

  const dialog = await client.evaluate(`(() => {
    const box = document.querySelector('.tbl__card')
    if (!box) return { open: false }
    const cells = box.querySelectorAll('.tbl__input')
    return { open: true, cells: cells.length, text: (box.textContent || '').slice(0, 80) }
  })()`)
  log('网格编辑器：', JSON.stringify(dialog))
  if (!dialog?.open) throw new Error('插入表格后没有自动打开网格编辑器')

  // 在第一个数据格里填内容，然后保存
  const filled = await client.evaluate(`(() => {
    const box = document.querySelector('.tbl__card')
    const cells = [...box.querySelectorAll('.tbl__input')]
    if (!cells.length) return { ok: false }
    const cell = cells[2] ?? cells[cells.length - 1]
    cell.focus()
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value',
    )?.set ?? Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
    setter.call(cell, '探针内容')
    cell.dispatchEvent(new Event('input', { bubbles: true }))
    return { ok: true, count: cells.length }
  })()`)
  log('填入单元格：', JSON.stringify(filled))

  const saved = await client.evaluate(`(() => {
    const box = document.querySelector('.tbl__card')
    const btn = [...box.querySelectorAll('button')]
      .find(b => (b.textContent || '').trim() === '保存')
    if (!btn) return { ok: false, buttons: [...box.querySelectorAll('button')].map(b => (b.textContent || '').trim()) }
    btn.click()
    return { ok: true }
  })()`)
  log('点保存：', JSON.stringify(saved))
  await sleep(1500)

  // 触发一次保存落盘，再读文件确认没被写坏
  await client.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 's',
    code: 'KeyS',
    windowsVirtualKeyCode: 83,
    modifiers: 2,
  })
  await sleep(1800)

  const text = readFileSync(DOC, 'utf8')
  log('---- 落盘内容 ----')
  log(JSON.stringify(text))
  const lines = text.split(/\r?\n/)
  const tableLast = lines.findIndex(
    line => line.startsWith('| 探针内容') || line.includes('探针内容'),
  )
  const nextLine = lines.slice(tableLast + 1).find(line => line.trim())
  if (tableLast < 0) throw new Error('表格内容没有写回文件')
  if (nextLine && nextLine.startsWith('|')) {
    throw new Error(`表格与下一段粘连：表格后紧邻仍是表格行 ${JSON.stringify(nextLine)}`)
  }
  if (!text.includes('## 下一节')) throw new Error('「## 下一节」被吞掉了')
  const tableAt = text.indexOf('| 列 1')
  const sectionAt = text.indexOf('## 下一节')
  const headingAt = text.indexOf('# 表格探针')
  if (tableAt < 0) throw new Error('表格没写进文档')
  if (!(headingAt < tableAt && tableAt < sectionAt)) {
    throw new Error(`插入位置不对：标题 ${headingAt} / 表格 ${tableAt} / 下节 ${sectionAt}`)
  }
  log('断言通过：表格已写回，且与下一段保持独立')

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
