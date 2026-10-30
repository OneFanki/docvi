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

export async function mermaidPass(
  root: HTMLElement,
  options: MermaidPassOptions = {},
): Promise<void> {
  const blocks = Array.from(root.querySelectorAll<HTMLElement>('pre.at-mermaid-src[data-mermaid]'))
  if (!blocks.length) return

  const doc = root.ownerDocument ?? document
  // 派生变量定义在主题档（:root）上，从挂载容器解析即可命中当前主题
  const sample = doc.querySelector('.doc-surface') ?? doc.documentElement
  const style = getComputedStyle(sample)
  const vars = mermaidThemeVariables(token => style.getPropertyValue(token).trim())
  const themeKey = [
    doc.documentElement.dataset.theme ?? '',
    doc.documentElement.dataset.appearance ?? '',
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
                label: el.getAttribute('aria-roledescription') ?? 'mermaid',
              },
            }),
          )
        })
        holder.appendChild(button)
      }
      pre.replaceWith(holder)
    } catch (error) {
      console.warn('[renderer] mermaid 渲染失败（保留原文）:', error)
      pre.dataset.mermaidDone = ''
    }
  }
}
