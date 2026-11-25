/**
 * 斜杠插入的纯逻辑：不算坐标、不碰 Vue，只把「插入意图」翻译成文本变更。
 *
 * 单独拆出来是为了能被 node 测试直接 import（不牵 Vue 运行时）。
 */

export interface InsertItem {
  id: string
  label: string
  /**
   * 悬停时的补充说明（可选）。
   *
   * 标准 Markdown 项一律不写：图标与名称已经说清它是什么，再加一句
   * 「标准 Markdown · 任何编辑器都能打开」是面板内的注释噪音。
   * 只有增强组件需要一句话解释它长什么样。
   */
  hint?: string
  group: 'markdown'
  /** 搜索用的额外关键词 */
  keywords: string
  /**
   * 插入后是否有可视化表单编辑（表格网格编辑器这类）。
   *
   * 有表单的项在菜单里会标出来：用户选之前就该知道「这个插进去能点开改」，
   * 而不是插完再自己发现。声明式富组件目前全是手写 YAML，一律没有。
   */
  form?: boolean
  /**
   * 前面必须空一行才能成立。
   *
   * 分割线尤其如此：`---` 紧贴上一行文字时不是分割线，而是**上一行的 setext
   * 标题下划线**（CommonMark 规则），整段会被折成一级标题，分割线根本不出现。
   * 用户在正文末行直接打 `/hr` 是最自然的操作，所以由插入规划自动补空行。
   */
  needsBlankBefore?: boolean
  /** 生成插入文本；`cursorOffset` 是插入后光标相对插入块的偏移 */
  render: (ctx: InsertContext) => { text: string; cursorOffset?: number }
}

/** 插入上下文：目前没有需要跨项共享的状态，保留空对象以免后续扩展改签名 */
export type InsertContext = Record<string, never>

export interface InsertChange {
  from: number
  to: number
  insert: string
}

export interface InsertPlan {
  /** 同一次事务里应用的变更，位置都相对**原始文档** */
  changes: InsertChange[]
  /** 插入后光标落点（相对原始文档坐标，调用方需按前面变更增长量自行换算） */
  caretAfter: number
}

/**
 * 插入点前面是否需要补一个空行。
 *
 * 判据是「插入点所在行之前紧邻的那一行有内容」。斜杠命令只在一整行只有
 * `/词` 时触发，所以插入点就是行首——上一行有字就意味着块会与它粘连。
 */
function needsBlankLine(doc: string, from: number): boolean {
  const eol = doc.includes('\r\n') ? '\r\n' : '\n'
  const before = doc.slice(0, from)
  if (!before) return false
  // 已经以空行结尾（或文档开头）就不必再补
  if (before.endsWith(`${eol}${eol}`) || before === eol) return false
  const previous = before.slice(0, before.length - eol.length)
  const lineStart = Math.max(previous.lastIndexOf('\n'), previous.lastIndexOf('\r'))
  return previous.slice(lineStart + 1).trim() !== ''
}

/**
 * 把一次斜杠插入翻译成文本变更。
 */
export function planInsert(doc: string, item: InsertItem, from: number, to: number): InsertPlan {
  const rendered = item.render({})
  const eol = doc.includes('\r\n') ? '\r\n' : '\n'
  // 需要独立成块的项（分割线）：紧贴上一行会被解析成上一行的下划线，补一个空行
  const prefix = item.needsBlankBefore && needsBlankLine(doc, from) ? eol : ''
  const insert = prefix + rendered.text
  const offset = rendered.cursorOffset ?? rendered.text.length
  return {
    changes: [{ from, to, insert }],
    caretAfter: from + prefix.length + offset,
  }
}

/**
 * 插入完成后，正文块在**新文档**里的区间（不含结尾换行）。
 *
 * 用途：插入表格后立刻打开网格编辑器，用户填完要把模型写回这一段原文。
 * 容易算错的地方都在这里收口：
 *  1. 插入文本以换行结尾（否则会和后一段粘住），但回写时 `serializeTable`
 *     产出的原文**不带**结尾换行——区间若含那个换行，回写就会把表格与下一段
 *     粘成一行。与「编辑表格」按钮那条路径对齐：区间端点落在最后一行的行尾。
 */
export function insertedBlockRange(
  plan: InsertPlan,
): { from: number; to: number; text: string } | null {
  const body = plan.changes[plan.changes.length - 1]
  if (!body || body.insert.length === 0) return null
  /*
   * 首行的空行前缀（分割线这类需要独立成块的项会带）不属于块内容：
   * 它只是为了让块与上一段分开，算进区间会把区间起点落到上一行的行尾。
   */
  const leading = /^(?:\r?\n)+/.exec(body.insert)?.[0]?.length ?? 0
  const from = body.from + leading
  const text = body.insert.slice(leading).replace(/(?:\r?\n)+$/, '')
  return { from, to: from + text.length, text }
}
