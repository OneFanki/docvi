/**
 * mermaid 主题映射：`--dv-mermaid-*` 派生变量 → mermaid 的 themeVariables。
 *
 * mermaid 的 base 主题内部要对色值做 darken/lighten 运算，themeVariables
 * 只能收**具体色值**——`var(--dv-…)` 会被它的颜色工具解析失败（fontFamily
 * 是例外，它原样落进 SVG 的 style 属性，由浏览器解析）。所以渲染时先用
 * getComputedStyle 把 theme.css 里的派生变量解成具体色值，再按本表写入
 * initialize。这张表就是 theme.css 变量组与 mermaid 变量名之间的契约：
 * 主题包想改 mermaid 外观，覆盖 `--dv-mermaid-*` 即可，不动这里。
 */

export type MermaidColorGetter = (token: string) => string

/** theme.css 里定义的全部 mermaid 派生变量（顺序无关） */
export const MERMAID_TOKENS = [
  '--dv-mermaid-bg',
  '--dv-mermaid-node-bg',
  '--dv-mermaid-node-border',
  '--dv-mermaid-text',
  '--dv-mermaid-text-2',
  '--dv-mermaid-line',
  '--dv-mermaid-accent',
  '--dv-mermaid-note-bg',
  '--dv-mermaid-cluster-bg',
  '--dv-mermaid-cat-1',
  '--dv-mermaid-cat-2',
  '--dv-mermaid-cat-3',
  '--dv-mermaid-cat-4',
  '--dv-mermaid-cat-5',
  '--dv-mermaid-cat-6',
] as const

export function mermaidThemeVariables(color: MermaidColorGetter): Record<string, string> {
  const vars: Record<string, string> = {}
  const bind = (token: string, keys: string[]): void => {
    const value = color(token)
    if (!value) return
    for (const key of keys) vars[key] = value
  }

  bind('--dv-mermaid-bg', ['background', 'edgeLabelBackground'])
  bind('--dv-mermaid-node-bg', [
    'mainBkg',
    'primaryColor',
    'secondaryColor',
    'tertiaryColor',
    'actorBkg',
  ])
  bind('--dv-mermaid-node-border', [
    'primaryBorderColor',
    'secondaryBorderColor',
    'tertiaryBorderColor',
    'actorBorder',
    'nodeBorder',
    'clusterBorder',
  ])
  bind('--dv-mermaid-text', [
    'textColor',
    'primaryTextColor',
    'secondaryTextColor',
    'tertiaryTextColor',
    'actorTextColor',
    'noteTextColor',
    'labelTextColor',
  ])
  bind('--dv-mermaid-text-2', ['labelBoxBorderColor', 'signalTextColor'])
  bind('--dv-mermaid-line', [
    'lineColor',
    'transitionColor',
    'transitionLineColor',
    'actorLineColor',
  ])
  bind('--dv-mermaid-accent', ['activationBkgColor', 'sequenceNumberColor'])
  bind('--dv-mermaid-note-bg', ['noteBkgColor', 'labelBoxBkgColor'])
  bind('--dv-mermaid-cluster-bg', ['clusterBkg', 'titleColor'])

  // 分类色：mermaid 的 cScale 有 0..11 十二档，用六个分类色轮换铺满
  const text = color('--dv-mermaid-text')
  for (let i = 0; i < 6; i += 1) {
    const value = color(`--dv-mermaid-cat-${i + 1}`)
    if (!value) continue
    for (const scale of [i, i + 6]) {
      vars[`cScale${scale}`] = value
      if (text) vars[`cScaleLabel${scale}`] = text
    }
  }
  return vars
}
