#!/usr/bin/env node
/**
 * 探针：mermaid 全屏（灯箱）会不会被外部文件变更关掉。
 *
 * 用户报「全屏看图时偶尔自动关掉」。可疑链路有两条，现象一样、修法不同：
 *   a) 重渲染把 lightbox 的 state 冲掉（ReaderView 内部 state 丢失）；
 *   b) ReaderView 实例被**销毁重建**（`:key` 变化 / v-if 分支切换），组件整体重来。
 * 这里直接按真实操作序列测：
 *   1. 打开文档 → 点开 mermaid 全屏
 *   2. 从外部改写同一份文件（模拟 AI / git / 外部编辑器保存）
 *   3. 断言灯箱是否仍然打开
 *   4. 再测一次「切到编辑态再切回」——这条必然会销毁 ReaderView，用来区分
 *      「只有重建才关」还是「重渲染也关」
 *
 * 用法：node scripts/dev/probe-mermaid-lightbox-survive.mjs  （需先 pnpm docvi:build）
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
const TAG = `lb${Date.now().toString(36)}`
const PORT = 9800 + Math.floor(Math.random() * 90)
const DATA = mkdtempSync(join(tmpdir(), `docvi-lb-data-${TAG}-`))
const WS = mkdtempSync(join(tmpdir(), `docvi-lb-ws-${TAG}-`))
const DOC = join(WS, '灯箱探针.md')

const DOC_TEXT = `# 灯箱探针

\`\`\`mermaid
flowchart TD
  A[入口] --> B{判断}
  B -->|通过| C[完成]
  B -->|失败| D[回退]
\`\`\`

正文一段，用于制造可观测的变更差异。
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
      // 收尾失败不影响结论
    }
  }
}

/** 灯箱当前是否打开（按 DOM 上是否存在灯箱根节点判定） */
const LIGHTBOX_OPEN = `!!document.querySelector('.lightbox')`

async function main() {
  mkdirSync(WS, { recursive: true })
  writeFileSync(DOC, DOC_TEXT, 'utf8')

  child = spawn(ELECTRON, [APP_DIR, '--no-sandbox'], {
    env: {
      ...process.env,
      DOCVI_HEADLESS: '1',
      DOCVI_DATA_DIR: DATA,
      DOCVI_INSTANCE: `docvi-lb-${TAG}`,
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

  // 打开工作区 → reload → 点树行（与 probe-mermaid-lightbox 同一路径）
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
      .find(el => (el.dataset.treePath || '').endsWith('灯箱探针.md'))
    row?.click()
  })()`)
  await sleep(3500)

  const hasMermaid = await client.evaluate(`!!document.querySelector('.at-mermaid')`)
  log('mermaid 已渲染:', hasMermaid)

  if (!hasMermaid) {
    // 换个入口：从最近/工作区树点开不可行时，直接抛错让人知道探针没跑通
    throw new Error('页面里没有 mermaid 节点，探针前提不成立')
  }

  // 点全屏按钮
  const clicked = await client.evaluate(`(() => {
    const btn = document.querySelector('.at-mermaid__expand')
    if (!btn) return 'no-button'
    btn.click()
    return 'clicked'
  })()`)
  log('全屏按钮:', clicked)
  await sleep(1200)

  const openBefore = await client.evaluate(LIGHTBOX_OPEN)
  log('文件变更前 · 灯箱打开:', openBefore)

  /*
   * 场景 A：外部改写同一份文件（模拟 AI / git / 外部编辑器）。
   * 必须等到 watcher 真正把事件送达并触发重渲染，再断言。
   */
  writeFileSync(DOC, `${DOC_TEXT}\n\n外部追加的一行。\n`, 'utf8')
  await sleep(4000)
  const openAfterExternal = await client.evaluate(LIGHTBOX_OPEN)
  log('A 外部变更后 · 灯箱打开:', openAfterExternal)

  /*
   * 场景 B：切主题。`themeTick` 会触发 ReaderView 的**重渲染**（不销毁实例），
   * 是「重渲染会不会关灯箱」的第二个样本——而且换 mermaid 配色本就是常见操作。
   */
  if (openAfterExternal) {
    await client.evaluate(`(async () => {
      // 找一个与当前不同的内置主题并切换；具体 id 不重要，只要触发 themeTick
      const hosts = document.querySelectorAll('[data-theme-id]')
      const current = document.documentElement.dataset.theme
      for (const el of hosts) {
        if (el.dataset.themeId && el.dataset.themeId !== current) { el.click(); return 'switched' }
      }
      return 'no-theme-target'
    })()`)
    await sleep(2500)
    log('B 切主题后 · 灯箱打开:', await client.evaluate(LIGHTBOX_OPEN))
  }

  /*
   * 场景 C：点灯箱外部区域 / 焦点变化。灯箱模板里若有 backdrop 点击关闭，
   * 误触就会表现为「时不时自己关」。
   */
  if (await client.evaluate(LIGHTBOX_OPEN)) {
    const closedByBackdrop = await client.evaluate(`(async () => {
      const box = document.querySelector('.lightbox')
      const vp = document.querySelector('.lightbox__viewport')
      if (!box) return 'no-box'
      // 在视口边缘（空白处）派发一次真实点击
      const r = vp ? vp.getBoundingClientRect() : box.getBoundingClientRect()
      const target = document.elementFromPoint(r.left + 4, r.top + 4)
      if (!target) return 'no-target'
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + 4, clientY: r.top + 4 }))
      await new Promise(done => setTimeout(done, 600))
      return document.querySelector('.lightbox') ? 'still-open' : 'closed-by-click'
    })()`)
    log('C 点空白处:', closedByBackdrop)
  }

  /*
   * 场景 D：窗口尺寸变化（拖窗口 / 最大化 / 分屏）。灯箱不监听 resize，
   * 但父级 ReaderView 重排可能让它失位——测它是否被判为「关了」。
   */
  if (await client.evaluate(LIGHTBOX_OPEN)) {
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1024,
      height: 700,
      deviceScaleFactor: 1,
      mobile: false,
    })
    await sleep(1200)
    log('D 窗口变小后 · 灯箱打开:', await client.evaluate(LIGHTBOX_OPEN))
  }

  // 场景 E：切到编辑态再切回（必然销毁 ReaderView）
  const openBeforeEdit = await client.evaluate(LIGHTBOX_OPEN)
  await client.evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b =>
      (b.getAttribute('aria-label') || '').includes('源码') ||
      (b.textContent || '').trim() === '源码')
    btn?.click()
  })()`)
  await sleep(1500)
  log(`E 编辑态（进入前开着=${openBeforeEdit}）· 灯箱打开:`, await client.evaluate(LIGHTBOX_OPEN))

  await client.evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b =>
      (b.getAttribute('aria-label') || '').includes('阅读') ||
      (b.textContent || '').trim() === '阅读')
    btn?.click()
  })()`)
  await sleep(2500)
  const openBackAfterEdit = await client.evaluate(LIGHTBOX_OPEN)
  log('E 切回阅读 · 灯箱打开:', openBackAfterEdit)

  /*
   * 场景 C2（放在最后，因为它会真的把灯箱关掉）：打开后焦点落在关闭按钮上——
   * 按空格 / 回车就是浏览器默认的按钮激活，灯箱直接被关。
   * 这正是「时不时自动关」的真实原因：用户在图上按空格、或用键盘导航时误触。
   * 合成 KeyboardEvent 不触发浏览器默认激活行为，所以直接对焦点元素 click，
   * 这正是空格按下后浏览器做的事。
   */
  // 重新打开一次（E 段回来时灯箱已关）
  await client.evaluate(`(() => {
    document.querySelector('.at-mermaid__expand')?.click()
  })()`)
  await sleep(1200)
  let focusVerdict = 'not-tested'
  if (await client.evaluate(LIGHTBOX_OPEN)) {
    const focusInfo = await client.evaluate(`(() => {
      const el = document.activeElement
      return { tag: el?.tagName ?? null, cls: el?.className ?? null, label: el?.getAttribute?.('aria-label') ?? null }
    })()`)
    log('C2 打开后的焦点:', JSON.stringify(focusInfo))
    focusVerdict = await client.evaluate(`(async () => {
      const el = document.activeElement
      if (!el) return 'no-focus'
      el.click()
      await new Promise(done => setTimeout(done, 500))
      return document.querySelector('.lightbox') ? 'still-open' : 'closed-by-activate'
    })()`)
    log('C2 激活焦点元素:', focusVerdict)
  }

  /*
   * 结论判定按「哪一条会关」输出，而不是只报文件变更那一条——
   * 这个探针的价值就在于把「看起来像文件变更」的误判拆开。
   */
  const results = []
  if (!openBefore) results.push('灯箱没有成功打开，结论不可用')
  else {
    results.push(openAfterExternal ? '✓ 外部改盘不关' : '❗ 外部改盘会关')
    if (focusVerdict === 'closed-by-activate') {
      results.push('❗ 焦点在可激活元素上，空格/回车会误关（回归）')
    } else if (focusVerdict === 'still-open') {
      results.push('✓ 空格/回车不误关（焦点在容器上）')
    }
    results.push(
      openBeforeEdit && !openBackAfterEdit
        ? '· 切编辑态会销毁阅读视图（预期行为）'
        : '· 切编辑态未销毁阅读视图',
    )
  }
  log('结论:', results.join(' ｜ '))

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
