#!/usr/bin/env node
/**
 * 英数等宽开关的验证。
 *
 * 判据不是「CSS 变量变了」，而是**正文里的英文数字实际用上了等宽字体**：
 * 用 CDP 的 CSS.getPlatformFontsForNode 问浏览器真实选中的字体族。
 *
 * 三件事一起验：
 *  1. 默认开启：正文英文 → JetBrains Mono，汉字 → 鸿蒙
 *  2. 关闭后：正文英文 → 鸿蒙（或系统无衬线），不再是等宽
 *  3. 关闭后代码块不受影响：仍然 JetBrains 管英文
 *
 * 用法：node scripts/dev/probe-mono-latin.mjs  （需先 pnpm docvi:build）
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
const TAG = `ml${Date.now().toString(36)}`
const PORT = 9200 + Math.floor(Math.random() * 90)
const DATA = mkdtempSync(join(tmpdir(), `docvi-ml-data-${TAG}-`))
const WS = mkdtempSync(join(tmpdir(), `docvi-ml-ws-${TAG}-`))

const DOC = `# 英数等宽验证

正文里的英文：canonical version 2026 numbers 0123456789。

中文与英文混排：这是 HarmonyOS 与 JetBrains 的对照。

| 列一 | 列二 |
| --- | --- |
| canonical | 2026-11-13 |

\`\`\`ts
const message = 'code stays monospaced'
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

async function main() {
  mkdirSync(WS, { recursive: true })
  writeFileSync(join(WS, '英数等宽.md'), DOC, 'utf8')

  child = spawn(ELECTRON, [APP_DIR, '--no-sandbox'], {
    env: {
      ...process.env,
      DOCVI_HEADLESS: '1',
      DOCVI_DATA_DIR: DATA,
      DOCVI_INSTANCE: `docvi-ml-${TAG}`,
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
  await client.evaluate(`window.docvi.workspaceAddAt(${JSON.stringify(WS)}).then(r => r)`)
  await client.evaluate('location.reload()')
  await sleep(3200)
  await client.evaluate(`(() => {
    [...document.querySelectorAll('.card')]
      .find(el => (el.textContent || '').includes(${JSON.stringify(WS)}))?.click()
  })()`)
  await sleep(2500)
  await client.evaluate(`(() => {
    [...document.querySelectorAll('[data-tree-path]')]
      .find(el => (el.dataset.treePath || '').endsWith('英数等宽.md'))?.click()
  })()`)
  await sleep(4500)

  await client.send('DOM.enable')
  await client.send('CSS.enable')
  const doc = await client.send('DOM.getDocument', { depth: -1 })
  const rootId = doc?.root?.nodeId

  /** 取某选择器的真实字体族 */
  async function realFonts(selector) {
    const ok = await client.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) return false
      /* 滚进视口：未渲染的节点 CSS.getPlatformFontsForNode 会返回空数组 */
      el.scrollIntoView({ block: 'center' })
      el.setAttribute('data-ml-probe', '1')
      return true
    })()`)
    if (!ok) return { error: '元素不存在' }
    await sleep(320)
    const found = await client.send('DOM.querySelector', {
      nodeId: rootId,
      selector: '[data-ml-probe="1"]',
    })
    let fonts = []
    if (found?.nodeId) {
      const result = await client.send('CSS.getPlatformFontsForNode', { nodeId: found.nodeId })
      fonts = (result?.fonts ?? []).map(item => `${item.familyName}×${item.glyphCount}`)
    }
    const css = await client.evaluate(`
      getComputedStyle(document.querySelector('[data-ml-probe="1"]')).fontFamily
    `)
    /*
     * 需要 box 才知道节点在不在视口里。
     *
     * CSS.getPlatformFontsForNode 对**未渲染**的节点返回空数组——不是「字体没
     * 生效」，而是「这个节点压根没画出来」。代码块在视口外时就属于这种，所以
     * 取不到 glyph 时要先区分这两件事，否则会误判成 bug。
     */
    const rendered = await client.evaluate(`(() => {
      const el = document.querySelector('[data-ml-probe="1"]')
      if (!el) return false
      const rect = el.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    })()`)
    await client.evaluate(
      `document.querySelector('[data-ml-probe="1"]')?.removeAttribute('data-ml-probe')`,
    )
    return { fonts, css, rendered }
  }

  /**
   * 等宽的行为判据：i 与 W 的**推进宽度相等**。
   *
   * 为什么不用 CSS.getPlatformFontsForNode 判断代码块：代码块里的文字被高亮拆成
   * 一层层 span，`pre` / `code` 自身没有直接文本节点，CDP 就返回空数组——这是
   * 测量盲区，不是字体没生效。改测最本质的性质：等宽字体里 `iiiiiiiiii` 与
   * `WWWWWWWWWW` 的渲染宽度必须一模一样。
   */
  async function isMonospace(selector) {
    return client.evaluate(`(() => {
      const host = document.querySelector(${JSON.stringify(selector)})
      if (!host) return { error: '元素不存在' }
      const probe = document.createElement('span')
      /* 只继承字体，不继承高亮前缀等装饰；字体族取宿主计算值 */
      probe.style.font = getComputedStyle(host).font
      probe.style.whiteSpace = 'pre'
      probe.style.position = 'absolute'
      probe.style.visibility = 'hidden'
      host.appendChild(probe)
      const measure = text => {
        probe.textContent = text
        return probe.getBoundingClientRect().width
      }
      const narrow = measure('iiiiiiiiii')
      const wide = measure('WWWWWWWWWW')
      const family = getComputedStyle(probe).fontFamily
      probe.remove()
      return { narrow, wide, delta: Math.abs(narrow - wide), family }
    })()`)
  }

  const verdict = []

  /**
   * 对照组：强制用无衬线字体量同样的两个字串，**必须**得到不等的宽度。
   *
   * 没有这一组，下面「i/W 等宽」全绿也可能是测量方法本身坏掉（比如字体没加载、
   * 量到 0 宽、span 被样式压扁），那时任何元素都会「通过」。
   */
  const control = await client.evaluate(`(() => {
    const probe = document.createElement('span')
    probe.style.font = '16px sans-serif'
    probe.style.whiteSpace = 'pre'
    probe.style.position = 'absolute'
    probe.style.visibility = 'hidden'
    document.body.appendChild(probe)
    const measure = text => {
      probe.textContent = text
      return probe.getBoundingClientRect().width
    }
    const narrow = measure('iiiiiiiiii')
    const wide = measure('WWWWWWWWWW')
    const family = getComputedStyle(probe).fontFamily
    probe.remove()
    return { narrow, wide, delta: Math.abs(narrow - wide), family }
  })()`)
  log('对照组 无衬线:', JSON.stringify(control))
  verdict.push(
    (control.delta ?? 0) > 1
      ? `✓ 对照组区分成立（sans-serif i=${control.narrow}px ≠ W=${control.wide}px）`
      : `❗ 测量方法失效：sans-serif 下 i/W 宽度也相同（${control.delta}px），本次所有「等宽」判定无效`,
  )

  /* ---------- 默认（开启） ---------- */
  const attrDefault = await client.evaluate(
    `document.documentElement.dataset.monoLatin ?? '(none)'`,
  )
  const bodyOn = await realFonts('.doc-surface p')
  const codeOn = await isMonospace('.doc-surface [class*="language-"] pre')
  log('默认 data-mono-latin:', attrDefault)
  log('默认 正文:', JSON.stringify(bodyOn))
  log('默认 代码块:', JSON.stringify(codeOn))

  const bodyHasJetBrains = (bodyOn.fonts ?? []).some(item => /JetBrains/.test(item))
  verdict.push(
    bodyHasJetBrains
      ? `✓ 正文英文走等宽（${(bodyOn.fonts ?? []).join(', ')}）`
      : `❗ 正文英文没用等宽（${(bodyOn.fonts ?? []).join(', ')}）`,
  )
  verdict.push(
    attrDefault === '(none)'
      ? '✓ 默认态无 data-mono-latin 属性（缺失 = 开启）'
      : `❗ 默认带了属性 ${attrDefault}`,
  )
  const codeOnMonospace = (codeOn.delta ?? Infinity) < 0.5
  verdict.push(
    codeOnMonospace
      ? `✓ 代码块是等宽（i=${codeOn.narrow}px, W=${codeOn.wide}px）`
      : `❗ 代码块不是等宽（i=${codeOn.narrow}px, W=${codeOn.wide}px）`,
  )

  /* ---------- 关闭 ---------- */
  await client.evaluate(`document.documentElement.dataset.monoLatin = 'off'`)
  await sleep(700)
  const bodyOff = await realFonts('.doc-surface p')
  const codeOff = await isMonospace('.doc-surface [class*="language-"] pre')
  log('关闭后 正文:', JSON.stringify(bodyOff))
  log('关闭后 代码块:', JSON.stringify(codeOff))

  const bodyOffHasJetBrains = (bodyOff.fonts ?? []).some(item => /JetBrains/.test(item))
  verdict.push(
    !bodyOffHasJetBrains
      ? `✓ 关闭后正文不再用等宽（${(bodyOff.fonts ?? []).join(', ')}）`
      : `❗ 关闭后正文仍在用等宽（${(bodyOff.fonts ?? []).join(', ')}）`,
  )

  const codeOffMonospace = (codeOff.delta ?? Infinity) < 0.5
  verdict.push(
    codeOffMonospace
      ? `✓ 关闭后代码块仍是等宽（i=${codeOff.narrow}px, W=${codeOff.wide}px）`
      : `❗ 关闭后代码块失去了等宽（i=${codeOff.narrow}px, W=${codeOff.wide}px）`,
  )

  /* ---------- 恢复默认，确认可逆 ---------- */
  await client.evaluate(`delete document.documentElement.dataset.monoLatin`)
  await sleep(700)
  const bodyBack = await realFonts('.doc-surface p')
  const backHasJetBrains = (bodyBack.fonts ?? []).some(item => /JetBrains/.test(item))
  verdict.push(backHasJetBrains ? '✓ 重新开启后恢复等宽（可逆）' : '❗ 重新开启后没恢复等宽')

  log('结论:')
  for (const line of verdict) log(' ', line)
  if (verdict.some(line => line.startsWith('❗'))) process.exitCode = 1

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
