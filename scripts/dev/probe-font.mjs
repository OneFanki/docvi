#!/usr/bin/env node
/**
 * 字体落地验证：随包的鸿蒙黑体是否真的加载、真的用上、真的与系统字体不同。
 *
 * 判据不只是「document.fonts 里有这条记录」——记录存在但字重对不上、或字体
 * 加载失败退回系统字体，都会让界面看起来毫无变化而无人察觉。所以量三件事：
 *
 *  1. `document.fonts.check()` 对三个字重都返回 true（文件确实可解析）；
 *  2. 同一段文字在鸿蒙/系统两档下的**渲染宽度不同**（证明真的换了字形，
 *     不是两条一样的字体栈）；
 *  3. 代码块用的是等宽字体：等宽块里 'i' 与 'W' 的宽度必须相等。
 *
 * 用法：node scripts/dev/probe-font.mjs  （需先 pnpm docvi:build）
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const ELECTRON = join(ROOT, 'apps/desktop/node_modules/electron/dist/electron.exe')
const APP_DIR = join(ROOT, 'apps/desktop')
const TAG = `ft${Date.now().toString(36)}`
const PORT = 9600 + Math.floor(Math.random() * 90)
const DATA = mkdtempSync(join(tmpdir(), `docvi-ft-data-${TAG}-`))

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
  try {
    rmSync(DATA, { recursive: true, force: true, maxRetries: 5 })
  } catch {
    // 忽略
  }
}

async function main() {
  child = spawn(ELECTRON, [APP_DIR, '--no-sandbox'], {
    env: {
      ...process.env,
      DOCVI_HEADLESS: '1',
      DOCVI_DATA_DIR: DATA,
      DOCVI_INSTANCE: `docvi-ft-${TAG}`,
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
  await sleep(4000)

  const result = await client.evaluate(`(async () => {
    /*
     * 显式把两族字体都拉起来再判断。
     *
     * 只调 document.fonts.ready 不够：字体是**按需**加载的，页面上没有元素用
     * JetBrains Mono 时它的 @font-face 永远不会开始下载，check() 于是返回 false
     * ——这是「还没加载」，不是「加载不了」。用 fonts.load() 显式触发，才是对
     * 「文件是否可解析」的有效判断。
     */
    await Promise.allSettled([
      document.fonts.load('400 16px "HarmonyOS Sans SC"'),
      document.fonts.load('500 16px "HarmonyOS Sans SC"'),
      document.fonts.load('700 16px "HarmonyOS Sans SC"'),
      document.fonts.load('400 16px "JetBrains Mono"'),
    ])
    try { await document.fonts.ready } catch {}
    const loaded = {
      regular: document.fonts.check('400 16px "HarmonyOS Sans SC"'),
      medium: document.fonts.check('500 16px "HarmonyOS Sans SC"'),
      bold: document.fonts.check('700 16px "HarmonyOS Sans SC"'),
      jetbrains: document.fonts.check('400 16px "JetBrains Mono"'),
    }

    // 已注册的字体面（用于确认 CSS 里的 @font-face 真的进了产物）
    const faces = [...document.fonts].map(f => ({
      family: f.family, weight: f.weight, status: f.status,
    }))

    const measure = (text, font) => {
      const canvas = document.createElement('canvas')
      const ctx = canvas.getContext('2d')
      ctx.font = font
      return Math.round(ctx.measureText(text).width * 100) / 100
    }

    const sample = '文档渲染 HarmonyOS 0123456789'
    const harmonyWidth = measure(sample, '400 20px "HarmonyOS Sans SC", monospace')
    const systemWidth = measure(sample, '400 20px "Segoe UI", "Microsoft YaHei", monospace')

    // 等宽判定：i 与 W 同宽
    const mono = {
      i: measure('i', '400 16px "JetBrains Mono", monospace'),
      W: measure('W', '400 16px "JetBrains Mono", monospace'),
      cjk: measure('中', '400 16px "JetBrains Mono", "HarmonyOS Sans SC", monospace'),
    }

    const rootFont = getComputedStyle(document.documentElement)
      .getPropertyValue('--dv-font-sans').trim()
    const rootMono = getComputedStyle(document.documentElement)
      .getPropertyValue('--dv-font-mono').trim()

    return {
      loaded, faces, harmonyWidth, systemWidth, mono,
      rootFontFirst: rootFont.split(',')[0].trim(),
      rootMonoFirst: rootMono.split(',')[0].trim(),
      hasFontAttr: document.documentElement.dataset.font ?? '(none)',
    }
  })()`)

  const verdict = []
  const { loaded, faces, harmonyWidth, systemWidth, mono } = result

  verdict.push(
    loaded.regular && loaded.medium && loaded.bold && loaded.jetbrains
      ? `✓ 字体全部可加载（鸿蒙 400/500/700 + JetBrains Mono）`
      : `❗ 字体加载失败：${JSON.stringify(loaded)}`,
  )

  const harmonyFaces = faces.filter(f => f.family.includes('HarmonyOS')).length
  const monoFaces = faces.filter(f => f.family.includes('JetBrains')).length
  verdict.push(
    harmonyFaces >= 3 && monoFaces >= 3
      ? `✓ @font-face 已注册 ${harmonyFaces} 个鸿蒙面 + ${monoFaces} 个等宽面`
      : `❗ 注册面数不对：鸿蒙 ${harmonyFaces} / 等宽 ${monoFaces}`,
  )

  const delta = Math.abs(harmonyWidth - systemWidth)
  verdict.push(
    delta > 1
      ? `✓ 鸿蒙与系统字体渲染宽度不同（${harmonyWidth} vs ${systemWidth}px，差 ${Math.round(delta * 100) / 100}px）`
      : `❗ 两者宽度相同（${harmonyWidth}px）——可能都回落到了同一个字体`,
  )

  verdict.push(
    Math.abs(mono.i - mono.W) < 0.05
      ? `✓ 代码块等宽（i=${mono.i}px，W=${mono.W}px）`
      : `❗ 代码块不等宽（i=${mono.i}px vs W=${mono.W}px）`,
  )
  verdict.push(
    mono.cjk > mono.i * 1.5
      ? `✓ 等宽块内中文按全角宽度渲染（中=${mono.cjk}px）`
      : `❗ 等宽块内中文宽度异常（中=${mono.cjk}px，应约为 i 的 2 倍）`,
  )

  verdict.push(
    result.rootFontFirst.includes('HarmonyOS')
      ? `✓ 默认字体栈首位是鸿蒙`
      : `❗ 默认字体栈首位不是鸿蒙：${result.rootFontFirst}`,
  )
  verdict.push(
    result.rootMonoFirst.includes('JetBrains')
      ? `✓ 等宽栈首位是 JetBrains Mono`
      : `❗ 等宽栈首位不是 JetBrains Mono：${result.rootMonoFirst}`,
  )
  verdict.push(
    result.hasFontAttr === '(none)'
      ? `✓ 默认态无 data-font 属性（属性缺失 = 鸿蒙）`
      : `❗ 默认态带了 data-font=${result.hasFontAttr}`,
  )

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
