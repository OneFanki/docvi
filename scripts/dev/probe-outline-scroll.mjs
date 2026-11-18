#!/usr/bin/env node
/**
 * 「点右侧目录跳转 → 整个界面被滚走、顶栏消失」的回归验证。
 *
 * 复现条件（用户实测踩到的）：文档里有一张 **渲染失败** 的 mermaid 图。
 * mermaid 11 解析失败时会把错误图插到 `<body>` 末尾，那个图几百像素高，
 * 把 body 撑过视口 → 整页变可滚 → 此后任何一次 `scrollIntoView` 都会连带
 * 滚动 `<html>`/`<body>`，把固定的标题栏与标签栏推出视口。
 *
 * 三层防线各自要有独立证据，缺一层都可能被下一次改动打破而无人发现：
 *  1. 失败残留被清掉（body 高度回到视口内，没有 `ddocvi-mermaid-*`）；
 *  2. 即使 body 被别的东西撑高（手动注入一个 1000px 的块模拟），`<html>`
 *     锁滚也让 `documentElement.scrollTop` 动不了；
 *  3. 跳转本身仍然有效（阅读容器 scrollTop 变大、目标标题到了容器顶部附近）。
 *
 * 用法：node scripts/dev/probe-outline-scroll.mjs
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const ELECTRON = join(ROOT, 'apps/desktop/node_modules/electron/dist/electron.exe')
const APP_DIR = join(ROOT, 'apps/desktop')
const TAG = `os${Date.now().toString(36)}`
const PORT = 9600 + Math.floor(Math.random() * 40)
const DATA = mkdtempSync(join(tmpdir(), `docvi-os-data-${TAG}-`))
const WS = mkdtempSync(join(tmpdir(), `docvi-os-ws-${TAG}-`))

const DOC = `# 目录跳转验证

第一段正文。下面两张图，一张正常、一张语法是坏的——坏的那张必须**渲染失败**，
这正是本探针要复现的触发条件（mermaid 失败会在 body 末尾留一个错误图把页面撑高）。

\`\`\`mermaid
flowchart TD
  A[开始] --> B[结束]
\`\`\`

\`\`\`mermaid
flowchart TD
  A[开始 --> 这行少一个括号 B
\`\`\`

${Array.from(
  { length: 30 },
  (_, index) => `## 第 ${index + 1} 节

第 ${index + 1} 节的正文，用来把阅读容器撑得足够长，让跳转有地方可去。

- 条目 A${index + 1}
- 条目 B${index + 1}
`,
).join('\n')}
`

let child = null
const log = (...args) => console.log('[outline]', ...args)

function connect(url) {
  const socket = new WebSocket(url)
  let nextId = 0
  const pending = new Map()
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    const call = pending.get(message.id)
    if (!call) return
    pending.delete(message.id)
    call(message.result ?? message.error)
  })
  return new Promise((done, fail) => {
    socket.addEventListener('open', done, { once: true })
    socket.addEventListener('error', () => fail(new Error('CDP 连接失败')), { once: true })
  }).then(() => ({
    send(method, params = {}) {
      return new Promise(done => {
        const id = ++nextId
        pending.set(id, message => done(message))
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

const failures = []
function check(name, ok, detail) {
  log(`${ok ? '✓' : '❗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(name)
}

/** 页面内断言脚本：按当前状态收集证据 */
const SNAPSHOT = `(() => {
  const docEl = document.documentElement
  const body = document.body
  const chrome = ['.titlebar', '.tabbar'].map(sel => {
    const el = document.querySelector(sel)
    if (!el) return { sel, missing: true }
    const r = el.getBoundingClientRect()
    return { sel, top: Math.round(r.top), bottom: Math.round(r.bottom) }
  })
  const reader = document.querySelector('.reader')
  return {
    docScrollTop: Math.round(docEl.scrollTop),
    docScrollHeight: docEl.scrollHeight,
    innerHeight: window.innerHeight,
    bodyScrollHeight: body.scrollHeight,
    bodyOverflowY: getComputedStyle(body).overflowY,
    htmlOverflowY: getComputedStyle(docEl).overflowY,
    residue: [...document.querySelectorAll('[id^="ddocvi-mermaid-"]')].map(el => el.id),
    chrome,
    readerScrollTop: reader ? Math.round(reader.scrollTop) : null,
    readerScrollHeight: reader ? reader.scrollHeight : null,
    readerClientHeight: reader ? reader.clientHeight : null,
  }
})()`

async function main() {
  writeFileSync(join(WS, '目录跳转验证.md'), DOC, 'utf8')

  child = spawn(ELECTRON, [APP_DIR, '--no-sandbox'], {
    env: {
      ...process.env,
      DOCVI_HEADLESS: '1',
      DOCVI_DATA_DIR: DATA,
      DOCVI_INSTANCE: `docvi-os-${TAG}`,
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
  if (!target) throw new Error('应用窗口没有出现')

  const client = await connect(target.webSocketDebuggerUrl)
  await sleep(3500)
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: 1100,
    height: 700,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await client.evaluate(`window.docvi.workspaceAddAt(${JSON.stringify(WS)}).then(r => r)`)
  await client.evaluate('location.reload()')
  await sleep(3200)
  await client.evaluate(`(() => {
    [...document.querySelectorAll('.card')]
      .find(el => (el.textContent || '').includes(${JSON.stringify(WS)}))?.click()
  })()`)
  await sleep(2200)
  await client.evaluate(`(() => {
    [...document.querySelectorAll('[data-tree-path]')]
      .find(el => (el.dataset.treePath || '').endsWith('目录跳转验证.md'))?.click()
  })()`)
  /*
   * 等到渲染真正稳定再往下走：mermaid 是动态 import（core 1.2MB + 图类型分包），
   * 慢机器上 6s 未必够。若此时点目录，v-html 重渲染会把平滑滚动打断、scrollTop
   * 归零——那会看起来像「跳转失效」，实际是探针自己踩了渲染中途。
   * 判据：好图已出 SVG、坏图已回退为原文、且 500ms 内不再变化。
   */
  let stable = false
  let lastSignature = ''
  for (let attempt = 0; attempt < 40 && !stable; attempt += 1) {
    await sleep(500)
    const signature = await client.evaluate(`(() => {
      const rendered = document.querySelectorAll('.at-mermaid').length
      const pending = document.querySelectorAll('pre.at-mermaid-src[data-mermaid]').length
      const headings = document.querySelectorAll('.at-doc h2').length
      const items = document.querySelectorAll('.outline__item').length
      return JSON.stringify({ rendered, pending, headings, items })
    })()`)
    stable = signature === lastSignature && JSON.parse(signature).rendered >= 1
    lastSignature = signature
  }
  log(`渲染稳定后的形态: ${lastSignature}`)

  log('--- 第一道防线：失败残留必须被清掉 ---')
  const afterRender = await client.evaluate(SNAPSHOT)
  log(JSON.stringify(afterRender))
  check(
    'mermaid 失败后没有 residue 残留',
    afterRender.residue.length === 0,
    `residue=${JSON.stringify(afterRender.residue)}`,
  )
  check(
    'body 高度没有超出视口',
    afterRender.bodyScrollHeight <= afterRender.innerHeight,
    `body=${afterRender.bodyScrollHeight} vs viewport=${afterRender.innerHeight}`,
  )
  check(
    'html 锁滚生效',
    afterRender.htmlOverflowY === 'hidden',
    `overflow-y=${afterRender.htmlOverflowY}`,
  )

  log('--- 第二道防线：body 被别的东西撑高时，页面也不许滚 ---')
  await client.evaluate(`(() => {
    const spacer = document.createElement('div')
    spacer.id = 'probe-body-spacer'
    spacer.style.height = '1200px'
    spacer.textContent = '故意撑高 body'
    document.body.appendChild(spacer)
  })()`)
  const inflated = await client.evaluate(SNAPSHOT)
  log(JSON.stringify(inflated))
  check(
    '注入 1200px 块后 body 确实被撑高了（这一步证明探针有效）',
    inflated.bodyScrollHeight > inflated.innerHeight,
    `body=${inflated.bodyScrollHeight} vs viewport=${inflated.innerHeight}`,
  )

  log('--- 第三道防线：点目录跳转，界面与顶栏都不许动 ---')
  const before = await client.evaluate(SNAPSHOT)
  /*
   * 滚动是平滑的，采样必须落在页面里逐帧观察：Node 侧 sleep 之后只读一次，
   * 万一中途被别的东西打断（比如文档重渲染把 scrollTop 归零），只看到一个
   * 末值就分不清「没滚」和「滚了又回来」。trace 让这两种情况可区分。
   */
  await client.evaluate(`(() => {
    const reader = document.querySelector('.reader')
    window.__scrollTrace = []
    reader.addEventListener('scroll', () => {
      window.__scrollTrace.push(Math.round(reader.scrollTop))
    })
  })()`)
  const clicked = await client.evaluate(`(() => {
    const items = [...document.querySelectorAll('.outline__item')]
    if (!items.length) return { clicked: false, count: 0 }
    const target = items[items.length - 3]
    const reader = document.querySelector('.reader')
    reader.dataset.probeReader = '1'
    const text = target.textContent.trim()
    /*
     * jump() 的第一道门是 getElementById。目录项不携带 id，但标题 id 是文本派生
     * 的，直接把所有 h2 的 id 抓回来比对照一下，就能判断「跳转失效」到底是不是
     * 因为标题根本不在 DOM 里（渲染中途）。
     */
    const headings = [...document.querySelectorAll('.at-doc h2')]
    const before = Math.round(reader.scrollTop)
    target.click()
    return {
      clicked: true,
      count: items.length,
      text,
      headingCount: headings.length,
      headingIdsHead: headings.slice(0, 2).map(h => h.id),
      headingIdsTail: headings.slice(-2).map(h => h.id),
      scrollTopBefore: before,
      scrollTopAfterClick: Math.round(reader.scrollTop),
    }
  })()`)
  log(`点击目录项: ${JSON.stringify(clicked)}`)
  check('目录项存在且被点中', clicked.clicked === true, `共 ${clicked.count} 项`)
  // 平滑滚动需要时间；给足 1.2s 再读数
  await sleep(1200)

  const after = await client.evaluate(SNAPSHOT)
  log(JSON.stringify(after))
  const alive = await client.evaluate(`(() => {
    const el = document.querySelector('[data-probe-reader="1"]')
    return { sameNode: Boolean(el), all: document.querySelectorAll('.reader').length }
  })()`)
  check('阅读视图没有中途重挂载（末值可信）', alive.sameNode, `当前 .reader 数量 ${alive.all}`)
  const trace = await client.evaluate(`(window.__scrollTrace || []).slice(-8)`)
  log(`容器 scrollTop 末段轨迹: ${JSON.stringify(trace)}`)

  check(
    '整页没被滚走（documentElement.scrollTop 仍为 0）',
    after.docScrollTop === 0,
    `scrollTop=${after.docScrollTop}`,
  )
  for (const item of after.chrome) {
    if (item.missing) {
      check(`顶栏存在 ${item.sel}`, false, '元素不存在')
      continue
    }
    check(
      `顶栏 ${item.sel} 仍在视口内`,
      item.top >= 0 && item.bottom <= after.innerHeight && item.bottom > item.top,
      `top=${item.top} bottom=${item.bottom} viewport=${after.innerHeight}`,
    )
  }
  check(
    '阅读容器确实滚动了（跳转有效，不是靠「什么都没做」蒙过）',
    after.readerScrollTop > (before.readerScrollTop ?? 0) + 100,
    `${before.readerScrollTop} → ${after.readerScrollTop}`,
  )
  /*
   * 第四道防线：同篇的正常图必须照常渲染。
   *
   * 清理逻辑写在 catch 里，最怕的是「顺手把成功路径也删了」——那种回归不会
   * 报错，只会让所有图变空白，而且只有打开带图的文档才看得见。
   */
  const diagramState = await client.evaluate(`(() => ({
    rendered: document.querySelectorAll('.at-mermaid').length,
    sourceLeft: document.querySelectorAll('pre.at-mermaid-src[data-mermaid]').length,
  }))()`)
  log(`图的最终状态: ${JSON.stringify(diagramState)}`)
  check(
    '同篇的正常图照常渲染成 SVG',
    diagramState.rendered === 1,
    `渲染成功 ${diagramState.rendered} 张`,
  )
  check(
    '失败的图保留原文，没有丢内容',
    diagramState.sourceLeft === 1,
    `剩余原文块 ${diagramState.sourceLeft} 个`,
  )
  client.close()
}

main()
  .catch(error => {
    log('失败:', error.message)
    process.exitCode = 1
  })
  .finally(async () => {
    cleanup()
    if (failures.length) {
      log(`\n未通过 ${failures.length} 项：${failures.join('；')}`)
      process.exitCode = 1
    } else {
      log('\n全部通过')
    }
  })
