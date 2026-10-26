/**
 * Mermaid 渲染 pass：无图页面零加载（动态 import 只在有占位块时触发）。
 * 占位 pre.at-mermaid-src → SVG；主题跟随文档主题明暗。
 */
let mermaidPromise: Promise<MermaidApi> | null = null

interface MermaidApi {
  initialize(config: Record<string, unknown>): void
  render(id: string, code: string): Promise<{ svg: string }>
}

export function loadMermaid(dark: boolean): Promise<MermaidApi> {
  mermaidPromise ??= import('mermaid').then(mod => {
    const mermaid = mod.default as MermaidApi
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'loose',
      fontFamily: 'var(--dv-font-sans), sans-serif',
      theme: dark ? 'dark' : 'default',
    })
    return mermaid
  })
  return mermaidPromise
}

let renderSeq = 0

/** 渲染容器内全部 mermaid 占位块；无占位块直接返回 */
export async function mermaidPass(root: HTMLElement, dark: boolean): Promise<void> {
  const blocks = Array.from(root.querySelectorAll<HTMLElement>('pre.at-mermaid-src[data-mermaid]'))
  if (!blocks.length) return
  const mermaid = await loadMermaid(dark)
  for (const pre of blocks) {
    if (pre.dataset.mermaidDone) continue
    const code = pre.textContent ?? ''
    pre.dataset.mermaidDone = '1'
    try {
      const { svg } = await mermaid.render(`docvi-mermaid-${++renderSeq}`, code)
      const holder = document.createElement('div')
      holder.className = 'at-mermaid'
      holder.innerHTML = svg
      pre.replaceWith(holder)
    } catch (error) {
      console.warn('[renderer] mermaid 渲染失败（保留原文）:', error)
      pre.dataset.mermaidDone = ''
    }
  }
}
