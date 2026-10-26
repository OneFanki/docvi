#!/usr/bin/env node
/**
 * 容器版（web 宿主）验收截图：headless Edge + CDP 直连。
 *
 * 用法：node scripts/dev/web-shot.mjs [url] [outDir] [--tag=xxx]
 *
 * **清理是硬要求**（2026-10-24 踩过）：
 * 之前的版本只 `child.kill()` 杀 Edge 主进程。Windows 上浏览器进程会派生
 * crashpad-handler / gpu / utility / renderer 一串子进程，主进程被杀后子进程
 * 不一定跟着退；每个残留实例还会在 %TEMP% 留下一个约 380MB 的 profile
 * （Code Cache + GPUCache）。连续跑十几次就攒出了 18 个目录、6.9GB 磁盘，
 * 叠上同时进行的 vite 构建直接把整机拖到鼠标都不动。
 *
 * 因此这里的收尾顺序固定为：
 *   1. 关 CDP target；
 *   2. `taskkill /PID <主进程> /T /F`——`/T` 连整棵子树一起杀；
 *   3. 删掉本次专用 profile 目录；
 *   4. 复查：目录不存在才算收尾完成。
 * 断言失败不影响退出，但会在输出里明确报出来。
 *
 * 端口与 profile 都按随机 tag 生成：串到残留实例上会拍到上一次的页面，
 * 这类假失败比真实缺陷更浪费时间（也踩过）。
 */
import { existsSync } from 'node:fs'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
]

const url = process.argv[2] ?? 'http://127.0.0.1:5321/'
const outDir = resolve(process.argv[3] ?? '.temp/web-shot')
const tagArg = process.argv.find(arg => arg.startsWith('--tag='))
const TAG = tagArg ? tagArg.slice(6) : `web${Date.now().toString(36)}`
const PORT = 9400 + Math.floor(Math.random() * 500)
const PROFILE = join(process.env.TEMP ?? '.', `docvi-shot-${TAG}`)

const edge = EDGE_CANDIDATES.find(candidate => existsSync(candidate))
if (!edge) {
  console.error('找不到 Edge。可用的浏览器路径写进 EDGE_CANDIDATES。')
  process.exit(1)
}

mkdirSync(outDir, { recursive: true })
const pageLog = join(outDir, 'page.log')
function log(...parts) {
  const line = parts.map(part => (typeof part === 'string' ? part : JSON.stringify(part))).join(' ')
  process.stdout.write(`${line}\n`)
  writeFileSync(pageLog, `${line}\n`, { flag: 'a' })
}

const child = spawn(
  edge,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--window-size=1440,960',
    '--remote-allow-origins=*',
    'about:blank',
  ],
  { stdio: 'ignore' },
)

let ws = null
let seq = 0
const pending = new Map()

function send(method, params = {}, sessionId) {
  const id = ++seq
  const message = { id, method, params }
  if (sessionId) message.sessionId = sessionId
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`${method} 超时`))
    }, 30_000)
    pending.set(id, { resolvePromise, reject, timer })
    ws.send(JSON.stringify(message))
  })
}

async function connect() {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      if (res.ok) return (await res.json()).webSocketDebuggerUrl
    } catch {
      // 还没起来
    }
    await sleep(250)
  }
  throw new Error(`连不上 CDP（端口 ${PORT}）`)
}

async function run() {
  ws = new WebSocket(await connect())
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', () => rej(new Error('WS 连接失败')), { once: true })
  })

  const events = []
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) {
      const item = pending.get(message.id)
      pending.delete(message.id)
      clearTimeout(item.timer)
      if (message.error) item.reject(new Error(message.error.message))
      else item.resolvePromise(message.result)
      return
    }
    events.push(message)
  })

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })

  const errors = []
  const noise = []
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    if (message.sessionId !== sessionId) return
    if (message.method === 'Runtime.exceptionThrown') {
      errors.push(message.params.exceptionDetails?.exception?.description ?? '未知异常')
    }
    if (message.method === 'Runtime.consoleAPICalled') {
      const { type, args } = message.params
      if (type !== 'error' && type !== 'warning') return
      noise.push(`[${type}] ${(args ?? []).map(a => a.value ?? a.description ?? '').join(' ')}`)
    }
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
      const entry = message.params.entry
      // favicon 是每个站点都会缺的资源，与验收无关
      if (entry.url?.endsWith('/favicon.ico')) return
      noise.push(`[network] ${entry.text}${entry.url ? ` ${entry.url}` : ''}`)
    }
  })

  await send('Runtime.enable', {}, sessionId)
  await send('Log.enable', {}, sessionId)
  await send('Page.enable', {}, sessionId)
  await send(
    'Emulation.setDeviceMetricsOverride',
    { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false },
    sessionId,
  )

  const evaluate = async expression => {
    const result = await send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
    )
    return result.result?.value
  }

  /** 等选择器出现：冷启动要拉若干 chunk + /api/portal，固定 sleep 会拍到空状态 */
  async function waitFor(selector, timeout = 15_000) {
    const start = Date.now()
    while (Date.now() - start < timeout) {
      if (await evaluate(`!!document.querySelector(${JSON.stringify(selector)})`)) return true
      await sleep(200)
    }
    return false
  }

  async function goto(target, settle = 1500) {
    await send('Page.navigate', { url: target }, sessionId)
    await sleep(settle)
  }

  async function shot(name) {
    const { data } = await send(
      'Page.captureScreenshot',
      { format: 'png', captureBeyondViewport: false },
      sessionId,
    )
    const file = join(outDir, `${name}.png`)
    writeFileSync(file, Buffer.from(data, 'base64'))
    log('截图', file)
  }

  log('=== 首页 ===')
  await goto(url, 800)
  await waitFor('.library__title')
  await waitFor('.card, .empty__title')
  log('标题', await evaluate('document.title'))
  log('宿主', await evaluate('JSON.stringify({ kind: window.docvi?.hostKind ?? null })'))
  log(
    '页面',
    await evaluate(`JSON.stringify({
      cards: document.querySelectorAll('.card').length,
      emptyTitle: document.querySelector('.empty__title')?.textContent ?? null,
      addButtons: [...document.querySelectorAll('.library__actions button')].length,
    })`),
  )
  await shot('01-library')

  log('=== 进入仓库 ===')
  log(
    '点击',
    await evaluate(`(() => {
    const card = document.querySelector('.card')
    if (!card) return 'no-card'
    card.click()
    return 'clicked'
  })()`),
  )
  await waitFor('[data-tree-path]')
  await waitFor('.at-doc h1')
  log(
    '工作区',
    await evaluate(`JSON.stringify({
      url: location.pathname,
      treeRows: document.querySelectorAll('[data-tree-path]').length,
      h1: document.querySelector('.at-doc h1')?.textContent ?? null,
      sidebarTools: document.querySelectorAll('.tree-tools__btn').length,
      gitBar: !!document.querySelector('.gitbar'),
    })`),
  )
  await shot('02-workspace')

  log('=== 切换到另一篇（验证 SPA 路由）===')
  const before = await evaluate('location.pathname')
  log(
    '切换',
    await evaluate(`(() => {
    const rows = [...document.querySelectorAll('[data-tree-path]')]
    const target = rows[3] ?? rows[rows.length - 1]
    if (!target) return 'no-row'
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return target.getAttribute('data-tree-path')
  })()`),
  )
  await sleep(1800)
  await waitFor('.at-doc h1')
  log(
    '切换后',
    await evaluate(`JSON.stringify({
      urlChanged: location.pathname !== ${JSON.stringify(before)},
      url: location.pathname,
      h1: document.querySelector('.at-doc h1')?.textContent ?? null,
    })`),
  )
  await shot('03-document')

  log('=== 浏览器后退（必须留在 SPA 内）===')
  await evaluate('window.__marker = "spa"')
  await evaluate('(history.back(), "called")').catch(() => undefined)
  await sleep(2200)
  log(
    '后退后',
    await evaluate(`JSON.stringify({
      url: location.pathname,
      stillSpa: window.__marker === 'spa',
      h1: document.querySelector('.at-doc h1')?.textContent ?? null,
    })`).catch(() => '页面被整页导航（SPA 路由失效）'),
  )

  log('=== 刷新（验证地址栏深链）===')
  const deepUrl = await evaluate('location.href')
  await goto(deepUrl, 1200)
  await waitFor('.at-doc h1')
  log('刷新后 H1', await evaluate('document.querySelector(".at-doc h1")?.textContent ?? null'))
  await shot('04-reload')

  log('=== 命令面板（容器版应无桌面专属命令）===')
  await evaluate(`document.querySelector('.titlebar__search')?.click()`)
  await sleep(900)
  log(
    '面板',
    await evaluate(`JSON.stringify({
      open: !!document.querySelector('.palette'),
      commands: [...document.querySelectorAll('.palette__item-title')].map(n => n.textContent),
    })`),
  )
  await shot('05-palette')

  log('=== 控制台 ===')
  log('异常', errors.length ? errors.join('\n') : '无')
  log('错误/警告', noise.length ? noise.slice(0, 20).join('\n') : '无')

  await send('Target.closeTarget', { targetId }).catch(() => undefined)
}

/**
 * 收尾：整棵进程树 + profile 目录，一个都不能留。
 *
 * 不放进 `finally` 之外的任何分支：中途抛错也要清干净，否则下次跑之前
 * 机器上又多一份 380MB。
 */
function cleanup() {
  try {
    ws?.close()
  } catch {
    // 忽略
  }
  if (child.pid) {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }
  }
  /*
   * 删 profile 要能容忍 Windows 的延迟释放：浏览器刚被杀时 Crashpad 与
   * 文件系统过滤驱动可能还持有句柄，立刻 rm 会 EPERM。rmSync 自带
   * maxRetries 在 recursive 下可用，再兜一层 try/catch——清理失败只报告，
   * 绝不让收尾本身抛错把退出码搞乱（那样反而更难发现泄漏）。
   */
  try {
    rmSync(PROFILE, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 })
  } catch {
    // 落到下面的复查
  }
  if (existsSync(PROFILE)) {
    log(`⚠ 临时 profile 未删净：${PROFILE}（下次启动前手工删除）`)
  } else {
    log('已清理临时 profile')
  }
}

run()
  .catch(error => log('失败：', error.message))
  .finally(() => {
    cleanup()
    log(`完成，TAG=${TAG}`)
    process.exit(0)
  })
