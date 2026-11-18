/**
 * 分享页的浏览器端运行时。
 *
 * 分享页是服务进程直出的静态 HTML：没有 Vue、没有渲染进程，所以正文里的
 * 代码块与 mermaid 占位块必须由页面自己补完。这里只复用渲染核心的现成实现
 * ——主题映射与 hover 联动都在 renderer-core 里，不抄第二份：
 *
 *  1. mermaid：懒加载独立的 `mermaid.min.js`（3.4MB，只在页面真含图表时才下）；
 *  2. 代码高亮：懒加载 `share-highlight.js`（Shiki，3.2MB / gzip 600KB，
 *     只在页面真含代码块时才下）；
 *  3. 代码块复制按钮。
 *
 * 三份脚本分开是刻意的：一份分享页最可能只有一样（甚至一样都没有）。捆在
 * 一个 bundle 里，任何一篇文档都要为另外两样付出首屏等待。
 */
import { enhanceMermaidSvg } from '@docvi/renderer-core'
import { mermaidThemeVariables } from '@docvi/renderer-core/mermaid-theme'

import { bindMermaidExpand } from './lightbox.ts'

interface MermaidApi {
  initialize(config: Record<string, unknown>): void
  render(id: string, code: string): Promise<{ svg: string }>
}

declare global {
  interface Window {
    mermaid?: MermaidApi
  }
}

/** 按需注入一个脚本；同一页面同一文件只会注入一次 */
const loaded = new Map<string, Promise<void>>()
function loadScript(prefix: string, name: string): Promise<void> {
  const cached = loaded.get(name)
  if (cached) return cached
  const promise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    /*
     * 必须拼成绝对地址：`new URL(相对路径, '/prefix/')` 会抛
     * `Invalid base URL`——URL 构造器的 base 参数必须是绝对 URL，而页面里
     * 记录的前缀是站内路径。踩过一次，表现是图表全部退回源码、只有一条 console。
     */
    script.src = new URL(name, `${location.origin}${prefix}`).href
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error(`${name} 加载失败`))
    document.head.appendChild(script)
  })
  loaded.set(name, promise)
  return promise
}

let seq = 0

async function renderMermaid(host: HTMLElement, prefix: string): Promise<void> {
  const blocks = Array.from(host.querySelectorAll<HTMLElement>('pre.at-mermaid-src[data-mermaid]'))
  if (!blocks.length) return

  await loadScript(prefix, 'mermaid.min.js')
  const mermaid = window.mermaid
  if (!mermaid) throw new Error('mermaid 脚本未导出全局对象')

  /*
   * 配色从**页面根元素**现读：分享页内联的就是 theme.css，所以读到的
   * `--dv-mermaid-*` 与分享者本机完全同源。mermaid 只收具体色值（它要对色值
   * 做 darken/lighten），所以必须让浏览器先解析一遍再交出去。
   */
  const style = getComputedStyle(document.documentElement)
  const vars = mermaidThemeVariables(token => style.getPropertyValue(token).trim())

  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'loose',
    fontFamily: 'var(--dv-font-sans), sans-serif',
    theme: 'base',
    themeVariables: vars,
  })

  for (const pre of blocks) {
    const code = pre.textContent ?? ''
    try {
      const { svg } = await mermaid.render(`share-mermaid-${(seq += 1)}`, code)
      const holder = document.createElement('div')
      holder.className = 'at-mermaid'
      holder.innerHTML = svg
      pre.replaceWith(holder)
      const el = holder.querySelector('svg')
      // 解析不了结构的图类型返回 noop，保持 mermaid 原样（与阅读态同口径）
      if (el) enhanceMermaidSvg(el)
    } catch (error) {
      console.warn('[share] mermaid 渲染失败（保留原文）:', error)
    }
  }
  // 图渲染完才有可放大的对象：全屏按钮在整批图都挂好之后统一注入
  bindMermaidExpand(host)
}

/** 代码块复制：DOM 约定与阅读态一致（`.at-copy` 按钮 + `[class*="language-"]` 容器） */
function bindCopy(host: HTMLElement): void {
  host.addEventListener('click', event => {
    const target = event.target as HTMLElement | null
    const button = target?.closest<HTMLElement>('.at-copy')
    if (!button) return
    const wrapper = button.closest<HTMLElement>('[class*="language-"]')
    const code = wrapper?.querySelector('pre code')?.textContent ?? ''
    void navigator.clipboard.writeText(code).then(() => {
      button.dataset.copied = '1'
      window.setTimeout(() => delete button.dataset.copied, 1400)
    })
  })
}

function boot(): void {
  const article = document.querySelector<HTMLElement>('.share-article')
  if (!article) return
  /*
   * 运行时脚本的前缀由服务写在 `<html data-assets>`：分享服务可能挂在子路径下，
   * 相对地址在 `/s/<id>/doc` 这类深链上会解析错。
   */
  const prefix = document.documentElement.dataset.assets ?? '/share-assets/'
  bindCopy(article)

  /*
   * 两项增强互不阻塞：一项失败只影响自己那一块，另一项照常继续。
   * 判据按 DOM 决定要不要下载对应脚本——没有代码块就不下 Shiki。
   */
  if (article.querySelector('div[class*="language-"] pre > code')) {
    void loadScript(prefix, 'share-highlight.js').catch(error => {
      console.warn('[share] 代码高亮不可用', error)
    })
  }
  if (article.querySelector('pre.at-mermaid-src[data-mermaid]')) {
    void renderMermaid(article, prefix).catch(error => {
      console.warn('[share] 图表渲染失败', error)
    })
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true })
} else {
  boot()
}
