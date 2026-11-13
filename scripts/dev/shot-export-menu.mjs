#!/usr/bin/env node
/**
 * 文档头部导出入口的截图：默认态与展开态各一张。
 *
 * 导出原先只能从命令面板（Ctrl+K）搜到，界面上没有任何按钮——用户根本不知道
 * 有这功能。这个脚本用来确认按钮落在文档头部统计行旁、下拉菜单三种格式都在。
 *
 * 用法：node scripts/dev/shot-export-menu.mjs  （需先 pnpm docvi:build）
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
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const ELECTRON = join(ROOT, 'apps/desktop/node_modules/electron/dist/electron.exe')
const APP_DIR = join(ROOT, 'apps/desktop')
const TAG = `ex${Date.now().toString(36)}`
const PORT = 9600 + Math.floor(Math.random() * 90)
const DATA = mkdtempSync(join(tmpdir(), `docvi-ex-data-${TAG}-`))
const WS = mkdtempSync(join(tmpdir(), `docvi-ex-ws-${TAG}-`))
/* 产物落点也是临时目录：探针不往用户的文档目录写任何东西 */
const EXPORT_DIR = mkdtempSync(join(tmpdir(), `docvi-ex-out-${TAG}-`))
const OUT = join(ROOT, '.temp/export-shots')
mkdirSync(OUT, { recursive: true })

const DOC = `# 导出入口验证

正文里的英文：canonical version 2026 numbers 0123456789。

## 二级标题

- 列表项一
- 列表项二

\`\`\`ts
const message = 'code block stays monospaced'
\`\`\`
`

let child = null
const log = (...args) => console.log('[shot]', ...args)

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
  for (const dir of [DATA, WS, EXPORT_DIR]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
    } catch {
      // 忽略
    }
  }
}

async function main() {
  writeFileSync(join(WS, '导出入口验证.md'), DOC, 'utf8')

  child = spawn(ELECTRON, [APP_DIR, '--no-sandbox'], {
    env: {
      ...process.env,
      DOCVI_HEADLESS: '1',
      DOCVI_DATA_DIR: DATA,
      DOCVI_INSTANCE: `docvi-ex-${TAG}`,
      DOCVI_DEBUG_PORT: String(PORT),
      /* 跳过系统保存框：CDP 碰不到 OS 窗口，钩子只改落点不改产物流水线 */
      DOCVI_EXPORT_DIR: EXPORT_DIR,
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
    height: 820,
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
      .find(el => (el.dataset.treePath || '').endsWith('导出入口验证.md'))?.click()
  })()`)
  await sleep(4000)

  async function shoot(name) {
    const data = await client.send('Page.captureScreenshot', { format: 'png' })
    const file = join(OUT, `${name}.png`)
    writeFileSync(file, Buffer.from(data.data, 'base64'))
    log(`已存 ${file}`)
  }

  /** 头部统计行的实际内容，确认按钮确实渲染出来了 */
  const head = await client.evaluate(`(() => {
    const meta = document.querySelector('.reader__meta')
    if (!meta) return { error: '找不到 .reader__meta' }
    const buttons = [...meta.querySelectorAll('button')].map(b => b.getAttribute('aria-label'))
    return { buttons, text: (meta.querySelector('.reader__stats')?.textContent || '').trim() }
  })()`)
  log('头部:', JSON.stringify(head))

  await shoot('collapsed')

  // 展开导出菜单
  const opened = await client.evaluate(`(() => {
    const btn = [...document.querySelectorAll('.reader__meta button')]
      .find(b => (b.getAttribute('aria-label') || '').includes('导出'))
    if (!btn) return false
    btn.click()
    return true
  })()`)
  if (!opened) throw new Error('没找到导出按钮')
  await sleep(600)

  const menu = await client.evaluate(`(() => {
    const items = [...document.querySelectorAll('[role="menuitem"], .menu__item')]
    return items.map(el => (el.textContent || '').replace(/\\s+/g, ' ').trim())
  })()`)
  log('菜单项:', JSON.stringify(menu))

  await shoot('menu-open')

  /*
   * 真点一遍每种格式，靠 DOCVI_EXPORT_DIR 跳过系统保存框。
   *
   * 只截图不点，验证不到「按钮 → 事件 → 导出参数 → 落盘」这条链：菜单项渲染
   * 对了、但 emit 名字写错或 payload 没拼好时，界面看起来毫无问题。系统保存框
   * 是 OS 级窗口、CDP 碰不到，所以主进程提供了 DOCVI_EXPORT_DIR 钩子——它只改
   * 落点，不改产物生成逻辑。
   */
  const results = await client.evaluate(`(async () => {
    const seen = []
    for (const label of ['Markdown 源文件', 'HTML 单文件', 'PDF']) {
      /*
       * 只有菜单没开时才点按钮。上一轮选完一项菜单已自动关闭，但如果某项
       * 没找着，菜单会留在打开态——这时再点按钮就是「关掉」，后面全部落空。
       */
      if (!document.querySelector('.menu')) {
        const btn = [...document.querySelectorAll('.reader__meta button')]
          .find(b => (b.getAttribute('aria-label') || '').includes('导出'))
        if (!btn) { seen.push({ error: '找不到导出按钮' }); break }
        btn.click()
        await new Promise(r => setTimeout(r, 400))
      }
      const item = [...document.querySelectorAll('.menu__item')]
        .find(el => (el.textContent || '').includes(label))
      if (!item) { seen.push({ error: '菜单项缺失: ' + label }); continue }
      item.click()
      // 等主进程写完盘、提示条回填（成功也走 .toast，不是 .notice）
      await new Promise(r => setTimeout(r, 1500))
      const notice = document.querySelector('.toast__text')?.textContent?.trim() ?? ''
      seen.push({ label, notice })
    }
    return seen
  })()`)
  log('导出结果:', JSON.stringify(results))

  /* 产物真落盘才算通过：提示条说「已导出」但文件不存在，等于没导出 */
  const expected = [
    { format: 'markdown', file: '导出入口验证.md', minBytes: 50 },
    { format: 'html', file: '导出入口验证.html', minBytes: 2000 },
    { format: 'pdf', file: '导出入口验证.pdf', minBytes: 2000 },
  ]
  const bad = []
  for (const item of expected) {
    const file = join(EXPORT_DIR, item.file)
    if (!existsSync(file)) {
      bad.push(`${item.format} 产物不存在：${item.file}`)
      continue
    }
    const size = statSync(file).size
    if (size < item.minBytes) bad.push(`${item.format} 产物太小：${size} 字节`)
    else log(`✓ ${item.format}: ${item.file}（${(size / 1024).toFixed(1)} KB）`)
  }

  /* HTML 必须自包含：没有任何外部 src/href 指向本地文件 */
  const htmlFile = join(EXPORT_DIR, '导出入口验证.html')
  if (existsSync(htmlFile)) {
    const html = readFileSync(htmlFile, 'utf8')
    if (/<img[^>]+src="(?!data:)/.test(html)) bad.push('HTML 里有未内联的图片')
    if (!/data-mono-latin|JetBrains Mono/.test(html)) bad.push('HTML 丢了字体信息')
    if (!/data-theme=/.test(html)) bad.push('HTML 丢了主题属性')
  }

  if (bad.length) {
    log('❗ 结论:', bad.join('；'))
    process.exitCode = 1
  } else {
    log('✓ 结论: 三种产物都落盘且内容完整')
  }
  client.close()
}

main()
  .catch(error => {
    log('失败:', error.message)
    process.exitCode = 1
  })
  .finally(async () => {
    cleanup()
  })
