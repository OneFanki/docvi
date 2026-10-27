/**
 * 图片块的模型：Markdown 图片语法 ↔ 可编辑字段。
 *
 * 与表格模型同一个思路——产物必须是标准 Markdown 原文，不引入私有语法。
 * 图片是「单行 `![alt](src "title")`」，可编辑的东西只有三样：描述、路径、
 * 标题（可选），正好是弹窗里的三个输入框。
 *
 * 为什么不支持 `<img>` 标签：项目里所有图片都走 Markdown 语法，多认一种写法
 * 只会让「点了编辑却打不开」的概率变高（HTML 形态带任意属性，映射不回来）。
 */

export interface ImageModel {
  /** 描述文字（alt） */
  alt: string
  /** 路径：相对路径、绝对 URL、docvi 资源路径都允许，原样写回 */
  src: string
  /** 可选标题（鼠标悬停显示）；空串表示不写 */
  title: string
}

/** `![alt](src "title")`：alt 里允许转义 `\]`，src 允许尖括号包裹含空格的路径 */
const IMAGE_RE =
  /^!\[((?:\\.|[^\]\\])*)\]\(\s*(<[^>]*>|[^\s)]*)(?:\s+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\)))?\s*\)$/

/**
 * 解析图片块源码。
 *
 * 返回 null 表示「这不是一条能识别的图片语法」——调用方要明确告诉用户不能可视化
 * 编辑，而不是打开一个字段全空的弹窗让用户以为原图信息丢了。
 */
export function parseImage(source: string): ImageModel | null {
  const text = source.trim()
  const match = IMAGE_RE.exec(text)
  if (!match) return null
  const rawSrc = (match[2] ?? '').trim()
  const src = rawSrc.startsWith('<') && rawSrc.endsWith('>') ? rawSrc.slice(1, -1) : rawSrc
  return {
    alt: (match[1] ?? '').replace(/\\([\\[\]])/g, '$1'),
    src,
    title: match[3] ?? match[4] ?? match[5] ?? '',
  }
}

/** 路径里出现空格或括号时必须用尖括号包住，否则语法在空格处断掉 */
function escapeSrc(src: string): string {
  return /[\s()<>]/.test(src) ? `<${src.replace(/[<>]/g, '')}>` : src
}

function escapeAlt(alt: string): string {
  return alt.replace(/\\/g, '\\\\').replace(/[[\]]/g, '\\$&')
}

/** 序列化回标准 Markdown 图片语法；src 为空时返回空串（调用方据此拒绝保存） */
export function serializeImage(model: ImageModel): string {
  const src = model.src.trim()
  if (!src) return ''
  const title = model.title.trim() ? ` "${model.title.replace(/"/g, '\\"')}"` : ''
  return `![${escapeAlt(model.alt.trim())}](${escapeSrc(src)}${title})`
}
