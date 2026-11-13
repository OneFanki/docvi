#!/usr/bin/env node
/**
 * 代码块字体的取证探针。
 *
 * 「看起来不像等宽」是主观判断，必须落到「这个节点实际用了哪个字体」上。
 * CDP 的 CSS.getPlatformFontsForNode 直接返回浏览器实际选中的字体族与 glyph 数
 * ——它看的是渲染结果，不是 CSS 声明，所以能揭穿「CSS 写了 JetBrains 但实际
 * 落到了别的字体」这类静默回退。
 *
 * 同时逐个字符量宽度，验证等宽是否真的成立（同字体下 'i' 与 'W' 必须等宽）。
 *
 * 用法：node scripts/dev/probe-codefont.mjs  （需先 pnpm docvi:build）
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
const TAG = `cf${Date.now().toString(36)}`
const PORT = 9900 + Math.floor(Math.random() * 90)
const DATA = mkdtempSync(join(tmpdir(), `docvi-cf-data-${TAG}-`))
const WS = mkdtempSync(join(tmpdir(), `docvi-cf-ws-${TAG}-`))

/** 与用户报告的场景同构：无语言标记的围栏 + 框线树 + 中英混排 */
const ART = [
  '一条 task',
  '├── 视频轨（1~N 路）',
  '│   ├── 头部相机（ego，第一人称）',
  '│   ├── 外部相机（allo，第三人称，可能有多个机位）',
  '│   └── 深度相机',
  '├── 运动与位姿（按时间采样的行数组）',
  '│   ├── 头部位姿：位置 + 朝向四元数',
  '│   ├── 手部关节：每帧左右手各 21 个 3D 点（世界坐标，单位米）',
  '│   └── 相机内参：fx/fy/cx/cy、内参标定的分辨率',
].join('\n')

const DOC_TEXT = `# 代码块字体取证

\`\`\`
${ART}
\`\`\`

\`\`\`ts
const message = 'plain ascii iiii WWWW 0000'
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
        pending.set(id, message => done(message.result ?? message.error))
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
  writeFileSync(join(WS, '代码块字体.md'), DOC_TEXT, 'utf8')

  child = spawn(ELECTRON, [APP_DIR, '--no-sandbox'], {
    env: {
      ...process.env,
      DOCVI_HEADLESS: '1',
      DOCVI_DATA_DIR: DATA,
      DOCVI_INSTANCE: `docvi-cf-${TAG}`,
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
      .find(el => (el.dataset.treePath || '').endsWith('代码块字体.md'))?.click()
  })()`)
  await sleep(4000)

  /* ---------- 先确认字体真的加载进来了 ---------- */
  const fontState = await client.evaluate(`(async () => {
    await Promise.allSettled([
      document.fonts.load('400 13.5px "JetBrains Mono"'),
      document.fonts.load('400 13.5px "HarmonyOS Sans SC"'),
    ])
    try { await document.fonts.ready } catch {}
    return [...document.fonts].map(f => f.family + '|' + f.weight + '|' + f.status)
  })()`)
  log('字体面状态:', JSON.stringify(fontState))

  /* ---------- 声明值与计算值 ---------- */
  const declared = await client.evaluate(`(() => {
    const codes = [...document.querySelectorAll('.doc-surface [class*="language-"] pre > code')]
    if (!codes.length) return { error: '没找到代码块' }
    return codes.map(code => {
      const cs = getComputedStyle(code)
      const pre = code.closest('pre')
      const wrap = code.closest('[class*="language-"]')
      return {
        wrapClass: wrap?.className ?? '',
        dataAscii: wrap?.hasAttribute('data-ascii') ?? false,
        fontFamily: cs.fontFamily,
        fontSize: cs.fontSize,
        firstChars: (code.textContent ?? '').slice(0, 20),
      }
    })
  })()`)
  log('计算样式:', JSON.stringify(declared, null, 1))

  /* ---------- 真实使用的字体（浏览器实际选中，不是 CSS 声明） ---------- */
  await client.send('DOM.enable')
  await client.send('CSS.enable')

  const doc = await client.send('DOM.getDocument', { depth: -1 })
  const rootId = doc?.root?.nodeId
  const nodeIds = await client.evaluate(`(() => {
    const codes = [...document.querySelectorAll('.doc-surface [class*="language-"] pre > code')]
    codes.forEach((el, i) => el.setAttribute('data-probe-code', String(i)))
    return codes.length
  })()`)

  const fontReports = []
  for (let index = 0; index < nodeIds; index += 1) {
    const found = await client.send('DOM.querySelector', {
      nodeId: rootId,
      selector: `[data-probe-code="${index}"]`,
    })
    const nodeId = found?.nodeId
    if (!nodeId) continue
    const fonts = await client.send('CSS.getPlatformFontsForNode', { nodeId })
    fontReports.push({ index, fonts: fonts?.fonts ?? fonts })
  }
  log('实际渲染字体:', JSON.stringify(fontReports, null, 1))

  /* ---------- 逐字符宽度：等宽是否真的成立 ---------- */
  const metrics = await client.evaluate(`(() => {
    const code = document.querySelector('.doc-surface [data-probe-code="1"] code, .doc-surface [class*="language-ts"] pre > code')
    const all = [...document.querySelectorAll('.doc-surface [class*="language-"] pre > code')]
    const target = all[all.length - 1]
    if (!target) return { error: 'no ts block' }
    const cs = getComputedStyle(target)
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    ctx.font = cs.fontSize + ' ' + cs.fontFamily
    const measure = ch => Math.round(ctx.measureText(ch).width * 100) / 100
    return {
      fontUsed: cs.fontFamily,
      i: measure('i'),
      W: measure('W'),
      zero: measure('0'),
      dash: measure('-'),
      boxH: measure('─'),
      boxV: measure('│'),
      cjk: measure('中'),
    }
  })()`)
  log('逐字符宽度:', JSON.stringify(metrics))

  const verdict = []
  const first = declared?.[0]
  if (first?.dataAscii) verdict.push('✓ 无语言围栏已打上 data-ascii（ASCII 锁宽生效）')
  else verdict.push('❗ 无语言围栏没有 data-ascii，框线不会锁宽')

  // 真实字体：框线块的字体里必须出现 JetBrains Mono
  const firstFonts = fontReports[0]?.fonts
  const families = Array.isArray(firstFonts)
    ? firstFonts.map(item => `${item.familyName}(${item.glyphCount})`)
    : []
  log('第一个代码块字体明细:', JSON.stringify(families))

  const hasJetBrains = Array.isArray(firstFonts)
    ? firstFonts.some(item => /JetBrains/i.test(item.familyName))
    : false
  verdict.push(
    hasJetBrains
      ? '✓ 框线块实际用到了 JetBrains Mono'
      : '❗ 框线块没用到 JetBrains Mono（被其他字体接管）',
  )

  // 框线字符必须等宽且与 ASCII 同宽
  const asciiW = metrics?.i ?? 0
  verdict.push(
    Math.abs(metrics.i - metrics.W) < 0.05
      ? `✓ ASCII 等宽（i=${metrics.i} W=${metrics.W}）`
      : `❗ ASCII 不等宽（i=${metrics.i} W=${metrics.W}）`,
  )
  verdict.push(
    Math.abs(metrics.boxH - asciiW) < 0.6
      ? `✓ 框线 '─' 与 ASCII 同宽（${metrics.boxH} vs ${asciiW}）`
      : `❗ 框线 '─' 宽度异常（${metrics.boxH} vs ASCII ${asciiW}）——框线字体与正文不同，对齐会漂`,
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
