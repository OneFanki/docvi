#!/usr/bin/env node
/**
 * 一次性探针：状态栏在窄窗口下的三个布局要求 + 关于页的更新入口。
 *
 * 用户报的四个问题，逐条断死：
 *  1. 底部小窗口下会乱 → 路径**尾部优先**显示，前面省略；
 *  2. hover 后要能看到完整路径；
 *  3. 宽度还不够时，按钮区出现横向滚动条，且**滚动条不能影响布局**
 *     （状态栏高度不变、也不推动上方内容）；
 *  4. 点渲染模式时，模式按钮不能因为「折行」按钮冒出来而被往左挤。
 *
 * 用法：node scripts/dev/probe-statusbar.mjs   （需先 pnpm docvi:build）
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
const TAG = `probe${Date.now().toString(36)}`
const PORT = 9900 + Math.floor(Math.random() * 90)
const DATA = mkdtempSync(join(tmpdir(), `docvi-probe-data-${TAG}-`))
const WS = mkdtempSync(join(tmpdir(), `docvi-probe-ws-${TAG}-`))

/** 刻意做一条很深的路径：窄窗口下必然放不下 */
const DEEP_DIR = join(WS, '一级目录', '二级目录', '三级目录', '四级目录')
const DOC = join(DEEP_DIR, '状态栏探针文档.md')

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

const STATUS_GEOMETRY = `(() => {
  const bar = document.querySelector('.status')
  if (!bar) return { ok: false, reason: '状态栏不存在' }
  const controls = bar.querySelector('.status__controls')
  const pathEl = bar.querySelector('.status__item--path')
  const barRect = bar.getBoundingClientRect()
  const controlsRect = controls?.getBoundingClientRect()
  return {
    ok: true,
    barHeight: Math.round(barRect.height),
    barTop: Math.round(barRect.top),
    pathText: (pathEl?.textContent || '').trim(),
    pathWidth: pathEl ? Math.round(pathEl.getBoundingClientRect().width) : 0,
    pathScrollWidth: pathEl?.scrollWidth ?? 0,
    controlsScrollWidth: controls?.scrollWidth ?? 0,
    controlsClientWidth: controls?.clientWidth ?? 0,
    controlsHeight: controlsRect ? Math.round(controlsRect.height) : 0,
    hasOverflow: controls?.classList.contains('has-overflow') ?? false,
    // 按钮的右边缘位置：用来判断「模式按钮有没有被往左挤」
    buttons: [...(controls?.querySelectorAll('.status__btn, .status__service') ?? [])].map(b => {
      const r = b.getBoundingClientRect()
      return {
        label: (b.textContent || '').trim().slice(0, 8),
        left: Math.round(r.left),
        right: Math.round(r.right),
      }
    }),
  }
})()`

/** 悬停提示：v-tooltip 用 title 属性还是自绘？两种都收 */
const TOOLTIP_TEXT = `(() => {
  const pathEl = document.querySelector('.status__item--path')
  if (!pathEl) return null
  return pathEl.getAttribute('title') || pathEl.getAttribute('aria-label') || null
})()`

async function main() {
  mkdirSync(DEEP_DIR, { recursive: true })
  writeFileSync(DOC, '# 状态栏探针\n\n用于验证底部状态栏的窄窗口布局。\n', 'utf8')

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
  // 窄窗口：1440 下不一定触发滚动，880 是应用的最小宽度
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: 900,
    height: 800,
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
  await client.evaluate(`(() => {
    const cards = [...document.querySelectorAll('.card')]
    cards.find(el => (el.textContent || '').includes(${JSON.stringify(WS)}))?.click()
  })()`)
  await sleep(3000)
  await client.evaluate(`(() => {
    const row = [...document.querySelectorAll('[data-tree-path]')]
      .find(el => (el.dataset.treePath || '').endsWith('状态栏探针文档.md'))
    row?.click()
  })()`)
  await sleep(2800)

  /* ---------- 1. 路径尾部优先 ---------- */

  const narrow = await client.evaluate(STATUS_GEOMETRY)
  log('窄窗口状态栏：', JSON.stringify(narrow))
  if (!narrow?.ok) throw new Error(narrow?.reason ?? '状态栏缺失')
  const expectedTail = '状态栏探针文档.md'
  if (!narrow.pathText.endsWith(expectedTail)) {
    throw new Error(`路径尾部应保留文件名「${expectedTail}」，实际显示「${narrow.pathText}」`)
  }
  if (!narrow.pathText.startsWith('…')) {
    throw new Error(`长路径在窄窗口应省略前部，实际「${narrow.pathText}」`)
  }
  log('路径尾部优先通过：', narrow.pathText)

  /* ---------- 2. hover 显示完整路径 ---------- */

  const tooltip = await client.evaluate(TOOLTIP_TEXT)
  log('路径提示：', JSON.stringify(tooltip))
  if (!tooltip || !tooltip.includes(expectedTail)) {
    throw new Error(`hover 提示应包含完整路径，实际 ${JSON.stringify(tooltip)}`)
  }
  // 完整路径必须真的完整（含深层目录），否则截断就成了「信息丢失」而不是「延后展示」
  if (!tooltip.includes('四级目录')) throw new Error(`提示里缺少目录信息：${tooltip}`)

  /* ---------- 3. 滚动条不影响布局 ---------- */

  const beforeHeight = narrow.barHeight
  await client.evaluate(`(() => {
    const el = document.querySelector('.status__controls')
    if (!el) return
    // 模拟 hover：::hover 伪类不能靠 JS 触发，但滚动条是否**占位**与 hover 无关
    el.scrollLeft = 0
  })()`)
  await sleep(300)
  const afterHeight = (await client.evaluate(STATUS_GEOMETRY)).barHeight
  if (afterHeight !== beforeHeight) {
    throw new Error(`滚动操作改变了状态栏高度：${beforeHeight} → ${afterHeight}`)
  }
  /*
   * 滚动条「不占布局」的判据：控件区高度必须等于状态栏内容高度，
   * 而不是「内容高度 + 滚动条」。3px 的滚动条若参与布局，会表现为高度多出 3px
   * 或状态栏被撑高。
   */
  if (narrow.controlsHeight > narrow.barHeight) {
    throw new Error(
      `控件区（${narrow.controlsHeight}px）比状态栏（${narrow.barHeight}px）还高，滚动条占了布局`,
    )
  }
  log('滚动不影响布局通过：状态栏', beforeHeight, 'px，控件区', narrow.controlsHeight, 'px')

  /* ---------- 4. 切模式时按钮不位移 ---------- */

  /** 记录模式按钮的 right 值（右边缘），作为「有没有被挤」的判据 */
  const readModeButtons = `(() => {
    const labels = ['阅读', '实时预览', '源码', '分屏']
    const out = {}
    for (const btn of document.querySelectorAll('.status__btn')) {
      const text = (btn.textContent || '').trim()
      if (labels.includes(text)) out[text] = Math.round(btn.getBoundingClientRect().right)
    }
    return out
  })()`

  const inRead = await client.evaluate(readModeButtons)
  log('阅读态模式按钮右缘：', JSON.stringify(inRead))

  // 切到源码模式：折行按钮会冒出来
  const clicked = await client.evaluate(`(() => {
    const btn = [...document.querySelectorAll('.status__btn')]
      .find(b => (b.textContent || '').trim() === '源码')
    if (!btn) return { ok: false, labels: [...document.querySelectorAll('.status__btn')].map(b => (b.textContent||'').trim()) }
    btn.click()
    return { ok: true }
  })()`)
  if (!clicked?.ok) throw new Error(`点不到源码按钮：${JSON.stringify(clicked?.labels ?? [])}`)
  await sleep(2200)

  const inSource = await client.evaluate(readModeButtons)
  log('源码态模式按钮右缘：', JSON.stringify(inSource))
  const wrapVisible = await client.evaluate(`(() => {
    return [...document.querySelectorAll('.status__btn')]
      .some(b => ['折行', '不折行', '换行', '不换行'].some(k => (b.textContent || '').includes(k)))
  })()`)
  log('源码态折行按钮出现：', wrapVisible)
  if (!wrapVisible) throw new Error('源码态应出现折行按钮')

  /*
   * 核心断言：折行按钮出现后，**模式按钮的右边缘不变**。
   *
   * 这就是用户报的「点了渲染模式，结果渲染模式那些按钮都被往左挤了一部分」：
   * 折行按钮插在模式按钮右侧，把它左边的所有按钮整体推走。
   */
  for (const [label, right] of Object.entries(inRead)) {
    const after = inSource[label]
    if (after === undefined) continue
    if (Math.abs(after - right) > 1) {
      throw new Error(
        `「${label}」按钮被挤动了：right ${right} → ${after}（折行按钮不应插在模式按钮右侧）`,
      )
    }
  }
  log('按钮不位移通过：切模式前后模式按钮右缘一致')

  /* ---------- 4b. 极窄窗口：真的溢出时滚动条出现且仍不占布局 ---------- */

  await client.send('Emulation.setDeviceMetricsOverride', {
    width: 640,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await sleep(1200)
  const extreme = await client.evaluate(STATUS_GEOMETRY)
  log('极窄窗口：', JSON.stringify(extreme))
  if (!extreme.hasOverflow) {
    throw new Error('640px 下控件区应溢出（说明滚动逻辑没生效或按钮太少）')
  }
  // 溢出后状态栏高度必须**完全不变**：这是「滚动条不影响布局」的硬判据
  if (extreme.barHeight !== beforeHeight) {
    throw new Error(`溢出后状态栏高度变了：${beforeHeight} → ${extreme.barHeight}`)
  }
  if (extreme.controlsHeight > beforeHeight) {
    throw new Error(`溢出后控件区（${extreme.controlsHeight}px）超过状态栏高度`)
  }
  const thumb = await client.evaluate(`(() => {
    const el = document.querySelector('.status__thumb')
    if (!el) return { exists: false }
    const style = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    return {
      exists: true,
      position: style.position,
      opacity: style.opacity,
      width: Math.round(r.width),
      height: Math.round(r.height),
      pointerEvents: style.pointerEvents,
    }
  })()`)
  log('悬浮滚动条：', JSON.stringify(thumb))
  if (!thumb.exists) throw new Error('溢出时应出现悬浮滚动指示条')
  if (thumb.position !== 'absolute') {
    throw new Error(`滚动条必须绝对定位（不参与布局），实际 ${thumb.position}`)
  }
  // 平时不可见：opacity 0（hover 才 0.45）
  if (Number(thumb.opacity) > 0.01) {
    throw new Error(`未 hover 时滚动条应隐藏，实际 opacity=${thumb.opacity}`)
  }
  if (thumb.height > 3) throw new Error(`滚动条高度 ${thumb.height}px 过大会抢视觉`)

  // 恢复宽度做后续检查
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: 900,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await sleep(900)

  /* ---------- 5. 关于页有 GitHub 地址与更新入口 ---------- */

  await client.evaluate(`(() => {
    const btn = [...document.querySelectorAll('.titlebar__icon')]
      .find(b => (b.getAttribute('aria-label') || '').includes('设置'))
    btn?.click()
  })()`)
  await sleep(2000)
  await client.evaluate(`(() => {
    const btn = [...document.querySelectorAll('.settings__nav-btn')]
      .find(b => (b.textContent || '').trim() === '关于')
    btn?.click()
  })()`)
  await sleep(1800)

  const aboutPanel = await client.evaluate(`(() => {
    const link = document.querySelector('.about__link')
    const checkBtn = [...document.querySelectorAll('button')]
      .find(b => (b.textContent || '').includes('检查更新'))
    return {
      hasHomepageLink: Boolean(link),
      homepageText: link ? (link.textContent || '').trim() : null,
      hasCheckButton: Boolean(checkBtn),
      version: [...document.querySelectorAll('.row')]
        .map(r => (r.textContent || '').replace(/\\s+/g, ' ').trim())
        .find(t => t.startsWith('版本') || t.startsWith('Version')) ?? null,
    }
  })()`)
  log('关于页：', JSON.stringify(aboutPanel))
  if (!aboutPanel?.hasHomepageLink) throw new Error('关于页没有项目主页入口')
  if (!aboutPanel.homepageText?.includes('github.com')) {
    throw new Error(`项目主页应指向 GitHub，实际 ${aboutPanel.homepageText}`)
  }
  if (!aboutPanel.hasCheckButton) throw new Error('关于页没有检查更新按钮')

  const shot = await client.send('Page.captureScreenshot', { format: 'png' })
  mkdirSync(join(ROOT, '.temp'), { recursive: true })
  writeFileSync(join(ROOT, '.temp', 'about-update.png'), Buffer.from(shot.data, 'base64'))

  log('全部断言通过')
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
