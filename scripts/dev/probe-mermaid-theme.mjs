#!/usr/bin/env node
/**
 * 一次性功能探针：验证 mermaid 主题映射与 hover 联动的端到端效果。
 *
 *   阶段一（默认暗色主题 slate）：
 *     1. SVG 配色 = --dv-mermaid-* 派生变量的解析值（不是 mermaid 默认配色）；
 *     2. hover flowchart 节点 → is-focus + 相邻边/节点 is-hot，离开后清空；
 *     3. stateDiagram 边 id 无端点 → 安全降级（不挂 is-focus）；
 *     4. 灯箱里的 SVG 快照同样支持 hover 联动。
 *   阶段二（改 settings.json 为 paper 亮色后重启）：
 *     5. 同一文档的 SVG 配色跟随亮色主题（initialize 按主题签名重跑）。
 *
 * 用法：node scripts/dev/probe-mermaid-theme.mjs   （需先 pnpm docvi:build）
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const ELECTRON = join(ROOT, 'apps/desktop/node_modules/electron/dist/electron.exe')
const APP_DIR = join(ROOT, 'apps/desktop')
const TAG = `probe${Date.now().toString(36)}`
const PORT = 9900 + Math.floor(Math.random() * 90)
const DATA = mkdtempSync(join(tmpdir(), `docvi-mtheme-data-${TAG}-`))
const WS = mkdtempSync(join(tmpdir(), `docvi-mtheme-ws-${TAG}-`))

const DOC = join(WS, '图示探针.md')
/*
 * 第一张图与用户真实图**结构同构**（2026-10-29 实测缺陷的复现场景）：
 * 自环 C→C、双向平行 C↔D、无标签边 D→F、三跳长链单行语法 B→B2→B。
 * 只有保留这些结构，才能钉住「标签错配导致高亮边的文字被误淡出」。
 */
const DOC_BODY = `# 图示探针

\`\`\`mermaid
flowchart TD
  A[列表] -->|创建| B[表单]
  B -->|校验通过| C[草稿]
  B -->|校验失败| B2[错误提示] --> B
  C -->|上架| D[已上架]
  D -->|下架| C
  C -->|编辑| C
  C -->|删除| E[已删除]
  D --> F[前台展示]
\`\`\`

\`\`\`mermaid
stateDiagram-v2
  [*] --> 空闲
  空闲 --> 运行: 启动
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
      return new Promise(done2 => {
        const id = ++nextId
        pending.set(id, message => done2(message.result))
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

function killTree() {
  if (!child) return
  spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  child = null
}

function cleanup() {
  killTree()
  for (const dir of [DATA, WS]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
    } catch {
      // 收尾失败不影响结论
    }
  }
}

async function until(client, expression, check, { attempts = 40, gap = 250 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    await sleep(gap)
    const value = await client.evaluate(expression)
    if (check(value)) return value
  }
  return null
}

/** 启动应用并打开文档，返回 CDP client */
async function boot() {
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
  return client
}

async function openProbeDoc(client) {
  const added = await client.evaluate(
    `window.docvi.workspaceAddAt(${JSON.stringify(WS)}).then(r => r)`,
  )
  if (!added?.ok) throw new Error(`登记工作区失败：${JSON.stringify(added)}`)
  await client.evaluate('location.reload()')
  await sleep(3200)
  // 重启会恢复上次打开的标签：先切回文档库视图再找工作区卡片
  await client.evaluate(`(() => {
    document.querySelector('.tab--library')?.click()
  })()`)
  await sleep(1200)
  const opened = await client.evaluate(`(() => {
    const cards = [...document.querySelectorAll('.card')]
    const hit = cards.find(el => (el.textContent || '').includes(${JSON.stringify(WS)}))
    if (!hit) return { ok: false }
    hit.click()
    return { ok: true }
  })()`)
  if (!opened?.ok) throw new Error('找不到工作区卡片')
  await sleep(1500)
  const row = await until(
    client,
    `Boolean(document.querySelector('[data-tree-path="图示探针.md"]'))`,
    hit => hit,
  )
  if (!row) {
    const diag = await client.evaluate(`(() => ({
      paths: [...document.querySelectorAll('[data-tree-path]')].map(el => el.dataset.treePath),
      sidebarEmpty: document.querySelector('.sidebar__empty')?.textContent?.trim() ?? null,
      tabs: [...document.querySelectorAll('.tab')].map(el => (el.textContent || '').trim().slice(0, 30)),
    }))()`)
    throw new Error(`树里没有探针文档：${JSON.stringify(diag)}`)
  }
  await client.evaluate(`(() => {
    document.querySelector('[data-tree-path="图示探针.md"]').click()
  })()`)
  await sleep(2600)
}

/** 归一化色值：'#1d2127' / 'rgb(29,33,39)' → 'rgb(29,33,39)' */
function normalizeColor(value) {
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim())
  if (hex) {
    const n = Number.parseInt(hex[1], 16)
    return `rgb(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255})`
  }
  const rgb = /rgba?\(([^)]+)\)/.exec(value)
  if (rgb)
    return `rgb(${rgb[1]
      .split(',')
      .map(part => Number.parseFloat(part.trim()))
      .join(',')})`
  return value.trim()
}

/** 主断言：SVG 关键元素配色 = 派生变量的解析值 */
async function assertThemeColors(client, label) {
  const result = await client.evaluate(`(() => {
    const rootStyle = getComputedStyle(document.documentElement)
    const token = name => rootStyle.getPropertyValue(name).trim()
    const svg = document.querySelector('.at-mermaid svg')
    if (!svg) return { ok: false, reason: 'no mermaid svg' }
    const nodeRect = svg.querySelector('.node rect, .node polygon')
    const edge = svg.querySelector('path.flowchart-link')
    const style = nodeRect ? getComputedStyle(nodeRect) : null
    return {
      ok: true,
      theme: document.documentElement.dataset.theme,
      nodeFill: style?.fill ?? null,
      nodeStroke: style?.stroke ?? null,
      edgeStroke: edge ? getComputedStyle(edge).stroke ?? edge.getAttribute('stroke') : null,
      nodeBg: token('--dv-mermaid-node-bg'),
      nodeBorder: token('--dv-mermaid-node-border'),
      line: token('--dv-mermaid-line'),
    }
  })()`)
  if (!result?.ok) throw new Error(`[${label}] 没找到 mermaid SVG：${JSON.stringify(result)}`)
  const eq = (a, b) => normalizeColor(String(a)) === normalizeColor(String(b))
  if (!eq(result.nodeFill, result.nodeBg)) {
    throw new Error(
      `[${label}] 节点填充 ${result.nodeFill} ≠ token ${result.nodeBg}（主题 ${result.theme}）`,
    )
  }
  if (!eq(result.edgeStroke, result.line)) {
    throw new Error(
      `[${label}] 连线色 ${result.edgeStroke} ≠ token ${result.line}（主题 ${result.theme}）`,
    )
  }
  log(`配色断言通过（${label}，主题=${result.theme}）：节点 ${result.nodeFill}`)
}

async function main() {
  writeFileSync(DOC, DOC_BODY, 'utf8')

  /* ---------- 阶段一：默认暗色主题 ---------- */
  const client = await boot()
  await openProbeDoc(client)
  await until(client, `Boolean(document.querySelector('.at-mermaid svg .node'))`, hit => hit, {
    attempts: 30,
    gap: 300,
  })
  await assertThemeColors(client, '阶段一/暗色')

  /* hover 联动：节点 → 相邻边 + 对端节点 + 边标签高亮，无关标签淡出 */
  const hover = await client.evaluate(`(() => {
    const svg = document.querySelector('.at-mermaid svg')
    // 选 C（草稿）：相邻边 B→C、C→D、C→E、自环 C→C 共 4 条，全部带标签。
    // 这是错配 bug 的最强杀手场景——自环边在 path 序里靠后、标签在中间。
    const node = [...svg.querySelectorAll('g.node')].find(el => (el.id || '').includes('-C-'))
    node.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
    const hotLabels = [...svg.querySelectorAll('g.edgeLabels > g.edgeLabel.is-hot')]
    const allLabels = [...svg.querySelectorAll('g.edgeLabels > g.edgeLabel')]
    const hotIndexes = allLabels.map((l, i) => (l.classList.contains('is-hot') ? i : -1)).filter(i => i >= 0)
    const coldIndexes = allLabels.map((l, i) => (l.classList.contains('is-hot') ? -1 : i)).filter(i => i >= 0)
    return {
      hovered: node.id,
      focus: svg.classList.contains('is-focus'),
      hotEdges: [...svg.querySelectorAll('path.flowchart-link.is-hot')].map(el => el.id),
      hotNodes: [...svg.querySelectorAll('g.node.is-hot')].map(el => el.id),
      hotLabels: hotLabels.length,
      hotLabelTexts: hotLabels.map(l => (l.textContent || '').trim()),
      // 提层判据：hot 标签整体的最小 index 必须大于所有非 hot 标签的最大 index
      raised:
        hotIndexes.length > 0 &&
        coldIndexes.length > 0 &&
        Math.min(...hotIndexes) > Math.max(...coldIndexes),
      dimmedLabels: coldIndexes.length,
    }
  })()`)
  if (!hover.focus) throw new Error('hover 节点后 svg 没有 is-focus')
  // C 的相邻边：B→C、C→D、D→C、C→E、自环 C→C 共 5 条（C↔D 双向各一条）
  if (hover.hotEdges.length !== 5) {
    throw new Error(
      `hover C 应命中 5 条相邻边，实际 ${hover.hotEdges.length}：${JSON.stringify(hover)}`,
    )
  }
  if (hover.hotLabels !== 5) {
    throw new Error(`hover C 应命中 5 个标签，实际 ${hover.hotLabels}：${JSON.stringify(hover)}`)
  }
  // 标签内容必须与相邻边一致，且不得错配到无关边
  const expected = ['校验通过', '上架', '下架', '删除', '编辑']
  for (const text of expected) {
    if (!hover.hotLabelTexts.includes(text)) {
      throw new Error(`高亮标签缺「${text}」：${JSON.stringify(hover.hotLabelTexts)}`)
    }
  }
  for (const wrong of ['创建', '校验失败']) {
    if (hover.hotLabelTexts.includes(wrong)) {
      throw new Error(`无关标签「${wrong}」被错误高亮：${JSON.stringify(hover.hotLabelTexts)}`)
    }
  }
  if (!hover.raised) throw new Error('高亮的边标签没有提层到容器末尾')
  if (hover.dimmedLabels < 1) throw new Error('无关边标签没有参与淡出')
  log('hover 联动通过：', JSON.stringify(hover), '，标签已提层')

  const cleared = await client.evaluate(`(() => {
    const svg = document.querySelector('.at-mermaid svg')
    svg.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }))
    const r1 = {
      focus: svg.classList.contains('is-focus'),
      hotCount: svg.querySelectorAll('.is-hot').length,
    }
    // 再验证「挪到空白处」也要清：hover 节点 → hover svg 自身（空白）
    svg.querySelector('.node').dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
    svg.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
    return {
      leave: r1,
      blank: {
        focus: svg.classList.contains('is-focus'),
        hotCount: svg.querySelectorAll('.is-hot').length,
      },
    }
  })()`)
  if (cleared.leave.focus || cleared.leave.hotCount !== 0) {
    throw new Error(`pointerleave 没有清空联动：${JSON.stringify(cleared.leave)}`)
  }
  if (cleared.blank.focus || cleared.blank.hotCount !== 0) {
    throw new Error(`hover 到空白没有清除残留：${JSON.stringify(cleared.blank)}`)
  }
  log('离开/空白清空通过')

  /* stateDiagram 安全降级：不挂 is-focus */
  const stateCheck = await client.evaluate(`(() => {
    const state = [...document.querySelectorAll('.at-mermaid svg')].find(el =>
      el.querySelector('.node') && ![...el.querySelectorAll('path')].some(p => (p.id || '').includes('L_')))
    if (!state) return { ok: false }
    state.querySelector('.node')?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
    return { ok: true, focused: state.classList.contains('is-focus') }
  })()`)
  if (stateCheck.ok && stateCheck.focused) {
    throw new Error('stateDiagram 应安全降级（不应挂 is-focus）')
  }
  log('stateDiagram 降级通过')

  /* 点击图本身不开灯箱；全屏入口是右上角按钮 */
  await client.evaluate(`(() => {
    document.querySelector('.at-mermaid svg .node').dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    )
  })()`)
  await sleep(800)
  const clickNoLightbox = await client.evaluate(
    `Boolean(document.querySelector('.lightbox__svg svg'))`,
  )
  if (clickNoLightbox) throw new Error('点击图本身仍然打开了灯箱')
  const expandBtn = await client.evaluate(`Boolean(document.querySelector('.at-mermaid__expand'))`)
  if (!expandBtn) throw new Error('图容器右上角没有全屏按钮')
  await client.evaluate(`(() => {
    document.querySelector('.at-mermaid__expand').click()
  })()`)
  const lightboxSvg = await until(
    client,
    `Boolean(document.querySelector('.lightbox__svg svg'))`,
    hit => hit,
  )
  if (!lightboxSvg) throw new Error('点击全屏按钮后灯箱没有打开')
  const lightboxHover = await client.evaluate(`(() => {
    const svg = document.querySelector('.lightbox__svg svg')
    svg.querySelector('.node')?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
    return { focus: svg.classList.contains('is-focus'), hot: svg.querySelectorAll('.is-hot').length }
  })()`)
  if (!lightboxHover.focus || lightboxHover.hot < 2) {
    throw new Error(`灯箱内 hover 联动没生效：${JSON.stringify(lightboxHover)}`)
  }
  log('灯箱 hover 联动通过：', JSON.stringify(lightboxHover))
  await client.evaluate(`(() => {
    document.querySelector('.lightbox__btn--close')?.click()
  })()`)
  client.close()
  killTree()

  /* ---------- 阶段二：切 paper 亮色主题后重启 ---------- */
  const settingsPath = join(DATA, 'settings.json')
  const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {}
  settings.theme = 'paper'
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8')

  const client2 = await boot()
  await openProbeDoc(client2)
  await until(client2, `Boolean(document.querySelector('.at-mermaid svg .node'))`, hit => hit, {
    attempts: 30,
    gap: 300,
  })
  await assertThemeColors(client2, '阶段二/亮色')
  client2.close()
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
