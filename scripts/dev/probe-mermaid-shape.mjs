#!/usr/bin/env node
/**
 * 一次性结构探针：dump mermaid 11.17.2 渲染产物的 SVG id/class 形态。
 *
 * hover 增强需要从 SVG 元素上解析「节点名」与「边的两端」，这依赖 mermaid
 * 生成 SVG 的 id 约定（如 flowchart 的边 id `L_{from}_{to}_{n}`）。版本升级
 * 可能改变这些约定——适配逻辑集中在增强函数里，本探针就是它的回归依据。
 *
 * 不启动 docvi 应用：临时 HTML + 仓库 Electron 无头加载，页面把结构摘要
 * 打到 console，主进程捕获后写 .temp/mermaid-shape.json 并退出。
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const ELECTRON = join(ROOT, 'apps/desktop/node_modules/electron/dist/electron.exe')
const MERMAID_ESM = join(
  ROOT,
  'node_modules/.pnpm/mermaid@11.17.2/node_modules/mermaid/dist/mermaid.esm.min.mjs',
)
const TEMP = mkdtempSync(join(tmpdir(), 'docvi-mermaid-shape-'))
const OUT = join(ROOT, '.temp/mermaid-shape.json')

const DIAGRAMS = {
  flowchart: `flowchart TD
  A[开始] --> B[处理]
  B --> C{判断}
  C -->|是| D[结束]
  C -->|否| B`,
  state: `stateDiagram-v2
  [*] --> 空闲
  空闲 --> 运行: 启动
  运行 --> 空闲: 停止`,
  sequence: `sequenceDiagram
  A->>B: 请求
  B-->>A: 响应`,
  er: `erDiagram
  user ||--o{ order : places
  order }o--|| product : contains`,
}

const PAGE = `<!doctype html>
<html><body>
<script type="module">
const digest = (svg) => ({
  rootClass: svg.getAttribute('class'),
  rootId: svg.id,
  nodes: [...svg.querySelectorAll('[class*="node"], [class*="actor"]')].slice(0, 6).map((n) => ({
    tag: n.tagName, id: n.id, class: n.getAttribute('class'),
  })),
  edges: [...svg.querySelectorAll('[id^="L_"], [id^="edge"], [class*="edge-"], [class*="Link"], [class*="relation"]')].slice(0, 8).map((e) => ({
    tag: e.tagName, id: e.id, class: e.getAttribute('class'),
  })),
  edgePaths: [...svg.querySelectorAll('path[class*="flow"], path[class*="edge"], .edgePaths path, .relation')].slice(0, 8).map((e) => ({
    tag: e.tagName, id: e.id, class: e.getAttribute('class'), markerEnd: e.getAttribute('marker-end')?.slice(0, 60) ?? null,
  })),
  groups: [...svg.querySelectorAll('[class*="cluster"], [class*="label"]')].slice(0, 4).map((g) => ({
    tag: g.tagName, id: g.id, class: g.getAttribute('class'),
  })),
  edgeLabels: [...svg.querySelectorAll('[class*="edgeLabel"], .edgeLabels > g, [id^="L_"]:not(path)')].slice(0, 6).map((g) => ({
    tag: g.tagName, id: g.id, class: g.getAttribute('class'),
    parentClass: g.parentElement?.getAttribute('class') ?? null,
  })),
})
try {
  const mermaid = (await import(${JSON.stringify(pathToFileURL(MERMAID_ESM).href)})).default
  mermaid.initialize({ startOnLoad: false, securityLevel: 'loose', theme: 'base' })
  const result = {}
  for (const [name, code] of Object.entries(${JSON.stringify(DIAGRAMS)})) {
    try {
      const { svg } = await mermaid.render('probe-' + name, code)
      const holder = document.createElement('div')
      holder.innerHTML = svg
      const el = holder.querySelector('svg')
      result[name] = el ? digest(el) : { error: 'no svg root' }
    } catch (error) {
      result[name] = { error: String(error).slice(0, 200) }
    }
  }
  console.log('SHAPE_JSON:' + JSON.stringify(result))
} catch (error) {
  console.log('SHAPE_JSON:' + JSON.stringify({ fatal: String(error).slice(0, 300) }))
}
</script>
</body></html>`

const MAIN = `
const { app, BrowserWindow } = require('electron')
const lines = []
app.whenReady().then(() => {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: false } })
  win.webContents.on('console-message', (_e, _level, message) => lines.push(message))
  win.webContents.on('render-process-gone', () => { console.log('RENDER_GONE'); app.exit(1) })
  win.loadFile(${JSON.stringify(join(TEMP, 'probe.html'))}).then(async () => {
    for (let i = 0; i < 120; i += 1) {
      await new Promise((r) => setTimeout(r, 500))
      if (lines.some((l) => l.includes('SHAPE_JSON:'))) break
    }
    const hit = lines.find((l) => l.includes('SHAPE_JSON:'))
    console.log(hit ?? 'SHAPE_JSON:{"fatal":"页面没有产出结果"}')
    app.exit(0)
  })
})
`

mkdirSync(join(ROOT, '.temp'), { recursive: true })
writeFileSync(join(TEMP, 'probe.html'), PAGE, 'utf8')
writeFileSync(join(TEMP, 'main.cjs'), MAIN, 'utf8')

const run = spawnSync(ELECTRON, [join(TEMP, 'main.cjs')], {
  stdio: ['ignore', 'pipe', 'pipe'],
  timeout: 90000,
})
const stdout = String(run.stdout ?? '')
const line = stdout.split('\n').find(l => l.includes('SHAPE_JSON:'))
rmSync(TEMP, { recursive: true, force: true })
if (!line) {
  console.error('[probe] 没有拿到结果，stderr:', String(run.stderr ?? '').slice(0, 500))
  process.exit(1)
}
const payload = JSON.parse(line.slice(line.indexOf('SHAPE_JSON:') + 'SHAPE_JSON:'.length))
writeFileSync(OUT, JSON.stringify(payload, null, 2), 'utf8')
console.log(`[probe] 已写 ${OUT}\n`)
for (const [name, digest] of Object.entries(payload)) {
  console.log(`=== ${name} ===`)
  console.log(JSON.stringify(digest, null, 1).slice(0, 1800))
  console.log()
}
