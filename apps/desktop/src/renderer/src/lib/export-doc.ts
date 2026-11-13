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
  /**
   * 资产前缀（`docvi://asset/<wsId>` / `docvi://local/<id>` / 容器版的 `/<wsId>`）。
   *
   * ⚠️ 必须传，否则导出产物里的图片是 `/assets/x.png` 这种根相对地址：
   * 离屏渲染容器在 `docvi://app/...` 下，这个地址会被解析到渲染产物目录而 404，
   * 于是 `inlineImages` 拿到的是一张没解码的破图，只能原样留在产物里。
   * 症状是「导出的 HTML 里图片全是裂的」，但导出流程不报任何错。
   */
  assetPrefix: string
  /** 组件注册表（与阅读视图同一份构造规则） */
  registry: ComponentRegistry
  /** 插件声明的结构化块语法（容器或围栏） */
  containerSyntax: Array<{ name: string; component: string; form?: 'container' | 'fence' }>
  /**
   * 离屏渲染时套用的主题：HTML 用当前文档主题，PDF 固定 `paper`。
   *
   * 为什么 PDF 不走文档主题：深色底打印既费墨，也常在别人的阅读器里与深色 UI
   * 叠成一片。为什么不用「@media print 覆盖深色」而是换整套主题：主题变量有
   * 上百个（正文、代码高亮 token、mermaid 节点、表格边框、容器底色…），逐条
   * 覆盖必然漏，漏掉的表现是「浅底 + 某处深色块」这种半截外观。
   *
   * 组件与 mermaid 都从这层作用域取色，所以它必须与最终 `<html data-theme>` 一致
   * ——后者由 buildExportHtml 直接读本字段。
   */
  renderTheme: string
  /** 离屏渲染套用的明暗（`data-appearance`，插件主题继承基底要用） */
  renderAppearance: 'light' | 'dark'
  /**
   * 英数是否走等宽。离屏渲染与产物 `<html>` 都要带上，否则导出会忽略该设置。
   *
   * 属性缺失 = 开启（与设置项默认一致），所以只有关闭时才需要写进产物。
   */
  renderMonoLatin: boolean
  /**
   * 抹掉整页底色，只留内容自带的色块（PDF 传 true，HTML 不传）。
   *
   * 为什么 PDF 要透明：用户看到的是 PDF 阅读器里一整块米色纸面，而 PDF 阅读器
   * 本身已有背景。让页面无底色，纸张颜色就交给阅读器决定，深浅模式都自然。
   * 内容里的代码块、提示框、mermaid 节点仍保留各自底色——它们是语义色块。
   *
   * HTML 不走这条：独立文件没有「阅读器背景」可继承，透明等于白底，反而丢掉
   * 用户选的主题外观。
   */
  transparentPage?: boolean
}

/**
 * 离屏渲染一页正文，返回承载它的容器（调用方负责移除）。
 *
 * ══ 为什么必须临时改 documentElement 的主题 ══
 *
 * mermaid 的配色在 `render()` 时被**烘焙**进 SVG（它的 base 主题要对色值做
 * darken/lighten，只收具体色值），之后改 CSS 变量不会重画。所以「先在屏幕主题
 * 下画好、再靠外层 data-theme 换成 paper」会得到白纸配深色图的产物。
 *
 * 那能不能只给离屏容器加 `data-theme`？不行——theme.css 里所有主题档都写成
 * `:root[data-theme='…']`，只认 `<html>` 上的属性，容器上加的完全不命中。
 * （第一版就是这么写的，产物里 mermaid 节点仍是深色方块，排查花了些时间。）
 *
 * 因此只能临时切真身：记下当前值 → 换成目标 → 渲染 → 原样恢复。整个过程是
 * 同步串起来的（含 await），期间屏幕会短暂套用目标主题，所以离屏容器带
 * `opacity:0` 不影响观察；用户在这个窗口里点不到导出按钮，视觉上无感。
 */
async function renderOffscreen(options: ExportRenderOptions): Promise<{
  host: HTMLElement
  surface: HTMLElement
  dispose: () => void
}> {
  const root = document.documentElement
  const previous = {
    theme: root.dataset.theme,
    appearance: root.dataset.appearance,
    monoLatin: root.dataset.monoLatin,
  }
  root.dataset.theme = options.renderTheme
  root.dataset.appearance = options.renderAppearance
  // 缺失 = 开启，所以只在与当前选择不同时才需要动这个属性
  if (options.renderMonoLatin) delete root.dataset.monoLatin
  else root.dataset.monoLatin = 'off'

  const host = document.createElement('div')
  // 离屏但保持真实布局：宽度给一个接近阅读列的定值，图组件才按合理尺寸排布
  host.style.cssText =
    'position:fixed;left:-100000px;top:0;width:820px;pointer-events:none;opacity:0;'
  const surface = document.createElement('article')
  surface.className = 'doc-surface at-doc'
  host.appendChild(surface)
  document.body.appendChild(host)

  const restoreTheme = (): void => {
    if (previous.theme === undefined) delete root.dataset.theme
    else root.dataset.theme = previous.theme
    if (previous.appearance === undefined) delete root.dataset.appearance
    else root.dataset.appearance = previous.appearance
    if (previous.monoLatin === undefined) delete root.dataset.monoLatin
    else root.dataset.monoLatin = previous.monoLatin
  }

  const result = renderMarkdown(options.text, options.docPath, {
    containerSyntax: options.containerSyntax,
    assetPrefix: options.assetPrefix,
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
    await mermaidPass(surface)
  } catch {
    // 渲染失败不阻断导出：宁可少一块高亮，也不要导不出来
  } finally {
    // 主题用完就还回去：后续的 inlineImages / 克隆都不依赖它，不该让屏幕
    // 继续停在导出用的主题上
    restoreTheme()
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
    // .at-htmlembed__open 是「在新窗口打开图解」——导出产物里没有应用窗口可开
    '.header-anchor, .at-copy, .at-color-chip, .at-htmlembed__open, mark[data-find-hit]',
  )) {
    el.remove()
  }
  return clone
}

/**
 * 把 HtmlEmbed 的内容副本回填成 srcdoc。
 *
 * 屏幕态里 iframe 指向应用的沙箱宿主页（`embed-sandbox.html`）——那一层是为绕开
 * 应用入口页的 CSP 继承（srcdoc / blob: 会继承 `script-src 'self'`，图解的内联
 * 脚本会被整片拦掉）。导出文件是独立文档、没有那条 CSP，且沙箱页不在导出产物
 * 里，因此这里直接写回 srcdoc，让图解在内联脚本可执行的前提下照原样呈现。
 */
function materializeEmbeds(root: HTMLElement): void {
  for (const figure of Array.from(root.querySelectorAll('.at-htmlembed'))) {
    const payload = figure.querySelector('.at-htmlembed__payload')
    const frame = figure.querySelector('iframe')
    if (!payload || !frame) continue
    frame.setAttribute('srcdoc', payload.textContent ?? '')
    frame.removeAttribute('src')
    payload.remove()
  }
}

/**
 * 把 `<img>` 转成 data URL，让导出的文件真正自包含。
 *
 * **用 fetch 取原始字节，不用 canvas 重绘。** canvas 方案有三个实际损失：
 *  - 一律输出 PNG：一张 300KB 的 JPEG 转完可能上 2MB，长文档导出体积失控；
 *  - 丢掉原始格式元数据（动图变静帧、SVG 光栅化后放大就糊）；
 *  - 跨源图会让画布 tainted，`toDataURL` 抛错（此时只能保留外链）。
 *
 * fetch + Blob 拿到的是**原始字节**，MIME 从响应头或扩展名推断，产物与源文件
 * 一一对应。取不到（离线 / 404 / 跨源被拦）就保留原地址——宁可留一个可能裂的
 * 地址，也不要静默删掉用户的图。
 */
async function inlineImages(root: HTMLElement): Promise<void> {
  const tasks = Array.from(root.querySelectorAll('img')).map(async image => {
    const src = image.getAttribute('src') ?? ''
    if (!src || src.startsWith('data:')) return
    try {
      const response = await fetch(src)
      if (!response.ok) return
      const blob = await response.blob()
      if (!blob.size) return
      const mime = blob.type || mimeFromPath(src)
      if (!mime.startsWith('image/')) return
      image.setAttribute('src', await blobToDataUrl(blob, mime))
    } catch {
      // 保持原地址（离线、404、跨源被拦）
    }
  })
  // 单张图卡住不该拖垮整个导出
  await Promise.race([
    Promise.all(tasks),
    new Promise<void>(resolve => window.setTimeout(resolve, 8000)),
  ])
}

/** 响应头缺 MIME 时按扩展名补；补不出就不内联（避免产出 `data:;base64` 这种死链） */
function mimeFromPath(src: string): string {
  const path = src.split(/[?#]/)[0]?.toLowerCase() ?? ''
  const table: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    avif: 'image/avif',
    bmp: 'image/bmp',
    ico: 'image/x-icon',
    svg: 'image/svg+xml',
  }
  const ext = path.slice(path.lastIndexOf('.') + 1)
  return table[ext] ?? ''
}

function blobToDataUrl(blob: Blob, mime: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('读取图片字节失败'))
    // 用响应里的 MIME 重包一层：Blob 的 type 可能是空串或 application/octet-stream
    reader.readAsDataURL(blob.slice(0, blob.size, mime))
  })
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
 * 四条都是导出独有的需求，不属于屏幕样式：
 *  - 正文列定宽：屏幕上有「铺满 / 收窄」开关，导出文件没有开关，必须定死；
 *  - 卡片/表格/代码块禁止跨页断开（PDF 里断成两半最难读）；
 *  - 标题后面不跟分页，避免标题孤零零落在页尾；
 *  - `pageBackground` 为 `transparent` 时抹掉**整页**底色。
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

/**
 * 抹掉整页底色的补丁（PDF 专用）。
 *
 * 为什么不是「换个白色主题」：主题里有成百个变量，换主题会把代码块、提示框、
 * mermaid 节点的底色一并冲掉——那些是**内容自带的色块**，用户明确要保留。
 * 这里只动三层承载「页面本身」的元素，内容里的任何 background 都不碰。
 *
 * `.docvi-export` 必须一起覆盖：它同时带 `.doc-surface` 类，而 theme.css 里
 * `.doc-surface { background: var(--dv-doc-bg) }` 会把这层米色重新画上。
 * 两条规则特异性相同（都是单类选择器），靠本补丁排在 theme.css 之后取胜。
 *
 * 效果是页面**没有底色**，PDF 阅读器按自己的默认背景渲染——浅色阅读器看到白，
 * 深色阅读器看到深。文字颜色仍是主题的深色，所以只有浅色底才是安全组合，
 * 这也是调用方只在 PDF 用它的原因。
 */
const TRANSPARENT_PAGE_CSS = `
html, body, .docvi-export { background: transparent; }
`

export interface ExportHtmlOptions extends ExportRenderOptions {
  title: string
  locale: string
}

/** 生成完整、自包含的 HTML 文档。主题由 `renderTheme` 决定（调用方定 HTML/PDF 口径）。 */
export async function buildExportHtml(options: ExportHtmlOptions): Promise<string> {
  const { surface, dispose } = await renderOffscreen(options)
  try {
    const body = cleanClone(surface)
    materializeEmbeds(body)
    await inlineImages(body)
    const styles = [
      themeCss,
      docCss,
      pluginStyleText(),
      EXPORT_CSS,
      options.transparentPage ? TRANSPARENT_PAGE_CSS : '',
    ]
      .filter(Boolean)
      .join('\n\n')
    return `<!doctype html>
<!-- data-theme 决定整份产物的底色/正文/代码配色。它必须与离屏渲染时套的那层
     一致（renderTheme）：mermaid 等把颜色烘焙进 SVG 的块，事后改这里不会重画。
     data-mono-latin 只在关闭时写出——属性缺失即开启，与设置项默认一致 -->
<html lang="${escapeHtml(options.locale)}" data-theme="${escapeHtml(options.renderTheme)}"${
      options.renderMonoLatin ? '' : ' data-mono-latin="off"'
    }>
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
