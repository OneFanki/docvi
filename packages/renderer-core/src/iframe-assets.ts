/**
 * 正文里原生 `<iframe>` 的 `src` 归一。
 *
 * 为什么需要它：图片走 markdown-it 的 `image` 规则、能被补上宿主的资产前缀；
 * 而**原生 HTML 是原样透传的**，`<iframe src="./demo.html">` 里的相对路径会
 * 相对应用入口解析成 `docvi://app/demo.html`——那是渲染产物目录，必然 404。
 * 于是「在 md 里嵌一个本地 html 图解」这件事，不改这里就永远只能靠定制组件。
 *
 * 归一之后，`<iframe src="./demo.html" sandbox="allow-scripts">` 就是标准
 * Markdown + 标准 HTML，任何编辑器都能读，只有路径按宿主规则解析。
 *
 * ⚠️ 只改 `src`，不碰 `sandbox` / `allow` / `width` 等属性：沙箱边界由作者
 * 显式声明，替作者放宽安全属性是这个函数最不该做的事。没写 `sandbox` 的
 * iframe 保持没有——它本来就该被当作「作者自己承担风险」。
 */

/** 是否是需要归一的内联相对路径（外链、协议相对、data:、绝对路径都不动） */
function isRelativeAssetPath(src: string): boolean {
  if (!src) return false
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(src)) return false
  return true
}

/**
 * 把相对路径按文档所在目录转成根相对路径。
 *
 * 与图片共用同一套语义：`./a/b.html` 与 `a/b.html` 等价，`../x.html` 允许
 * 上溯（内容根内的正常相对引用）。上溯到根之外的部分会被裁掉——渲染层没有
 * 能力判断内容根边界，交给宿主的资产协议在服务端做 containment（那里有
 * 真实的工作区根，见主进程 handleAssetRequest）。
 */
export function toRootRelative(src: string, baseDir: string): string {
  const clean = src.replace(/^\.\//, '')
  const base = baseDir ? baseDir.split('/').filter(Boolean) : []
  const parts = clean.split('/')
  const stack = [...base]
  for (const part of parts) {
    if (part === '.' || part === '') continue
    if (part === '..') {
      if (stack.length) stack.pop()
      continue
    }
    stack.push(part)
  }
  return `/${stack.join('/')}`
}

/**
 * 重写一段 HTML 片段里所有 `<iframe>` 的 `src`。
 *
 * 只处理带双引号或单引号的写法（HTML 规范允许无引号，但无引号属性值里
 * 出现空格的场景极少，且 md 作者手写时几乎总带引号；不为此增加误判风险）。
 */
export function rewriteIframeSrc(html: string, docPath: string, assetPrefix: string): string {
  if (!assetPrefix) return html
  const baseDir = docPath.includes('/') ? docPath.slice(0, docPath.lastIndexOf('/')) : ''
  return html.replace(
    /<iframe\b([^>]*?)\bsrc\s*=\s*(["'])([^"']*)\2([^>]*)>/gi,
    (whole, before: string, quote: string, src: string, after: string) => {
      if (!isRelativeAssetPath(src)) return whole
      const next = assetPrefix + toRootRelative(src, baseDir)
      return `<iframe${before}src=${quote}${next}${quote}${after}>`
    },
  )
}

/**
 * 需要在 iframe 上补的 CSP 说明（供文档与排错引用，不参与运行时）。
 *
 * 关键结论：`frame-src` 未单独声明时回退到 `default-src`，而应用的
 * `default-src` 已包含 `docvi:`——所以 **iframe 加载本地 html 不需要放宽 CSP**。
 * 真正会拦的是内联 `<script>`（`script-src 'self'`），那由作者用
 * `sandbox="allow-scripts"` 的 iframe 承载，脚本在子文档里跑，不污染应用。
 */
