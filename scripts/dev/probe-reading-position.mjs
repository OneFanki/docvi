#!/usr/bin/env node
/**
 * 阅读位置保持的验证：滚到中部 → 切到设置标签 → 切回文档 → 位置还在吗？
 *
 * 这里守的是三条会静默失效的路径：
 *  1. 打开设置页走 `tabs.openPage`，它直接 activate、不经过 `activateTab`。
 *     曾经因此漏掉「离开前保存」，只切一下设置回来文档就回顶。
 *  2. 恢复用像素值时，字体/宽度一改排版高度就变，同一像素指向别的内容；
 *     新排版更短还会被 clamp 到顶部。必须按源行恢复。
 *  3. 重渲染（高亮、mermaid、主题）后会再发一次 `rendered`，若它用旧记忆
 *     强行落位，用户正在看的位置会被拽走。
 *
 * 判据不看「scrollTop 是否相同」（排版变了它本来就该变），而是看
 * **视口顶部那一块内容的源行是否相同**——那才是用户眼里的「我还在原地」。
 *
 * 用法：node scripts/dev/probe-reading-position.mjs  （需先 pnpm docvi:build）
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
const TAG = `rp${Date.now().toString(36)}`
const PORT = 9300 + Math.floor(Math.random() * 90)
const DATA = mkdtempSync(join(tmpdir(), `docvi-rp-data-${TAG}-`))
const WS = mkdtempSync(join(tmpdir(), `docvi-rp-ws-${TAG}-`))
const OUT = join(ROOT, '.temp/reading-position')
mkdirSync(OUT, { recursive: true })

/* 长文档：必须足够长，滚到中部才不会被 clamp */
const DOC = `# 阅读位置保持

${Array.from(
  { length: 40 },
  (_, index) => `## 第 ${index + 1} 节

这是第 ${index + 1} 节的正文，用来把文档撑到足够长，这样滚到中间时
才有真实的滚动空间。段落里放一些英文 canonical version 2026 与数字
0123456789，顺便验证等宽字体下的排版。

- 列表项 A${index + 1}
- 列表项 B${index + 1}
`,
).join('\n')}
`

/*
 * 容差 8 行。
 *
 * `scrollToSourceLine` 取「起始行 ≤ 目标行」的最后一个块，块边界与视口顶部
 * 不会严丝合缝：一个 6 行的段落滚到中间时，顶部块可能是段首（差 5 行）。
 * 这不是「位置丢了」——用户看到的是同一段内容。真正的丢失是回顶（源行
 * 变成 1）或 null（画布上根本没有文档）。
 */
const TOLERANCE = 8

let child = null
const log = (...args) => console.log('[pos]', ...args)

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

/**
 * 读「视口顶部那一块的源行」。
 *
 * 这是用户视角的坐标：不管排版高度怎么变，只要顶部还是同一节内容，
 * 用户就会认为「位置没变」。
 */
const TOP_LINE = `(() => {
  const scroller = document.querySelector('.reader')
  const surface = document.querySelector('.at-doc')
  if (!scroller || !surface) return null
  const base = scroller.getBoundingClientRect().top
  let best = null
  let bestTop = -Infinity
  for (const block of surface.querySelectorAll('[data-source-line]')) {
    const rect = block.getBoundingClientRect()
    const top = rect.top - base
    /* 取「顶部在视口内且最靠近上边缘」的那块 */
    if (top <= 2 && top > bestTop) {
      bestTop = top
      best = Number(block.dataset.sourceLine)
    }
  }
  if (best === null) {
    /* 还没滚过第一块：退化成第一个可见块 */
    for (const block of surface.querySelectorAll('[data-source-line]')) {
      const rect = block.getBoundingClientRect()
      if (rect.bottom - base > 0) return Number(block.dataset.sourceLine)
    }
  }
  return best
})()`

const SCROLL_TOP = `(() => {
  const el = document.querySelector('.reader')
  return el ? Math.round(el.scrollTop) : null
})()`

async function main() {
  writeFileSync(join(WS, '阅读位置保持.md'), DOC, 'utf8')

  child = spawn(ELECTRON, [APP_DIR, '--no-sandbox'], {
    env: {
      ...process.env,
      DOCVI_HEADLESS: '1',
      DOCVI_DATA_DIR: DATA,
      DOCVI_INSTANCE: `docvi-rp-${TAG}`,
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
    width: 1100,
    height: 700,
    deviceScaleFactor: 2,
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
      .find(el => (el.dataset.treePath || '').endsWith('阅读位置保持.md'))?.click()
  })()`)
  await sleep(4500)

  const verdict = []
  const bad = []

  /** 滚到中部并确认真的滚动了 */
  async function scrollToMiddle() {
    const info = await client.evaluate(`(() => {
      const el = document.querySelector('.reader')
      if (!el) return null
      const range = el.scrollHeight - el.clientHeight
      if (range < 500) return { error: '文档太短，没有滚动空间: ' + range }
      el.scrollTop = Math.round(range * 0.5)
      return { range, applied: el.scrollTop }
    })()`)
    await sleep(500)
    return info
  }

  /* ---------- 基线：滚到中部 ---------- */
  const scrolled = await scrollToMiddle()
  if (scrolled?.error) throw new Error(scrolled.error)
  const lineBefore = await client.evaluate(TOP_LINE)
  const topBefore = await client.evaluate(SCROLL_TOP)
  log(`滚到中部: scrollTop=${topBefore}（可滚 ${scrolled.range}），顶部源行=${lineBefore}`)
  if (!lineBefore || lineBefore <= 1) bad.push(`基线就落在文档开头（源行 ${lineBefore}），用例无效`)

  /* ---------- 路径 1：切到设置标签再切回 ---------- */
  await client.evaluate(`(() => {
    /* 命令面板：打开设置 */
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'k', ctrlKey: true, bubbles: true, cancelable: true,
    }))
  })()`)
  await sleep(700)
  await client.evaluate(`(() => {
    const input = document.querySelector('.palette__input')
    if (!input) return
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, '设置')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await sleep(700)
  const openedSettings = await client.evaluate(`(() => {
    const item = [...document.querySelectorAll('.palette__item-title')]
      .find(el => (el.textContent || '').trim() === '打开设置')
    item?.closest('.palette__item')?.click()
    return Boolean(item)
  })()`)
  await sleep(1500)
  if (!openedSettings) throw new Error('没能打开设置页')
  log('已切到设置标签')

  /*
   * 切回文档标签：按**文档名**匹配。
   *
   * 两个坑：标签条最左边钉着一个「文档库」标签（既不是设置也不是插件，
   * 按「排除法」会误选它）；标签显示的是文档名而不是工作区目录名。
   */
  const back = await client.evaluate(`(() => {
    const tabs = [...document.querySelectorAll('.tab')]
    const doc = tabs.find(el => (el.textContent || '').includes('阅读位置保持'))
    if (!doc) {
      return { error: '找不到文档标签', labels: tabs.map(el => (el.textContent || '').trim()) }
    }
    doc.click()
    return { ok: true, label: (doc.textContent || '').trim() }
  })()`)
  if (back?.error) {
    throw new Error(`${back.error}：${JSON.stringify(back.labels)}`)
  }
  log(`切回标签: ${back.label}`)
  await sleep(3500)

  const lineAfterTab = await client.evaluate(TOP_LINE)
  const topAfterTab = await client.evaluate(SCROLL_TOP)
  log(`切回后: scrollTop=${topAfterTab}，顶部源行=${lineAfterTab}`)
  const tabOk = lineAfterTab !== null && Math.abs(lineAfterTab - lineBefore) <= TOLERANCE
  verdict.push(
    tabOk
      ? `✓ 切标签后仍在同一处（源行 ${lineBefore} → ${lineAfterTab}）`
      : `❗ 切标签后位置丢失（源行 ${lineBefore} → ${lineAfterTab}）`,
  )
  if (!tabOk) bad.push('切标签回顶')

  /* ---------- 路径 2：切标签后再改字体，位置也不该变 ---------- */
  await client.evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')]
      .find(b => (b.getAttribute('aria-label') || '').includes('英数等宽'))
    btn?.click()
  })()`)
  await sleep(1200)
  const lineAfterFont = await client.evaluate(TOP_LINE)
  log(`切换英数等宽后: 顶部源行=${lineAfterFont}`)
  const fontOk = lineAfterFont !== null && Math.abs(lineAfterFont - lineBefore) <= TOLERANCE
  verdict.push(
    fontOk
      ? `✓ 改字体不影响位置（源行 ${lineBefore} → ${lineAfterFont}）`
      : `❗ 改字体后位置丢了（源行 ${lineBefore} → ${lineAfterFont}）`,
  )
  if (!fontOk) bad.push('改字体后位置变了')

  /* ---------- 路径 3：再切一次标签，确认稳定可重入 ---------- */
  await client.evaluate(`(() => {
    const tabs = [...document.querySelectorAll('.tab')]
    tabs.find(el => /设置/.test(el.textContent || ''))?.click()
  })()`)
  await sleep(1200)
  await client.evaluate(`(() => {
    const tabs = [...document.querySelectorAll('.tab')]
    tabs.find(el => (el.textContent || '').includes('阅读位置保持'))?.click()
  })()`)
  await sleep(3500)
  const lineAgain = await client.evaluate(TOP_LINE)
  log(`再切一次后: 顶部源行=${lineAgain}`)
  const againOk = lineAgain !== null && Math.abs(lineAgain - lineBefore) <= TOLERANCE
  verdict.push(
    againOk
      ? `✓ 反复切换位置稳定（源行 ${lineAgain}）`
      : `❗ 反复切换后位置漂移（源行 ${lineBefore} → ${lineAgain}）`,
  )
  if (!againOk) bad.push('反复切换后漂移')

  /*
   * 对照组：把滚动条拨到顶，验证这套判据真能抓到「回顶」。
   *
   * 没有这一组，三条全绿也可能只是测量方法失效（比如 TOP_LINE 恒返回某个
   * 非 null 值），那时页面在哪都会「通过」。
   */
  await client.evaluate(`(() => {
    const el = document.querySelector('.reader')
    if (el) el.scrollTop = 0
  })()`)
  await sleep(600)
  const lineAtTop = await client.evaluate(TOP_LINE)
  const controlOk = lineAtTop !== null && lineAtTop <= 2
  verdict.push(
    controlOk
      ? `✓ 对照组区分成立（拨到顶后源行=${lineAtTop}，与 ${lineBefore} 明显不同）`
      : `❗ 对照组失效：拨到顶仍是源行 ${lineAtTop}，本探针分不出位置`,
  )
  if (!controlOk) bad.push('对照组失效，本次判定不成立')

  log('结论:')
  for (const line of verdict) log(' ', line)
  if (bad.length) {
    log('❗ 失败:', bad.join('；'))
    process.exitCode = 1
  }
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
