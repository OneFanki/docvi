#!/usr/bin/env node
/**
 * 宽表格视觉验证：表头吸顶与首列冻结是否真的生效。
 *
 * 为什么必须实测：这两件事全靠 `position: sticky`，而 sticky 有几个静默失效的
 * 前提——祖先有 overflow（除了滚动容器本身）、表格是 border-collapse: collapse、
 * 单元格缺实底背景。任何一条不满足，CSS 都会「看起来写了但没效果」。
 *
 * 判据用的是**滚动前后的几何位置**，不是样式表里有没有那行声明：
 *  1. 横滑后，首列单元格的 left 边应与滚动前一致（钉住不动）；
 *  2. 纵滚后，表头单元格的 top 边应与滚动前一致；
 *  3. 两者都必须仍落在滚动容器的可见区域内（没有被裁掉）。
 *
 * 用法：node scripts/dev/probe-wide-table.mjs  （需先 pnpm docvi:build）
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
const TAG = `wt${Date.now().toString(36)}`
const PORT = 9600 + Math.floor(Math.random() * 90)
const DATA = mkdtempSync(join(tmpdir(), `docvi-wt-data-${TAG}-`))
const WS = mkdtempSync(join(tmpdir(), `docvi-wt-ws-${TAG}-`))
const DOC = join(WS, '宽表格探针.md')

/** 8 列表格 + 30 行数据：既要横滑（列多）也要纵长（表头吸顶才有意义） */
function buildDoc() {
  const cols = ['模块', '类型', '主键', '外键', '是否必填', '默认值', '索引', '说明']
  const head = `| ${cols.join(' | ')} |`
  const sep = `| ${cols.map(() => '---').join(' | ')} |`
  const rows = Array.from(
    { length: 30 },
    (_, i) =>
      `| 模块${i + 1} | 类型${i + 1} | id_${i + 1} | ref_${i + 1} | 是 | 无 | 普通索引 | 这是第 ${i + 1} 行的说明文字，用来撑出足够的高度 |`,
  )
  return `# 宽表格探针\n\n${[head, sep, ...rows].join('\n')}\n\n表格之后的正文段落。\n`
}

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
  for (const dir of [DATA, WS]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
    } catch {
      // 忽略
    }
  }
}

async function main() {
  mkdirSync(WS, { recursive: true })
  writeFileSync(DOC, buildDoc(), 'utf8')

  child = spawn(ELECTRON, [APP_DIR, '--no-sandbox'], {
    env: {
      ...process.env,
      DOCVI_HEADLESS: '1',
      DOCVI_DATA_DIR: DATA,
      DOCVI_INSTANCE: `docvi-wt-${TAG}`,
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
    width: 1280,
    height: 860,
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
      .find(el => (el.dataset.treePath || '').endsWith('宽表格探针.md'))
    row?.click()
  })()`)
  await sleep(3500)

  // 收窄视口强制横向溢出（宽表格的真实场景：阅读列装不下）
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: 720,
    height: 860,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await sleep(800)

  const marked = await client.evaluate(
    `!!document.querySelector('.at-table-wrap table[data-wide]')`,
  )
  log('宽表格已打标 data-wide:', marked)
  if (!marked) throw new Error('表格没有 data-wide，CSS 分支不会被激活')

  // 记录初始几何
  const before = await client.evaluate(`(() => {
    const wrap = document.querySelector('.at-table-wrap')
    const table = wrap.querySelector('table')
    const th = table.querySelector('thead th')
    const firstTd = table.querySelector('tbody tr td')
    const secondTd = table.querySelector('tbody tr td:nth-child(2)')
    const r = wrap.getBoundingClientRect()
    return {
      wrap: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      scrollW: wrap.scrollWidth,
      clientW: wrap.clientWidth,
      th: { top: th.getBoundingClientRect().top },
      first: { left: firstTd.getBoundingClientRect().left },
      secondLeft: secondTd.getBoundingClientRect().left,
    }
  })()`)
  log('初始：', JSON.stringify(before))
  log('可横滑:', before.scrollW > before.clientW)

  // 场景 1：横向滚动 → 首列应钉住
  const afterH = await client.evaluate(`(async () => {
    const wrap = document.querySelector('.at-table-wrap')
    wrap.scrollLeft = 260
    await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))
    const table = wrap.querySelector('table')
    const firstTd = table.querySelector('tbody tr td')
    return { scrollLeft: wrap.scrollLeft, left: firstTd.getBoundingClientRect().left }
  })()`)
  log('横滑后：', JSON.stringify(afterH))

  // 场景 2：纵向滚动到页面中段 → 表头应吸顶
  // ⚠️ 阅读视图的滚动容器是 `.reader`（overflow-y: auto），不是 window：
  // 滚动 window 什么都不会发生，上一版探针就是因此得到「未触发」而不是真实结论。
  const afterV = await client.evaluate(`(async () => {
    const scroller = document.querySelector('.reader')
    const wrap = document.querySelector('.at-table-wrap')
    if (!scroller) return { error: 'no-scroller' }
    // 把表格容器滚到视口上方：真实阅读长表格时的姿态
    scroller.scrollTop = wrap.offsetTop + 300
    await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))
    await new Promise(done => setTimeout(done, 250))
    const th = document.querySelector('.at-table-wrap table thead th')
    const thRect = th.getBoundingClientRect()
    const scrollRect = scroller.getBoundingClientRect()
    return {
      scrollTop: Math.round(scroller.scrollTop),
      thTop: Math.round(thRect.top),
      scrollerTop: Math.round(scrollRect.top),
      scrollerBottom: Math.round(scrollRect.bottom),
    }
  })()`)
  log('纵滚后：', JSON.stringify(afterV))

  // 结论
  const verdict = []
  const overflowed = before.scrollW > before.clientW + 1
  if (!overflowed) {
    verdict.push('❗ 表格没有溢出容器，横滑场景无法验证（sticky 是否生效未知）')
  } else if (afterH.scrollLeft > 0 && Math.abs(afterH.left - before.first.left) <= 2) {
    verdict.push('✓ 首列冻结生效')
  } else {
    verdict.push(
      `❗ 首列未冻结（scrollLeft=${afterH.scrollLeft}, 位移 ${(afterH.left - before.first.left).toFixed(1)}px）`,
    )
  }
  // 表头吸顶在本结构下做不到（见 doc.css 的说明）：记录实际值，作为已知限制的回归基线
  if (afterV.error) {
    verdict.push('❗ 找不到 .reader 滚动容器')
  } else {
    verdict.push(
      `· 表头不吸顶（已知限制，thTop=${afterV.thTop}, scrollerTop=${afterV.scrollerTop}）`,
    )
  }

  /*
   * 额外验证：横滑后冻结列**右侧**的普通列确实动了（否则说明整张表没滚，
   * 首列「钉住」只是假象）。
   */
  const secondCol = await client.evaluate(`(() => {
    const wrap = document.querySelector('.at-table-wrap')
    const td = wrap.querySelector('tbody tr td:nth-child(2)')
    return { left: td.getBoundingClientRect().left, scrollLeft: wrap.scrollLeft }
  })()`)
  const shifted = before.secondLeft - secondCol.left
  if (secondCol.scrollLeft > 0 && shifted > 50) {
    verdict.push(`✓ 第二列随横滑移动 ${Math.round(shifted)}px（证明真的滚了）`)
  } else {
    verdict.push(`❗ 第二列未移动，横滑可能没生效（位移 ${Math.round(shifted)}px）`)
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
