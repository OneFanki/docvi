#!/usr/bin/env node
/**
 * 把 PDF 逐页渲染成 PNG，供人眼确认「产物到底长什么样」。
 *
 * PDF 里的文本是 CID/ToUnicode 编码，`grep '中文'` 永远搜不到——搜不到不代表
 * 没渲染。唯一可靠的判断是看像素。
 *
 * 做法：Chromium 内置 PDF 阅读器加载 → 用键盘/脚本滚动到每一页 → 截图。
 * 不引第三方 PDF 渲染库（pdfjs-dist 会往仓库里塞一份 wasm + worker）。
 *
 * 用法：node scripts/dev/pdf-to-png.mjs <pdf 路径> [输出目录]
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const ELECTRON = join(ROOT, 'apps/desktop/node_modules/electron/dist/electron.exe')

const pdfPath = process.argv[2]
if (!pdfPath) {
  console.error('用法: node scripts/dev/pdf-to-png.mjs <pdf> [outDir]')
  process.exit(1)
}
const outDir = process.argv[3] ?? join(dirname(pdfPath), 'pdf-pages')
mkdirSync(outDir, { recursive: true })

const runner = join(outDir, '_runner.cjs')
writeFileSync(
  runner,
  String.raw`
const { app, BrowserWindow } = require('electron')
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')

const pdf = process.argv[2]
const out = process.argv[3]
const wait = ms => new Promise(r => setTimeout(r, ms))

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1100,
    height: 1500,
    webPreferences: { plugins: true, sandbox: false },
  })
  await win.loadURL('file://' + pdf.replace(/\\/g, '/'))
  await wait(6000)

  // 内置阅读器的页面容器是 <embed> 时拿不到 shadow DOM；改用滚动截图
  const before = await win.webContents.capturePage()
  writeFileSync(join(out, 'page-1.png'), before.toPNG())

  for (let index = 2; index <= 6; index += 1) {
    // PageDown 在 PDF 阅读器里翻页；到底了图会重复，靠字节数相同判断停止
    win.webContents.sendInputEvent({ type: 'mouseWheel', x: 600, y: 700, deltaX: 0, deltaY: -1400 })
    await wait(1800)
    const shot = await win.webContents.capturePage()
    const png = shot.toPNG()
    writeFileSync(join(out, 'page-' + index + '.png'), png)
    process.stdout.write('[pdf2png] page-' + index + ' ' + png.length + 'B\n')
  }

  win.destroy()
  app.quit()
})
`,
  'utf8',
)

const result = spawnSync(ELECTRON, [runner, pdfPath, outDir], {
  encoding: 'utf8',
  timeout: 120_000,
})
if (result.stdout?.trim()) console.log(result.stdout.trim())
if (result.stderr?.trim()) console.error(result.stderr.trim().slice(-400))
console.log('[pdf2png] 输出:', outDir)
