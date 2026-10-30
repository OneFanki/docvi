#!/usr/bin/env node
/**
 * 一次性诊断探针：用用户真实图的 mermaid 源码 dump edgePaths 与 edgeLabels 的
 * 真实对应关系，定位「高亮边的标签被误淡出」的根因。
 *
 * 两张图来自用户文档（数据货架-前端功能文档.md），关键特征齐全：
 * 无标签边、自环边、平行边（同两端不同标签）、长链单行语法。
 *
 * 用法：node scripts/dev/probe-mermaid-edge-map.mjs
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
const TEMP = mkdtempSync(join(tmpdir(), 'docvi-edge-map-'))

const DIAGRAMS = {
  lifecycle: `flowchart TD
    A[数据货架管理列表] -->|添加数据商品| B[填写商品表单抽屉]
    B -->|确认·校验通过| C[创建成功 状态=已下架 草稿]
    B -->|校验失败| B2[字段下方红字提示 不发请求] --> B
    C -->|上架·确认弹窗| D[状态=已上架 商城可见]
    D -->|下架·确认弹窗| C
    C -->|编辑·仅已下架可编辑| C
    C -->|删除·确认弹窗| E[删除成功 列表刷新]
    D --> F[前台商城展示为商品卡片/详情]`,
  browse: `flowchart TD
    A[打开商城 /market] --> B[浏览商品卡片列表]
    B --> C{筛选 / 搜索}
    C -->|点击左侧分类 chip 含级联子面板| D[按分类节点重新请求列表 页码回第1页]
    C -->|输入名称 400ms 防抖或回车/点搜索| D
    B -->|点击卡片任意位置| E[商品详情页]
    E -->|数据介绍 / 视频介绍| F[tab 本地切换 不发请求]
    E -->|咨询并获取数据| G[售前咨询弹窗 复制邮箱]`,
}

const PAGE = `<!doctype html>
<html><body>
<script type="module">
const dump = (svg) => {
  const paths = [...svg.querySelectorAll('path.flowchart-link')]
  // 边标签只认 edgeLabels 容器内的：节点内部也用 edgeLabel 类名，混进来会污染数量
  const labels = [...svg.querySelectorAll('g.edgeLabels > g.edgeLabel')].map((g) => ({
    text: (g.textContent || '').trim().slice(0, 24),
  }))
  // 几何：统一到**屏幕坐标**比较——label 带 transform:translate，getBBox 是局部
  // 坐标系，与 path 的 getPointAtLength 不可直接比较（实测错到几百 px）
  const pathMid = paths.map((p) => {
    try {
      const len = p.getTotalLength()
      const local = p.getPointAtLength(len / 2)
      const ctm = p.getScreenCTM()
      if (!ctm) return null
      const point = new DOMPoint(local.x, local.y).matrixTransform(ctm)
      return { x: Math.round(point.x), y: Math.round(point.y) }
    } catch {
      return null
    }
  })
  const labelCenter = [...svg.querySelectorAll('g.edgeLabels > g.edgeLabel')].map((g) => {
    // 用 SVG 原生 API 取 translate，避免正则经模板字符串/字符串字面量两层转义
    const list = g.transform?.baseVal
    const t = list && list.numberOfItems > 0 ? list.consolidate() : null
    if (!t) return { raw: g.getAttribute('transform') || '' }
    return {
      x: Math.round(t.matrix.e),
      y: Math.round(t.matrix.f),
      raw: g.getAttribute('transform') || '',
    }
  })
  // 距离矩阵 + 贪心配对（验证几何方案是否可靠）
  const pairs = []
  for (let i = 0; i < paths.length; i += 1) {
    for (let j = 0; j < labels.length; j += 1) {
      const a = pathMid[i]
      const b = labelCenter[j]
      if (!a || !b || typeof b.x !== 'number') continue
      pairs.push({ i, j, d: Math.round(Math.hypot(a.x - b.x, a.y - b.y)) })
    }
  }
  pairs.sort((a, b) => a.d - b.d)
  const usedPath = new Set()
  const usedLabel = new Set()
  const matched = []
  for (const pair of pairs) {
    if (usedPath.has(pair.i) || usedLabel.has(pair.j)) continue
    usedPath.add(pair.i)
    usedLabel.add(pair.j)
    matched.push({ path: paths[pair.i].id, pathIdx: pair.i, label: labels[pair.j].text, labelIdx: pair.j, dist: pair.d })
  }
  matched.sort((a, b) => a.pathIdx - b.pathIdx)
  const matrix = paths.map((p, i) => ({
    path: p.id,
    dists: labelCenter.map((c, j) => (c && typeof c.x === 'number' && pathMid[i] ? Math.round(Math.hypot(pathMid[i].x - c.x, pathMid[i].y - c.y)) : -1)),
  }))
  return {
    pathCount: paths.length,
    labelCount: labels.length,
    paths: paths.map((p, i) => ({ idx: i, id: p.id })),
    labels: labels.map((l, i) => ({ idx: i, text: l.text })),
    pathMid,
    labelCenter,
    // 诊断：为什么几何取不到
    diag: {
      svgCTM: (() => {
        try {
          return Boolean(svg.getScreenCTM())
        } catch {
          return 'throw'
        }
      })(),
      firstPathCTM: (() => {
        try {
          return Boolean(paths[0]?.getScreenCTM())
        } catch (e) {
          return 'throw:' + e
        }
      })(),
      firstPathLen: (() => {
        try {
          return paths[0]?.getTotalLength() ?? null
        } catch {
          return 'throw'
        }
      })(),
      firstLabelRect: (() => {
        try {
          const box = [...svg.querySelectorAll('g.edgeLabels > g.edgeLabel')[0]]?.getBoundingClientRect()
          return box ? { w: Math.round(box.width), h: Math.round(box.height), l: Math.round(box.left) } : null
        } catch {
          return 'throw'
        }
      })(),
    },
    matched,
    matrix,
  }
}
try {
  const mermaid = (await import(${JSON.stringify(pathToFileURL(MERMAID_ESM).href)})).default
  mermaid.initialize({ startOnLoad: false, securityLevel: 'loose', theme: 'base' })
  const result = {}
  for (const [name, code] of Object.entries(${JSON.stringify(DIAGRAMS)})) {
    try {
      const { svg } = await mermaid.render('map-' + name, code)
      const holder = document.createElement('div')
      holder.innerHTML = svg
      result[name] = dump(holder.querySelector('svg'))
    } catch (error) {
      result[name] = { error: String(error).slice(0, 300) }
    }
  }
  console.log('MAP_JSON:' + JSON.stringify(result))
} catch (error) {
  console.log('MAP_JSON:' + JSON.stringify({ fatal: String(error).slice(0, 400) }))
}
</script>
</body></html>`

const MAIN = `
const { app, BrowserWindow } = require('electron')
const lines = []
app.whenReady().then(() => {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: false } })
  win.webContents.on('console-message', (_e, _level, message) => lines.push(message))
  win.loadFile(${JSON.stringify(join(TEMP, 'probe.html'))}).then(async () => {
    for (let i = 0; i < 120; i += 1) {
      await new Promise((r) => setTimeout(r, 500))
      if (lines.some((l) => l.includes('MAP_JSON:'))) break
    }
    const hit = lines.find((l) => l.includes('MAP_JSON:'))
    console.log(hit ?? 'MAP_JSON:{"fatal":"页面没有产出结果"}')
    app.exit(0)
  })
})
`

mkdirSync(TEMP, { recursive: true })
writeFileSync(join(TEMP, 'probe.html'), PAGE, 'utf8')
writeFileSync(join(TEMP, 'main.cjs'), MAIN, 'utf8')
const run = spawnSync(ELECTRON, [join(TEMP, 'main.cjs')], {
  stdio: ['ignore', 'pipe', 'pipe'],
  timeout: 90000,
})
rmSync(TEMP, { recursive: true, force: true })
const line = String(run.stdout ?? '')
  .split('\n')
  .find(l => l.includes('MAP_JSON:'))
if (!line) {
  console.error('[probe] 无结果，stderr:', String(run.stderr ?? '').slice(0, 600))
  process.exit(1)
}
const payload = JSON.parse(line.slice(line.indexOf('MAP_JSON:') + 'MAP_JSON:'.length))
for (const [name, dump] of Object.entries(payload)) {
  console.log(`\n=== ${name} ===  paths=${dump.pathCount ?? '?'} labels=${dump.labelCount ?? '?'}`)
  if (dump.error || dump.fatal) {
    console.log(dump.error ?? dump.fatal)
    continue
  }
  console.log('--- 诊断 ---', JSON.stringify(dump.diag))
  console.log('--- pathMid ---', JSON.stringify(dump.pathMid))
  console.log('--- labelCenter ---', JSON.stringify(dump.labelCenter))
  console.log('--- 距离矩阵（行=path，列=label）---')
  for (const row of dump.matrix) console.log('  ' + row.path.padEnd(40) + JSON.stringify(row.dists))
  console.log('--- 几何配对结果（按 path 序）---')
  for (const m of dump.matched) {
    const p = dump.paths[m.pathIdx]
    console.log(`  path[${m.pathIdx}] ${p.id}`)
    console.log(`      → label[${m.labelIdx}] "${m.label ?? ''}"  距离 ${m.dist}px`)
  }
}
