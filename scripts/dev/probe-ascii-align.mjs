#!/usr/bin/env node
/**
 * ASCII 图对齐的视觉验证。
 *
 * 单测能证明「span 生成了」，证明不了「渲染后真的对齐」——后者取决于字体度量、
 * CSS 定宽、以及高亮 pass 有没有把 span 冲掉。所以必须量真实排版。
 *
 * 判据分两步，缺一不可：
 *  1. **锁定组**：每行的像素宽度 ÷ 该行逻辑列数，应当处处相等（残差 ≤ 1px）。
 *  2. **对照组**：同一段内容去掉锁宽 span 后，同一比值必然发散（> 5px）——
 *     否则说明这张图本来就不需要锁宽，探针等于什么都没验。
 *
 * 图的每一行由 `top()/mid()/bottom()` 按逻辑列数生成，宽度是算出来的而不是
 * 手写的。手写宽度曾经让我得到一份「45/49/45」的样本，那种样本无论实现
 * 好坏都测不出东西。
 *
 * 用法：node scripts/dev/probe-ascii-align.mjs  （需先 pnpm docvi:build）
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
const TAG = `aa${Date.now().toString(36)}`
const PORT = 9400 + Math.floor(Math.random() * 90)
const DATA = mkdtempSync(join(tmpdir(), `docvi-aa-data-${TAG}-`))
const WS = mkdtempSync(join(tmpdir(), `docvi-aa-ws-${TAG}-`))
const DOC = join(WS, 'ascii对齐探针.md')

/* ---------- 图生成：逻辑宽度必须可算可证 ---------- */

/** 与 ascii-align.ts 的 isFullWidth 同一套区间（这里独立实现，不复用源码） */
function isWide(ch) {
  const cp = ch.codePointAt(0) ?? 0
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0x1f300 && cp <= 0x1f9ff)
  )
}

const disp = s => {
  let w = 0
  for (const ch of s) w += isWide(ch) ? 2 : 1
  return w
}

const W = 46
const top = title => {
  const core = ` ${title} `
  return `┌${core}${'─'.repeat(W - 2 - disp(core))}┐`
}
const mid = content => {
  const core = ` ${content} `
  return `│${core}${' '.repeat(W - 2 - disp(core))}│`
}
const bottom = `└${'─'.repeat(W - 2)}┘`
const pad = (s, cols) => s + ' '.repeat(cols - disp(s))

/**
 * 三组包，中英混排 + 圈号 + 关系箭头。
 *
 * `full: true` 的行必须正好 W 列；连接线是故意短的一行，只参与量宽不参与
 * 列数自检——它的样子本来就是「缩进几格再画一条竖线」。
 */
const ART = [
  { line: top('① 应用包 apps/* · 可部署产物'), full: true },
  { line: mid('console 平台外壳·路由装配'), full: true },
  { line: mid('mobile 移动作业端'), full: true },
  { line: bottom, full: true },
  { line: pad('│装配', 24), full: false },
  { line: top('② 业务模块包 packages/*'), full: true },
  { line: mid('resource      auth       tag'), full: true },
  { line: mid('iam ──权限码──→  collect'), full: true },
  { line: bottom, full: true },
].map(item => ({ ...item, cols: disp(item.line) }))

/* 自检：这是探针能成立的前提，图本身不齐就没资格判实现 */
for (const { line, cols, full } of ART) {
  if (full && cols !== W) {
    throw new Error(`样本图不齐：期望 ${W} 列，实得 ${cols}：${line}`)
  }
}

const DOC_TEXT = `# ASCII 对齐探针

\`\`\`text
${ART.map(item => item.line).join('\n')}
\`\`\`

## 对照组：真实语言块（不应被锁宽）

\`\`\`sql
SELECT 中文字段 FROM 订单表 WHERE 状态 = 1
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
  writeFileSync(DOC, DOC_TEXT, 'utf8')

  child = spawn(ELECTRON, [APP_DIR, '--no-sandbox'], {
    env: {
      ...process.env,
      DOCVI_HEADLESS: '1',
      DOCVI_DATA_DIR: DATA,
      DOCVI_INSTANCE: `docvi-aa-${TAG}`,
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
      .find(el => (el.dataset.treePath || '').endsWith('ascii对齐探针.md'))
    row?.click()
  })()`)
  await sleep(4000)

  const marked = await client.evaluate(`(() => ({
    hasAscii: !!document.querySelector('[data-ascii]'),
    spanCount: document.querySelectorAll('[data-ascii] .at-ascii-w2').length,
    langTag: !!document.querySelector('[data-ascii] .lang'),
  }))()`)
  log('打标与锁宽:', JSON.stringify(marked))

  /*
   * 逐行量宽度。
   *
   * 不能直接对原 `<code>` 用 Range 按行切：跨 span 边界时节点跳转极易写错，
   * 而写错的表现是「量到 0」而非报错。这里改成「克隆结构再按换行分组」——
   * 文本节点按 \n 切段，宽字符 span 是原样克隆的，于是每组就是「这一行渲染
   * 出来会占的节点」。把每组塞进一个 inline-block 量宽度，字体与换行规则
   * 由同源 `<pre>` 继承。
   */
  const measure = await client.evaluate(`(() => {
    const code = document.querySelector('[data-ascii] pre code')
    const pre = document.querySelector('[data-ascii] pre')
    if (!code || !pre) return { error: 'no-code' }

    /* 按换行把子节点分成「行」；返回每行的节点数组 */
    function lineGroups(root) {
      const groups = [[]]
      for (const node of Array.from(root.childNodes)) {
        if (node.nodeType === 3) {
          const parts = node.textContent.split('\\n')
          parts.forEach((part, index) => {
            if (index > 0) groups.push([])
            if (part) groups[groups.length - 1].push(document.createTextNode(part))
          })
        } else {
          groups[groups.length - 1].push(node.cloneNode(true))
        }
      }
      // 围栏正文末尾的换行会产生一个空组，它不是图的一行
      while (groups.length > 1 && groups[groups.length - 1].length === 0) groups.pop()
      return groups
    }

    /* 在离屏的 pre 里量每行宽度；stripSpans 用于对照组 */
    /*
     * 离屏盒必须挂在**原 pre 的父节点**下：.at-ascii-w2 的定宽规则作用域在
     * .at-doc 内，挂到 document.body 会跑出作用域，锁宽失效——那样量出来的
     * 「锁定组」其实还是自然宽度，对照组与它残差相同，探针等于什么都没验。
     *
     * ⚠️ 这段是塞进 CDP 的模板字符串：注释里不能出现反引号，否则字符串被截断，
     * 报错会显示成莫名其妙的 "ascii is not defined"。
     */
    const box = pre.cloneNode(false)
    box.style.cssText = 'position:absolute;left:-99999px;top:0;visibility:hidden'
    pre.parentElement.appendChild(box)

    function measureLines(stripSpans) {
      box.textContent = ''
      const rows = []
      for (const group of lineGroups(code)) {
        const row = document.createElement('span')
        row.style.cssText = 'display:inline-block;white-space:pre'
        for (const node of group) {
          if (stripSpans && node.nodeType === 1) {
            row.appendChild(document.createTextNode(node.textContent))
          } else {
            row.appendChild(node)
          }
        }
        box.appendChild(row)
        box.appendChild(document.createElement('br'))
        rows.push({ width: row.getBoundingClientRect().width, text: row.textContent })
      }
      /* 单字符宽度基准：取一个必然是 1ch 的字符 */
      const ruler = document.createElement('span')
      ruler.style.cssText = 'display:inline-block;white-space:pre'
      ruler.textContent = 'x'
      box.appendChild(ruler)
      const ch = ruler.getBoundingClientRect().width
      return { rows, ch }
    }

    const locked = measureLines(false)
    const natural = measureLines(true)
    box.remove()
    return { locked, natural }
  })()`)
  if (measure.error) throw new Error(`量宽失败：${measure.error}`)

  /**
   * 满宽行的**绝对像素宽度差**，这才是「框线是否对齐」的直接度量。
   *
   * 不按「像素宽 ÷ 逻辑列数」算比值：比值把图上不同 CJK 密度的行混在一起，
   * 密度低的短行会稀释真实偏差（实测首次跑出 3.28px 却判「也齐」）。
   * 满宽行本来就应该渲染成同一个像素宽度，差多少就是框线错位多少。
   */
  function spread({ rows }) {
    const widths = rows
      .map((row, index) => ({ width: row.width, full: ART[index].full }))
      .filter(item => item.full)
      .map(item => Math.round(item.width * 100) / 100)
    const max = Math.max(...widths)
    const min = Math.min(...widths)
    return { px: Math.round((max - min) * 100) / 100, widths }
  }

  /* 把逻辑列数补进量到的行里（DOM 里没有列数信息，按顺序对齐） */
  for (const set of [measure.locked, measure.natural]) {
    if (set.rows.length !== ART.length) {
      throw new Error(`行数不符：DOM ${set.rows.length} 行，样本 ${ART.length} 行`)
    }
    set.rows.forEach((row, index) => {
      row.cols = ART[index].cols
    })
  }

  const locked = spread(measure.locked)
  const natural = spread(measure.natural)
  log('1ch =', Math.round(measure.locked.ch * 1000) / 1000, 'px')
  log('锁定组满宽行:', JSON.stringify(locked.widths), `→ 差 ${locked.px}px`)
  log('对照组满宽行:', JSON.stringify(natural.widths), `→ 差 ${natural.px}px`)

  const verdict = []
  verdict.push(marked.hasAscii ? '✓ 打上 data-ascii' : '❗ 没有打上 data-ascii')
  verdict.push(marked.langTag ? '❗ text 块仍显示语言标签' : '✓ text 块无语言标签')
  verdict.push(
    marked.spanCount > 0 ? `✓ ${marked.spanCount} 个锁宽 span 存活` : '❗ 锁宽 span 被冲掉',
  )
  verdict.push(
    locked.px <= 1 ? `✓ 对齐残差 ${locked.px}px ≤ 1px` : `❗ 对齐残差 ${locked.px}px > 1px`,
  )
  verdict.push(
    natural.px > 5
      ? `✓ 对照组确实不齐（${natural.px}px，证明修有意义）`
      : `❗ 对照组也齐（${natural.px}px），探针测不出东西`,
  )
  log('结论:', verdict.join(' ｜ '))

  const failed = verdict.some(item => item.startsWith('❗'))
  if (failed) process.exitCode = 1

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
