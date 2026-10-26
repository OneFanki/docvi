/**
 * 斜杠插入的纯逻辑：不算坐标、不碰 Vue，只把「插入意图」翻译成文本变更。
 *
 * 单独拆出来有两个原因：
 *  1. 富组件插入要同时改文件头（frontmatter）和正文，两处变更的位置必须一起算，
 *     否则正文里的 `<at-*>` 引用会落进刚写好的 YAML；
 *  2. 这段逻辑要能被 node 测试直接 import（不牵 Vue 运行时）。
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
  group: 'markdown' | 'component'
  /** 搜索用的额外关键词 */
  keywords: string
  /** 生成插入文本；`cursorOffset` 是插入后光标相对插入块的偏移 */
  render: (ctx: InsertContext) => { text: string; cursorOffset?: number }
}

export interface InsertContext {
  /** 当前文档里已有的组件 key（避免重复） */
  usedKeys: string[]
}

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

/** 文档头里已经声明过的组件 key（`components:` 下的两级缩进键） */
export function collectComponentKeys(doc: string): string[] {
  const lines = doc.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return []
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (end < 0) return []
  const keys: string[] = []
  let inside = false
  for (const line of lines.slice(1, end)) {
    if (/^components:\s*$/.test(line)) {
      inside = true
      continue
    }
    if (!inside) continue
    // components 段内的两级缩进键；遇到顶格行说明这一段结束了
    const match = /^ {2}([\w-]+):/.exec(line)
    if (match?.[1]) keys.push(match[1])
    else if (line.trim() && !line.startsWith(' ')) inside = false
  }
  return keys
}

/**
 * 把组件声明合并进 frontmatter，返回插入点与文本。
 *
 * 三种情况都要覆盖：没有 frontmatter（整块新建）、有但没有 `components:`（追加键）、
 * 已有 `components:`（插到它下面保持同类集中）。
 */
export function componentInsertion(doc: string, fragment: string): { at: number; insert: string } {
  const eol = doc.includes('\r\n') ? '\r\n' : '\n'
  const body = fragment.endsWith('\n') ? fragment : `${fragment}\n`
  const normalized = body.split('\n').join(eol)

  const firstLineEnd = doc.indexOf('\n')
  const hasHeader = firstLineEnd > 0 && doc.slice(0, firstLineEnd).trim() === '---'
  if (!hasHeader) {
    return { at: 0, insert: `---${eol}components:${eol}${normalized}---${eol}${eol}` }
  }

  const openEnd = firstLineEnd + 1
  const closeMatch = /^---[ \t]*\r?$/m.exec(doc.slice(openEnd))
  const closeAt = closeMatch ? openEnd + closeMatch.index : doc.length

  const fm = doc.slice(openEnd, closeAt)
  const componentsLine = /^components:[ \t]*\r?\n/m.exec(fm)
  if (componentsLine) {
    return { at: openEnd + componentsLine.index + componentsLine[0].length, insert: normalized }
  }
  return { at: closeAt, insert: `components:${eol}${normalized}` }
}

/**
 * 把一次斜杠插入翻译成文本变更。
 *
 * 富组件走**两个变更、一次事务**：用户按一次 Ctrl+Z 就整个撤销，
 * 不会留下没有引用方的孤儿声明。
 */
export function planInsert(
  doc: string,
  item: InsertItem,
  from: number,
  to: number,
  frontmatter: string | null,
): InsertPlan {
  const usedKeys = collectComponentKeys(doc)
  const rendered = item.render({ usedKeys })
  const changes: InsertChange[] = []
  let delta = 0

  if (frontmatter) {
    const insertion = componentInsertion(doc, frontmatter)
    changes.push({ from: insertion.at, to: insertion.at, insert: insertion.insert })
    // 文本插入点之前的插入会把正文整体后推；插入点是文件头，必然在正文之前
    delta = insertion.insert.length
  }

  changes.push({ from, to, insert: rendered.text })
  const offset = rendered.cursorOffset ?? rendered.text.length
  return { changes, caretAfter: from + delta + offset }
}
