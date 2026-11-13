#!/usr/bin/env node
/**
 * 字体落地全量审计。
 *
 * 「哪里字体不对」不能靠肉眼枚举——CSS 写了字体栈不代表浏览器真的用了它。
 * 这个探针把每一类该用等宽字体的元素都找出来，对每个节点问 CDP：
 * `CSS.getPlatformFontsForNode` 返回**浏览器实际选中的字体族**与 glyph 数，
 * 这是渲染结果，能直接揭穿静默回退。
 *
 * 同时记录 `document.fonts` 的加载状态——「没加载」和「加载失败」是两回事。
 *
 * 用法：node scripts/dev/audit-fonts.mjs  （需先 pnpm docvi:build）
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
const TAG = `af${Date.now().toString(36)}`
const PORT = 9100 + Math.floor(Math.random() * 90)
const DATA = mkdtempSync(join(tmpdir(), `docvi-af-data-${TAG}-`))
const WS = mkdtempSync(join(tmpdir(), `docvi-af-ws-${TAG}-`))

/** 一页里把所有需要等宽的形态都放进去 */
const DOC = `# 字体审计

正文里的行内代码：\`canonical\`、\`src/demo/\`、\`font-family: var(--x)\`。

| 列一 | 列二 |
| --- | --- |
| 业务应用 | \`canonical\` 数据 |

\`\`\`text
├── 视频轨（1~N 路）
│   └── 深度相机
\`\`\`

\`\`\`ts
const message = 'iiii WWWW 0000'
interface FontFamily { id: string }
\`\`\`

- 列表里的 \`inline\` 代码
- 另一个 \`mono\` 例子
`

let child = null
const log = (...args) => console.log('[audit]', ...args)

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

/**
 * 要审计的选择器。
 *
 * `expect` 是这个位置**应该**用的字体族——用来判定是否符合预期：
 *  - `mono`：必须是等宽（JetBrains Mono 或它的回退）
 *  - `sans`：必须是正文无衬线（鸿蒙或系统无衬线）
 */
const TARGETS = [
  { key: 'code-block', selector: '.doc-surface [class*="language-"] pre code', expect: 'mono' },
  { key: 'inline-code', selector: '.doc-surface :not(pre) > code', expect: 'mono' },
  { key: 'table-cell-code', selector: '.doc-surface td code', expect: 'mono' },
  { key: 'doc-body', selector: '.doc-surface p', expect: 'sans' },
  { key: 'doc-heading', selector: '.doc-surface h1', expect: 'sans' },
  { key: 'tree-row', selector: '[data-tree-path]', expect: 'sans' },
  { key: 'statusbar-path', selector: '.statusbar, .status-bar', expect: 'sans' },
]

async function main() {
  mkdirSync(WS, { recursive: true })
  writeFileSync(join(WS, '字体审计.md'), DOC, 'utf8')

  child = spawn(ELECTRON, [APP_DIR, '--no-sandbox'], {
    env: {
      ...process.env,
      DOCVI_HEADLESS: '1',
      DOCVI_DATA_DIR: DATA,
      DOCVI_INSTANCE: `docvi-af-${TAG}`,
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
      .find(el => (el.dataset.treePath || '').endsWith('字体审计.md'))?.click()
  })()`)
  await sleep(5000)

  /* ---------- 字体加载状态（不强制 load，看自然状态） ---------- */
  const fontState = await client.evaluate(`
    [...document.fonts].map(f => ({
      family: f.family, weight: f.weight, status: f.status,
    }))
  `)
  log('字体面自然状态:')
  for (const item of fontState) log(`  ${item.family} ${item.weight} → ${item.status}`)

  await client.send('DOM.enable')
  await client.send('CSS.enable')
  const doc = await client.send('DOM.getDocument', { depth: -1 })
  const rootId = doc?.root?.nodeId

  /* ---------- 逐个目标查真实字体 ---------- */
  for (const target of TARGETS) {
    const count = await client.evaluate(`
      document.querySelectorAll(${JSON.stringify(target.selector)}).length
    `)
    if (!count) {
      log(`${target.key}: 页面上没有匹配元素（选择器可能过时）`)
      continue
    }

    const info = await client.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(target.selector)})
      const cs = getComputedStyle(el)
      return {
        text: (el.textContent || '').trim().slice(0, 24),
        fontFamily: cs.fontFamily,
        fontSize: cs.fontSize,
        tag: el.tagName.toLowerCase(),
        cls: (el.className || '').toString().slice(0, 50),
      }
    })()`)

    // 用一个临时属性精确定位到这个节点
    await client.evaluate(`
      document.querySelector(${JSON.stringify(target.selector)})
        ?.setAttribute('data-audit-hit', '1')
    `)
    const found = await client.send('DOM.querySelector', {
      nodeId: rootId,
      selector: '[data-audit-hit="1"]',
    })
    let platform = []
    if (found?.nodeId) {
      const fonts = await client.send('CSS.getPlatformFontsForNode', { nodeId: found.nodeId })
      platform = (fonts?.fonts ?? []).map(item => `${item.familyName}×${item.glyphCount}`)
    }
    await client.evaluate(`
      document.querySelector('[data-audit-hit="1"]')?.removeAttribute('data-audit-hit')
    `)

    log(`${target.key}: <${info.tag}> 期望 ${target.expect}`)
    log(`  文本: ${JSON.stringify(info.text)}`)
    log(`  CSS:  ${info.fontFamily}`)
    log(`  实际: ${platform.length ? platform.join(', ') : '（无 glyph，可能不可见）'}`)
  }

  client.close()
}

main()
  .catch(error => {
    log('审计失败:', error.message)
    process.exitCode = 1
  })
  .finally(async () => {
    cleanup()
    log('已清理')
  })
