/**
 * Mermaid 渲染 pass：无图页面零加载（动态 import 只在有占位块时触发）。
 * 占位 pre.at-mermaid-src → SVG；配色来自 theme.css 的 `--dv-mermaid-*`
 * 派生变量（跟随文档主题，插件主题包可覆盖），hover 联动见 mermaid-hover.ts。
 */
import { mermaidThemeVariables } from './mermaid-theme.ts'
import { enhanceMermaidSvg } from './mermaid-hover.ts'

interface MermaidApi {
  initialize(config: Record<string, unknown>): void
  render(id: string, code: string): Promise<{ svg: string }>
}

let modulePromise: Promise<MermaidApi> | null = null
/** 已应用的主题签名：主题 id + 外观 + 解析出的变量快照（变了就重新 initialize） */
let initializedKey = ''
let renderSeq = 0

async function loadMermaid(): Promise<MermaidApi> {
  modulePromise ??= import('mermaid').then(mod => mod.default as MermaidApi)
  return modulePromise
}

/**
 * 当前文档外观（亮/暗）：读宿主写好的 `data-appearance`（按主题声明解析的
 * 结果），不能拿主题 id 猜——`mist` 等亮色主题会被「不在已知暗色表里」误判。
 */
export function resolveAppearance(doc: Document = document): 'light' | 'dark' {
  return doc.documentElement.dataset.appearance === 'light' ? 'light' : 'dark'
}

export interface MermaidPassOptions {
  /**
   * 在图容器右上角渲染「全屏查看」按钮。点击经 `docvi-mermaid-expand`
   * 事件（bubbles）上报 SVG 快照，由宿主决定怎么放大——渲染层不知道灯箱。
   * 只有阅读视图开这个选项：编辑预览等宿主没有灯箱，不给点了没反应的按钮。
   */
  expandable?: boolean
}

/** lucide 的 maximize2 图标路径（renderer-core 不引图标库，手写同款） */
const EXPAND_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>'

/**
 * mermaid 的图类型 → 中文名。
 *
 * `aria-roledescription` 是 mermaid 自己写的内部标识（`flowchart-v2`、
 * `sequence`…），直接当灯箱标题会露出实现名。没收录的类型回落到「图表」，
 * 不去猜——猜错比笼统更糟。
 */
const DIAGRAM_TITLES: Record<string, string> = {
  'flowchart-v2': '流程图',
  flowchart: '流程图',
  sequence: '时序图',
  class: '类图',
  classDiagram: '类图',
  state: '状态图',
  er: '实体关系图',
  gantt: '甘特图',
  pie: '饼图',
  journey: '旅程图',
  gitGraph: 'Git 图',
  mindmap: '思维导图',
  timeline: '时间线',
  quadrantChart: '象限图',
  requirement: '需求图',
  C4Context: 'C4 图',
  sankey: '桑基图',
  xyChart: 'XY 图',
  block: '块图',
  packet: '包图',
  architecture: '架构图',
  radar: '雷达图',
}

/** 图类型标识 → 可读标题 */
export function diagramTitle(label: string | null | undefined): string {
  if (!label) return '图表'
  return DIAGRAM_TITLES[label] ?? '图表'
}

export async function mermaidPass(
  root: HTMLElement,
  options: MermaidPassOptions = {},
): Promise<void> {
  const blocks = Array.from(root.querySelectorAll<HTMLElement>('pre.at-mermaid-src[data-mermaid]'))
  if (!blocks.length) return

  const doc = root.ownerDocument ?? document
  /*
   * 取色必须以**传入的 root** 为准，不能读 `doc.querySelector('.doc-surface')`。
   *
   * 阅读态下两者恰好等价，所以旧写法看不出问题；但导出是「另起一个离屏容器
   * 再画一遍」，此时文档里第一个 `.doc-surface` 仍是屏幕上那份。取错了会把
   * 屏幕配色烘焙进产物——SVG 里的色值一旦写入就改不回来了。
   *
   * 主题签名同样走 root 向上的最近声明者：导出会临时把 documentElement 切成
   * 目标主题再渲染（见 lib/export-doc.ts），所以这里正好能拿到那份值。用
   * 「最近声明者」而不是直接读 documentElement，是为了让将来出现局部主题作用域
   * 时不必再改这里。
   */
  const themed = root.closest<HTMLElement>('[data-theme]') ?? doc.documentElement
  const sample = root.classList.contains('doc-surface')
    ? root
    : (root.querySelector<HTMLElement>('.doc-surface') ?? root)
  const style = getComputedStyle(sample)
  const vars = mermaidThemeVariables(token => style.getPropertyValue(token).trim())
  const themeKey = [
    themed.dataset.theme ?? '',
    themed.dataset.appearance ?? doc.documentElement.dataset.appearance ?? '',
    JSON.stringify(vars),
  ].join('|')

  const mermaid = await loadMermaid()
  // mermaid 11 允许重复 initialize 覆盖配置。旧实现的模块级 promise 缓存让
  // initialize 只跑一次——换主题后新渲染的图仍用首次配色（实测踩到）。
  if (initializedKey !== themeKey) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'loose',
      fontFamily: 'var(--dv-font-sans), sans-serif',
      theme: 'base',
      themeVariables: vars,
    })
    initializedKey = themeKey
  }

  for (const pre of blocks) {
    if (pre.dataset.mermaidDone) continue
    const code = pre.textContent ?? ''
    pre.dataset.mermaidDone = '1'
    try {
      const { svg } = await mermaid.render(`docvi-mermaid-${++renderSeq}`, code)
      const holder = document.createElement('div')
      holder.className = 'at-mermaid'
      holder.innerHTML = svg
      // 先挂进文档再挂联动：hover 的标签错层要读 getBBox()，未挂载的 SVG 上它全 0
      pre.replaceWith(holder)
      const el = holder.querySelector('svg')
      // 解析不了结构的图类型返回 noop，保持 mermaid 原样
      if (el) enhanceMermaidSvg(el)
      if (options.expandable && el) {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'at-mermaid__expand'
        button.setAttribute('aria-label', '全屏查看')
        button.title = '全屏查看'
        button.innerHTML = EXPAND_ICON
        button.addEventListener('click', () => {
          holder.dispatchEvent(
            new CustomEvent('docvi-mermaid-expand', {
              bubbles: true,
              detail: {
                svg: el.outerHTML,
                // 内部标识（flowchart-v2）翻成可读名；灯光标题不该露实现词
                label: diagramTitle(el.getAttribute('aria-roledescription')),
              },
            }),
          )
        })
        holder.appendChild(button)
      }
    } catch (error) {
      console.warn('[renderer] mermaid 渲染失败（保留原文）:', error)
      pre.dataset.mermaidDone = ''
      /*
       * 必须立刻清：失败的错误图会被撑进 body，让整页可滚，
       * 之后任何 scrollIntoView 都会把顶栏推出视口（见下面函数的说明）。
       */
      cleanupMermaidFailureArtifacts(doc)
    }
  }
}

/**
 * 清掉 mermaid 渲染失败时留在 `<body>` 末尾的残留元素。
 *
 * ## 为什么必须主动清
 *
 * mermaid 11 的 `render()` 在解析失败时会**把错误图插到 document.body 末尾**
 * （元素 id 是 `<renderId>` 前面多个 `d`，例如 `ddocvi-mermaid-1`），用来在
 * 页面上显示语法错误。它不会自己删。
 *
 * 后果不是「多一个看不见的元素」那么轻：那个错误图有几百像素高，插在 body
 * 末尾会把 `<body>` 撑得超过视口 → **整个页面变成可滚动**。此时任何一次
 * `scrollIntoView`（右侧目录跳转、搜索命中定位）都会连带滚动 `<html>`/`<body>`，
 * 把固定在顶部的标题栏与标签栏推出视口——界面看起来直接坏了。
 *
 * 判据用 id 前缀而不是查询所有 div：只删我们自己发起的那些渲染留下的，
 * 绝不碰页面上其它元素。
 *
 * 为什么不做成「失败就删当前 id」而扫全部：并发渲染时（长文档一次几十张图）
 * 失败的那几个 id 未必是调用方手上那个，扫一遍最省心，数量也只有个位数。
 */
export function cleanupMermaidFailureArtifacts(doc: Document = document): void {
  for (const el of Array.from(
    doc.querySelectorAll<HTMLElement>('[id^="d"][id*="docvi-mermaid-"]'),
  )) {
    // 再确认一次形状：以 d 开头、正文是我们自己的前缀，避免误删用户内容里
    // 恰好叫这个名字的元素（几乎不可能，但删错的代价是用户内容丢失）
    if (el.id.startsWith('ddocvi-mermaid-')) el.remove()
  }
}
