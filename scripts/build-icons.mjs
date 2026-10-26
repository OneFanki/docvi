/**
 * 平台标识与应用图标生成器。
 *
 * 几何定义全部在 `scripts/lib/logo.mjs`（唯一源头，含设计理由）：这里只负责
 * 把那份 SVG 渲染成各尺寸 PNG/ICO/ICNS，并顺手写出 `docs/assets/logo.svg`。
 * 不要在脚本里重画图形——四处调用方共用的必须是同一组坐标。
 *
 * 渲染为什么用系统 Chromium（Edge/Chrome）而不是 Electron：
 * Electron 在本仓库的脚本环境下 `app.whenReady()` 会挂住不返回（实测 60s 超时，
 * 与 GPU/网络服务初始化有关），而 CDP 驱动的 headless Chromium 稳定且零依赖。
 *
 * 输出（apps/desktop/build 是 electron-builder 的 buildResources 目录）：
 *   icon.png   1024×1024（electron-builder 按需下采样）
 *   icon.ico   16/24/32/48/64/128/256（Windows）
 *   icon.icns  16…1024（macOS）
 *   docs/assets/logo.svg（文档与外部引用）
 *   apps/desktop/src/renderer/public/favicon.svg（浏览器标签页图标）
 *
 * 用法：node scripts/build-icons.mjs
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { LOGO_SVG } from './lib/logo.mjs'

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
const ICNS_ENTRIES = [
  { type: 'icp4', size: 16 },
  { type: 'icp5', size: 32 },
  { type: 'icp6', size: 64 },
  { type: 'ic07', size: 128 },
  { type: 'ic08', size: 256 },
  { type: 'ic09', size: 512 },
  { type: 'ic10', size: 1024 },
]
const RENDER_SIZES = [...new Set([...ICO_SIZES, ...ICNS_ENTRIES.map(e => e.size), 1024])].sort(
  (a, b) => a - b,
)

/** 系统 Chromium 候选（本机只需要命中一个） */
function findChromium() {
  const candidates = [
    process.env.CHROMIUM_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean)
  return candidates.find(path => existsSync(path))
}

const wait = ms => new Promise(r => setTimeout(r, ms))

/** 等 CDP 端点就绪并返回页面目标 */
async function findPage(port) {
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`)
      const page = (await res.json()).find(target => target.type === 'page')
      if (page?.webSocketDebuggerUrl) return page
    } catch {
      /* 还没起来 */
    }
    await wait(300)
  }
  throw new Error('CDP 端点未就绪')
}

/** 用 CDP 把 LOGO_SVG 渲染成各尺寸 PNG（透明底） */
async function renderAll(sizes, chromium, workDir) {
  const htmlPath = join(workDir, 'logo.html')
  writeFileSync(
    htmlPath,
    `<!doctype html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;padding:0;background:transparent;overflow:hidden}
      svg{display:block}
    </style></head><body>${LOGO_SVG}</body></html>`,
  )

  const port = 9600 + Math.floor(Math.random() * 300)
  const profile = join(workDir, 'profile')
  const child = spawn(
    chromium,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  try {
    const page = await findPage(port)
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true })
      ws.addEventListener('error', rej, { once: true })
    })
    let seq = 0
    const pending = new Map()
    ws.addEventListener('message', event => {
      const msg = JSON.parse(event.data)
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg)
        pending.delete(msg.id)
      }
    })
    const send = (method, params = {}) =>
      new Promise(res => {
        const id = ++seq
        pending.set(id, res)
        ws.send(JSON.stringify({ id, method, params }))
      })

    await send('Page.enable')
    await send('Emulation.setDefaultBackgroundColorOverride', {
      color: { r: 0, g: 0, b: 0, a: 0 },
    })

    const out = new Map()
    for (const size of sizes) {
      await send('Emulation.setDeviceMetricsOverride', {
        width: size,
        height: size,
        deviceScaleFactor: 1,
        mobile: false,
      })
      await send('Page.navigate', { url: `file:///${htmlPath.replace(/\\/g, '/')}` })
      await wait(600)
      const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true })
      const data = shot.result?.data
      if (!data) throw new Error(`渲染 ${size}px 失败`)
      out.set(size, Buffer.from(data, 'base64'))
    }
    ws.close()
    return out
  } finally {
    // ⚠️ 必须整组杀：Chromium 是多进程架构，只 kill 主进程会留下 renderer/GPU 孤儿，
    // 它们继续持有 profile 目录（表现为 rmSync EPERM 且进程残留）。实测踩过三次。
    killTree(child, profile)
    await wait(800)
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
    } catch {
      /* 删不掉不影响产物 */
    }
  }
}

/** 杀掉本次渲染启动的全部 Chromium 进程。
 *
 *  ⚠️ 不能只杀 `child.pid`：msedge.exe 是 launcher，真正的浏览器主进程由它再派生，
 *  launcher 先退出后 `child.pid` 就失效了，剩下的 renderer/GPU 全成孤儿并继续占用
 *  profile 目录（实测造成 3 组共 40+ 进程残留、rmSync EPERM）。
 *  这里按**本次唯一的 profile 路径**匹配命令行整组清理——profile 名带随机后缀，
 *  不会误杀用户自己的浏览器；且必须同步执行，否则脚本先退出、清理还没跑。 */
function killTree(child, profile) {
  try {
    if (process.platform === 'win32' && profile) {
      const pattern = profile.replace(/'/g, "''")
      spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${pattern}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
        ],
        { stdio: 'ignore' },
      )
    } else if (child?.pid) {
      process.kill(-child.pid, 'SIGKILL')
    }
  } catch {
    /* 进程已退出 */
  }
}

/** ICO 容器：header + 目录项 + 各尺寸 PNG 负载（Vista+ 支持 PNG 压缩 ico） */
function buildIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)

  const dir = Buffer.alloc(16 * entries.length)
  let offset = 6 + dir.length
  const blobs = []
  entries.forEach((entry, index) => {
    const base = index * 16
    // 256 在目录项里必须写 0（字段只有 1 字节）
    dir.writeUInt8(entry.size >= 256 ? 0 : entry.size, base)
    dir.writeUInt8(entry.size >= 256 ? 0 : entry.size, base + 1)
    dir.writeUInt8(0, base + 2)
    dir.writeUInt8(0, base + 3)
    dir.writeUInt16LE(1, base + 4)
    dir.writeUInt16LE(32, base + 6)
    dir.writeUInt32LE(entry.png.length, base + 8)
    dir.writeUInt32LE(offset, base + 12)
    offset += entry.png.length
    blobs.push(entry.png)
  })
  return Buffer.concat([header, dir, ...blobs])
}

/** ICNS 容器：'icns' + 总长 + [OSType + 长度 + PNG] */
function buildIcns(entries) {
  const chunks = entries.map(entry => {
    const head = Buffer.alloc(8)
    head.write(entry.type, 0, 4, 'ascii')
    head.writeUInt32BE(entry.png.length + 8, 4)
    return Buffer.concat([head, entry.png])
  })
  const body = Buffer.concat(chunks)
  const head = Buffer.alloc(8)
  head.write('icns', 0, 4, 'ascii')
  head.writeUInt32BE(body.length + 8, 4)
  return Buffer.concat([head, body])
}

const root = resolve(import.meta.dirname, '..')
// 新宿主 electron-builder 的 buildResources（apps/desktop/electron-builder.yml）
const outDir = join(root, 'apps', 'desktop', 'build')

const chromium = findChromium()
if (!chromium) {
  console.error('[icons] 未找到 Chromium/Edge；可通过 CHROMIUM_PATH 环境变量指定')
  process.exit(1)
}

const workDir = mkdtempSync(join(tmpdir(), 'ds-icons-'))
try {
  const png = await renderAll(RENDER_SIZES, chromium, workDir)
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'icon.png'), png.get(1024))
  writeFileSync(
    join(outDir, 'icon.ico'),
    buildIco(ICO_SIZES.map(size => ({ size, png: png.get(size) }))),
  )
  writeFileSync(
    join(outDir, 'icon.icns'),
    buildIcns(ICNS_ENTRIES.map(entry => ({ type: entry.type, png: png.get(entry.size) }))),
  )
  console.log(`[icons] 已生成 icon.png / icon.ico / icon.icns（${RENDER_SIZES.length} 档尺寸）`)

  // 同源的矢量副本：文档引用与浏览器标签页图标都用它，避免 PNG 走样
  writeFileSync(join(root, 'docs', 'assets', 'logo.svg'), `${LOGO_SVG}\n`)
  const faviconDir = join(root, 'apps', 'desktop', 'src', 'renderer', 'public')
  mkdirSync(faviconDir, { recursive: true })
  writeFileSync(join(faviconDir, 'favicon.svg'), `${LOGO_SVG}\n`)
  console.log('[icons] 已同步 docs/assets/logo.svg 与 renderer/public/favicon.svg')
} finally {
  // Windows 上 Chromium 退出后仍可能短暂持有 profile 句柄：删不掉就留痕，不当作失败
  // （产物已经写完；残留目录在系统临时目录，由系统清理）
  try {
    rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  } catch (error) {
    console.warn(`[icons] 临时目录稍后清理：${workDir}（${error.code ?? error.message}）`)
  }
}
