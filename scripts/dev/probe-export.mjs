#!/usr/bin/env node
/**
 * 导出产物验收：单文件 HTML 是否真的自包含，PDF 是否把它要的东西都画进去。
 *
 * 现有实现已经有导出链路，缺的是「产物到底行不行」的证据。这个探针不看代码，
 * 只看落盘产物：
 *
 *  1. HTML 里不能残留任何 `docvi://` 或指向工作区文件的地址（外链图片没内联）。
 *  2. HTML 里引用的图片必须是 data URL，且能解出非空字节。
 *  3. HtmlEmbed 的 iframe 必须是 `srcdoc`（而不是指向 embed-sandbox.html）。
 *  4. PDF 必须是合法 PDF（魔数 + 大小合理），且内嵌内容不会让页数塌成 1 页。
 *
 * 用法：node scripts/dev/probe-export.mjs  （需先 pnpm docvi:build）
 */
import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const ELECTRON = join(ROOT, 'apps/desktop/node_modules/electron/dist/electron.exe')
const APP_DIR = join(ROOT, 'apps/desktop')
const TAG = `ex${Date.now().toString(36)}`
const PORT = 9500 + Math.floor(Math.random() * 90)
const DATA = mkdtempSync(join(tmpdir(), `docvi-ex-data-${TAG}-`))
const WS = mkdtempSync(join(tmpdir(), `docvi-ex-ws-${TAG}-`))
const OUT = mkdtempSync(join(tmpdir(), `docvi-ex-out-${TAG}-`))

/** 三色 PNG（1×1 也行，但这里用手画的小图，尺寸足够让内联有意义） */
function makePng() {
  // 4×4 纯色 PNG 的预计算字节（避免引入 zlib 依赖）
  const base64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFUlEQVR42mNk+M9Qz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC'
  return Buffer.from(base64, 'base64')
}

/* ---------- 样本内容：把导出要处理的三类东西都放进去 ---------- */

const EMBED_HTML = `<!doctype html><html><body style="margin:0;background:#0b1c24;color:#7fd4e8;font:14px system-ui;padding:12px">
<div id="box">内嵌图解 · embed marker 8823</div>
<script>document.getElementById('box').textContent += ' · script ran'</script>
</body></html>`

const DOC_TEXT = `---
title: 导出验收样本
components:
  embed1:
    kind: html-embed
    title: 内嵌图解
    html: |
      <!doctype html><html><body style="margin:0;background:#0b1c24;color:#7fd4e8;font:14px system-ui;padding:12px">
      <div id="box">内嵌图解 · embed marker 8823</div>
      <script>document.getElementById('box').textContent += ' · script ran'</script>
      </body></html>
---

# 导出验收样本

这一段用于验证排版与分页。

![本地图片](assets/pic.png)

## 图与嵌入

\`\`\`mermaid
flowchart LR
  A[开始] --> B[结束]
\`\`\`

<at-html-embed data-key="embed1"></at-html-embed>

## 长文（用于确认 PDF 不止一页）

${Array.from({ length: 40 }, (_, index) => `第 ${index + 1} 段：导出验收用的填充段落，确认分页与图片嵌入都正常。`).join('\n\n')}
`

const EMBED_FILE = join(WS, 'embed-sample.html')

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
  // 产物目录在留档模式下保留（见 DOCVI_EXPORT_KEEP）
  const dirs = process.env.DOCVI_EXPORT_KEEP === '1' ? [DATA, WS] : [DATA, WS, OUT]
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
    } catch {
      // 忽略
    }
  }
}

async function main() {
  mkdirSync(join(WS, 'assets'), { recursive: true })
  writeFileSync(join(WS, 'assets', 'pic.png'), makePng())
  writeFileSync(EMBED_FILE, EMBED_HTML, 'utf8')
  writeFileSync(join(WS, '导出验收.md'), DOC_TEXT, 'utf8')

  child = spawn(ELECTRON, [APP_DIR, '--no-sandbox'], {
    env: {
      ...process.env,
      DOCVI_HEADLESS: '1',
      DOCVI_DATA_DIR: DATA,
      DOCVI_INSTANCE: `docvi-ex-${TAG}`,
      DOCVI_DEBUG_PORT: String(PORT),
      // 自动化钩子：跳过系统保存框，直接写进 OUT
      DOCVI_EXPORT_DIR: OUT,
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
    [...document.querySelectorAll('.card')]
      .find(el => (el.textContent || '').includes(${JSON.stringify(WS)}))?.click()
  })()`)
  await sleep(3000)
  await client.evaluate(`(() => {
    [...document.querySelectorAll('[data-tree-path]')]
      .find(el => (el.dataset.treePath || '').endsWith('导出验收.md'))?.click()
  })()`)
  await sleep(4000)

  /* ---------- 触发导出：走真实命令面板，不造假钩子 ---------- */
  async function exportViaPalette(label) {
    await client.evaluate(`(() => {
      document.querySelector('.palette__input')?.blur()
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'k', ctrlKey: true, bubbles: true, cancelable: true,
      }))
    })()`)
    await sleep(600)
    const opened = await client.evaluate(`!!document.querySelector('.palette__input')`)
    if (!opened) throw new Error('命令面板没打开')
    await client.evaluate(`(() => {
      const input = document.querySelector('.palette__input')
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype, 'value',
      ).set
      setter.call(input, ${JSON.stringify(label)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
    await sleep(700)
    const picked = await client.evaluate(`(() => {
      const item = [...document.querySelectorAll('.palette__item-title')]
        .find(el => (el.textContent || '').includes(${JSON.stringify(label)}))
      if (!item) return false
      item.closest('.palette__item').click()
      return true
    })()`)
    if (!picked) throw new Error(`命令面板里找不到「${label}」`)
    await sleep(6000)
    return picked
  }

  await exportViaPalette('导出为 HTML')
  await exportViaPalette('导出为 PDF')
  log('两次导出命令已执行')

  /* 导出报错走 store.setError，界面上的提示条是唯一线索 */
  const notices = await client.evaluate(`(() => {
    const text = document.body.innerText || ''
    const hit = text.split('\\n').filter(line =>
      /导出|export|失败|错误|error/i.test(line) && line.length < 200)
    return hit.slice(0, 8)
  })()`)
  log('界面提示:', JSON.stringify(notices))

  client.close()

  /* ---------- 产物检查 ---------- */
  const htmlFile = join(OUT, '导出验收样本.html')
  const pdfFile = join(OUT, '导出验收样本.pdf')
  const verdict = []

  if (!existsSync(htmlFile)) {
    verdict.push(`❗ 没有 HTML 产物（期望 ${htmlFile}）`)
  } else {
    const html = readFileSync(htmlFile, 'utf8')
    verdict.push(`✓ HTML 落盘 ${(statSync(htmlFile).size / 1024).toFixed(1)}KB`)

    // 残留的应用内部协议 = 换台机器就打不开
    const leaks = [...html.matchAll(/docvi:\/\/[^"')\s]+/g)].map(m => m[0])
    verdict.push(
      leaks.length === 0
        ? '✓ 无 docvi:// 残留'
        : `❗ 残留 ${leaks.length} 处内部协议：${leaks.slice(0, 3)}`,
    )

    // 图片必须内联
    const imgTags = [...html.matchAll(/<img\b[^>]*>/g)].map(m => m[0])
    const nonData = imgTags.filter(tag => !/src="data:image\//.test(tag))
    verdict.push(
      imgTags.length === 0
        ? '❗ 产物里没有 img（样本图没渲染进去）'
        : nonData.length === 0
          ? `✓ ${imgTags.length} 张图全部内联为 data URL`
          : `❗ ${nonData.length}/${imgTags.length} 张图未内联`,
    )

    // data URL 必须真能解出字节
    const dataUrls = [...html.matchAll(/src="(data:image\/[a-z+]+;base64,([^"]+))"/g)]
    const bad = dataUrls.filter(m => Buffer.from(m[2], 'base64').length < 10)
    verdict.push(
      dataUrls.length === 0
        ? '❗ 没有可解的 data URL'
        : bad.length === 0
          ? '✓ data URL 均能解出有效字节'
          : `❗ ${bad.length} 个 data URL 是空的`,
    )

    // HtmlEmbed 必须落成 srcdoc
    const frames = [...html.matchAll(/<iframe\b[^>]*>/g)].map(m => m[0])
    const srcFrames = frames.filter(tag => /\bsrc="/.test(tag) && !/srcdoc="/.test(tag))
    verdict.push(
      frames.length === 0
        ? '❗ 产物里没有 iframe（HTML 嵌入没进产物）'
        : srcFrames.length === 0
          ? `✓ ${frames.length} 个 iframe 均为 srcdoc`
          : `❗ ${srcFrames.length} 个 iframe 仍用 src（离线打不开）`,
    )
    verdict.push(
      html.includes('embed marker 8823')
        ? '✓ 嵌入内容被写进产物'
        : '❗ 嵌入内容没进产物（srcdoc 是空的）',
    )
  }

  if (!existsSync(pdfFile)) {
    verdict.push('❗ 没有 PDF 产物')
  } else {
    const pdf = readFileSync(pdfFile)
    const magic = pdf.subarray(0, 5).toString('latin1')
    verdict.push(
      magic === '%PDF-'
        ? `✓ PDF 魔数正确（${(pdf.length / 1024).toFixed(1)}KB）`
        : `❗ PDF 魔数错：${magic}`,
    )
    // 页数：/Type /Page 出现次数（不含 /Pages）
    const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length
    verdict.push(
      pages >= 2
        ? `✓ PDF 共 ${pages} 页（长文没被压成一页）`
        : `❗ PDF 只有 ${pages} 页，分页或内容有问题`,
    )
    // 字体嵌入：打印中文必须有嵌入字体，否则别的机器开是方块
    const hasFontFile = /\/FontFile[23]?/.test(pdf.toString('latin1'))
    verdict.push(hasFontFile ? '✓ PDF 内嵌了字体' : '❗ PDF 没有内嵌字体（换机器会变方块）')

    /*
     * PDF 必须是浅色：数整页背景矩形的填充色亮度。
     *
     * 只认「设色 + 大矩形 + 紧跟 f 填充」的形状。不能只匹配 `rg`：正文每个文字段、
     * 每条边框都带自己的颜色，混进来会把平均值拉平。深色主题会填出 0.07 这类
     * 近乎全黑的底，浅色应该是 0.9 以上。
     */
    const fills = []
    let cursor = 0
    while (true) {
      const start = pdf.indexOf('stream', cursor)
      if (start < 0) break
      let from = start + 6
      if (pdf[from] === 13) from += 1
      if (pdf[from] === 10) from += 1
      const end = pdf.indexOf('endstream', from)
      if (end < 0) break
      try {
        const inflated = zlib.inflateSync(pdf.subarray(from, end)).toString('latin1')
        for (const m of inflated.matchAll(
          /([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg[^]{0,200}?([\d.]+)\s+([\d.]+)\s+re\s*f/g,
        )) {
          if (Number(m[4]) * Number(m[5]) < 400 * 500) continue
          fills.push((Number(m[1]) + Number(m[2]) + Number(m[3])) / 3)
        }
      } catch {
        // 非压缩流跳过
      }
      cursor = end + 9
    }
    if (!fills.length) {
      verdict.push('❗ 没找到整页背景填充，无法判定深浅')
    } else {
      const avg = fills.reduce((sum, v) => sum + v, 0) / fills.length
      verdict.push(
        avg > 0.7
          ? `✓ PDF 走浅色（背景亮度 ${avg.toFixed(2)}，${fills.length} 处整页填充）`
          : `❗ PDF 仍是深色底（背景亮度 ${avg.toFixed(2)}，应 > 0.7）`,
      )
    }
  }

  log('结论:')
  for (const line of verdict) log(' ', line)

  /*
   * 产物留档：`DOCVI_EXPORT_KEEP=1` 时不删产物目录，方便人工用浏览器/阅读器
   * 打开看一眼「实际长什么样」——脚本能断言的结构问题有限，排版观感只能肉眼看。
   */
  if (process.env.DOCVI_EXPORT_KEEP === '1') {
    log(`产物保留在: ${OUT}`)
  }

  if (verdict.some(line => line.startsWith('❗'))) process.exitCode = 1
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
