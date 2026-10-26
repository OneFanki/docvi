// ?raw 把样式当字符串打进包：导出文件必须自包含，不能引外部 CSS 文件
import themeCss from '../../../../../../packages/renderer-core/src/styles/theme.css?raw'
import docCss from '../../../../../../packages/renderer-core/src/styles/doc.css?raw'

import {
  ComponentRegistry,
  highlightPass,
  mermaidPass,
  mountDeclarativeComponents,
  mountPluginBlocks,
  renderMarkdown,
  type DeclarativeMount,
} from '@docvi/renderer-core'

import type { ExportFormat } from '@docvi/shared'

/**
 * 导出产物的生成（Markdown / HTML / PDF）。
 *
 * 核心决策：**导出时重新渲染一份，而不是克隆当前屏幕上的 DOM**。
 *
 * 克隆看似省事，但导出可以在三种模式下发起（阅读 / 实时预览 / 源码），
 * 后两种根本没有渲染好的正文；而且屏幕上那份夹着查找高亮、光标行展开的源码、
 * 未加载完的懒图。重新渲染一份的好处是产物与「当前处于哪个模式、滚到哪里」
 * 完全解耦，代价只是多等一次异步高亮。
 *
 * 渲染容器必须真实参与布局（离屏但给定宽度）：mermaid 与画布类组件要按容器
 * 宽度算尺寸，`display:none` 或宽度 0 会让它们画成一坨。
 */

export interface ExportRenderOptions {
  /** 原始 Markdown（读的是当前缓冲区，不是磁盘版本） */
  text: string
  /** 文档路径：图片等相对资源按它解析 */
  docPath: string
  /** 组件注册表（与阅读视图同一份构造规则） */
  registry: ComponentRegistry
  /** 插件声明的结构化块语法（容器或围栏） */
  containerSyntax: Array<{ name: string; component: string; form?: 'container' | 'fence' }>
  /** 文档主题 id */
  docTheme: string
}

/** 离屏渲染一页正文，返回承载它的容器（调用方负责移除） */
async function renderOffscreen(options: ExportRenderOptions): Promise<{
  host: HTMLElement
  surface: HTMLElement
  dispose: () => void
}> {
  const host = document.createElement('div')
  // 离屏但保持真实布局：宽度给一个接近阅读列的定值，图组件才按合理尺寸排布
  host.style.cssText =
    'position:fixed;left:-100000px;top:0;width:820px;pointer-events:none;opacity:0;'
  const surface = document.createElement('article')
  surface.className = 'doc-surface at-doc'
  host.appendChild(surface)
  document.body.appendChild(host)

  const result = renderMarkdown(options.text, options.docPath, {
    containerSyntax: options.containerSyntax,
  })
  surface.innerHTML = result.html

  const mounts: DeclarativeMount[] = [
    mountDeclarativeComponents(
      surface,
      (result.frontmatter.components as Record<string, Record<string, unknown>> | undefined) ??
        null,
      options.registry,
      { onMissing: () => undefined },
    ),
    mountPluginBlocks(surface, options.registry, { onMissing: () => undefined }),
  ]

  // 两趟异步渲染都要等：不等的话导出文件里代码块是裸文本、图表是空 div
  try {
    await highlightPass(surface)
    await mermaidPass(surface, options.docTheme !== 'paper')
  } catch {
    // 渲染失败不阻断导出：宁可少一块高亮，也不要导不出来
  }

  return {
    host,
    surface,
    dispose: () => {
      for (const mount of mounts) mount.dispose()
      host.remove()
    },
  }
}

/** 清理只对屏幕有意义的东西（锚点按钮、复制按钮、查找高亮残留） */
function cleanClone(source: HTMLElement): HTMLElement {
  const clone = source.cloneNode(true) as HTMLElement
  for (const el of clone.querySelectorAll(
    '.header-anchor, .at-copy, .at-color-chip, mark[data-find-hit]',
  )) {
    el.remove()
  }
  return clone
}

/**
 * 把 `<img>` 转成 data URL，让导出的文件真正自包含。
 *
 * 只有已解码成功的图能转（canvas 读像素要求已加载）。失败的保持原样——
 * 宁可留一个可能裂的地址，也不要静默删掉用户的图。
 */
async function inlineImages(root: HTMLElement): Promise<void> {
  await Promise.all(
    Array.from(root.querySelectorAll('img')).map(
      image =>
        new Promise<void>(resolve => {
          const src = image.getAttribute('src') ?? ''
          if (!src || src.startsWith('data:')) {
            resolve()
            return
          }
          const draw = (): void => {
            try {
              if (!image.naturalWidth || !image.naturalHeight) {
                resolve()
                return
              }
              const canvas = document.createElement('canvas')
              canvas.width = image.naturalWidth
              canvas.height = image.naturalHeight
              const context = canvas.getContext('2d')
              if (!context) {
                resolve()
                return
              }
              context.drawImage(image, 0, 0)
              image.setAttribute('src', canvas.toDataURL('image/png'))
            } catch {
              // 跨源 / 未解码：保留原地址
            }
            resolve()
          }
          if (image.complete) {
            draw()
            return
          }
          image.addEventListener('load', draw, { once: true })
          image.addEventListener('error', () => resolve(), { once: true })
          // 兜底：坏图不一定触发 error，某些场景会一直挂着
          window.setTimeout(resolve, 1500)
        }),
    ),
  )
}

/** 收集插件注入的主题样式（内置组件样式已在打包 CSS 里） */
function pluginStyleText(): string {
  return Array.from(document.querySelectorAll('style[data-plugin-theme]'))
    .map(style => style.textContent ?? '')
    .join('\n\n')
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * 打印与离线阅读专用补丁。
 *
 * 三条都是导出独有的需求，不属于屏幕样式：
 *  - 正文列定宽：屏幕上有「铺满 / 收窄」开关，导出文件没有开关，必须定死；
 *  - 卡片/表格/代码块禁止跨页断开（PDF 里断成两半最难读）；
 *  - 标题后面不跟分页，避免标题孤零零落在页尾。
 */
const EXPORT_CSS = `
html, body { margin: 0; padding: 0; background: var(--dv-doc-bg); }
body { color: var(--dv-doc-text); font-family: var(--dv-font-sans); }
.docvi-export {
  max-width: 820px;
  margin: 0 auto;
  padding: 48px 32px 64px;
}
@media print {
  .docvi-export { max-width: none; padding: 0; }
  h1, h2, h3, h4, h5, h6 { break-after: avoid; }
  pre, table, figure, blockquote { break-inside: avoid; }
  img { max-width: 100%; }
}
`

export interface ExportHtmlOptions extends ExportRenderOptions {
  title: string
  locale: string
}

/** 生成完整、自包含的 HTML 文档 */
export async function buildExportHtml(options: ExportHtmlOptions): Promise<string> {
  const { surface, dispose } = await renderOffscreen(options)
  try {
    const body = cleanClone(surface)
    await inlineImages(body)
    const styles = [themeCss, docCss, pluginStyleText(), EXPORT_CSS].filter(Boolean).join('\n\n')
    return `<!doctype html>
<!-- 主题挂在 html 上：整份导出的底色、正文、代码配色都来自这一套变量 -->
<html lang="${escapeHtml(options.locale)}" data-theme="${escapeHtml(options.docTheme)}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(options.title)}</title>
<style>
${styles}
</style>
</head>
<body>
<article class="docvi-export doc-surface at-doc">
${body.innerHTML}
</article>
</body>
</html>
`
  } finally {
    dispose()
  }
}

/**
 * 数出文档里「只有 docvi 能渲染」的组件数。
 *
 * 三种声明形式都要数：frontmatter 的 `components:` 段、正文 `<at-*>` 引用、
 * `:::` 容器块。少数一种，用户导出后就会遇到没有预警的「打开是源码」。
 */
export function countRichComponents(text: string): number {
  const lines = text.split(/\r?\n/)
  let declared = 0
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
    if (end > 0) {
      let inside = false
      for (const line of lines.slice(1, end)) {
        if (/^components:\s*$/.test(line)) {
          inside = true
          continue
        }
        if (!inside) continue
        if (/^ {2}[\w-]+:/.test(line)) declared += 1
        else if (line.trim() && !line.startsWith(' ')) inside = false
      }
    }
  }
  const tags = (text.match(/^[ \t]*<at-[\w-]+[\s>]/gm) ?? []).length
  const containers = (text.match(/^:::\s*[\w-]+\s*$/gm) ?? []).length
  return Math.max(declared, tags + containers)
}

/** 建议文件名：标题里 Windows 不允许的字符换成下划线 */
export function suggestedName(title: string): string {
  return title.replace(/[\\/:*?"<>|]/g, '_').trim() || 'docvi'
}

/** 导出成功后的一句话（markdown 且含富组件时追加提醒） */
export function exportNotice(
  format: ExportFormat,
  path: string,
  richComponents: number,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  const base = t(`export.done.${format}`, { path })
  if (format !== 'markdown' || richComponents <= 0) return base
  return `${base}${t('export.richWarning', { count: richComponents })}`
}
