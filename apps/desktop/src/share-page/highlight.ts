/**
 * 分享页的代码高亮（按需加载）。
 *
 * 为什么单独成文件：Shiki 带引擎与三十个语言模块，打包后 3.2MB（gzip 约
 * 600KB）。分享页里没有代码块是常态（散文、清单、会议记录），让这些页面下载
 * 一整套语法高亮没有道理。`runtime.ts` 只在检测到代码块时才注入这个文件。
 *
 * 高亮实现直接用渲染核心的 `highlightPass`——与桌面阅读态同一份，产物里的
 * token 与配色完全一致，不在这里另写一遍。
 */
import { highlightPass } from '@docvi/renderer-core'

function run(): void {
  const article = document.querySelector<HTMLElement>('.share-article')
  if (!article) return
  void highlightPass(article).catch(error => {
    console.warn('[share] 代码高亮失败', error)
  })
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', run, { once: true })
} else {
  run()
}
