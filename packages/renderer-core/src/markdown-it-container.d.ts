/**
 * markdown-it-container@4 没有随包发布类型，社区 @types 也只覆盖到 3.x。
 * 这里按 4.x 实际 API 声明最小可用面：`md.use(container, name, options)`。
 */
declare module 'markdown-it-container' {
  import type MarkdownIt from 'markdown-it'
  import type Token from 'markdown-it/lib/token.mjs'

  export interface ContainerOptions {
    /** 判定该 fence 是否归本容器（默认按 info 首词匹配容器名） */
    validate?: (params: string) => boolean
    /** 自定义渲染；不传则输出 `<div class="name">` 包裹 */
    render?: (
      tokens: Token[],
      idx: number,
      options: unknown,
      env: unknown,
      self: MarkdownIt,
    ) => string
    /** 标记字符，默认 ':' */
    marker?: string
  }

  const container: (md: MarkdownIt, name: string, options?: ContainerOptions) => void
  export default container
}
