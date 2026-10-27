/**
 * 行内包裹（加粗 / 斜体 / 删除线 / 行内代码）的文本规划。
 *
 * 单独抽成纯函数有两个原因：
 *  1. **CommonMark 的定界规则**：强调内容不能以空白开头或结尾。`**文字 **`
 *     不是加粗，`~~文字\n~~` 也不是删除线——标记会原样显示在屏幕上。
 *     用户双击选词、拖选整行时尾部常带空格或换行，直接包裹就会踩到这条规则，
 *     体感是「点了删除线，冒出两个波浪线，没有删除线」。
 *  2. 这段逻辑必须能被 node 测试直接覆盖（不引 DOM 与 CM6）。
 *
 * 规划结果只描述「改哪些区间、插什么」，由调用方一次性 dispatch。
 */

export interface WrapChange {
  from: number
  to: number
  insert: string
}

export interface WrapPlan {
  changes: WrapChange[]
  /** 操作后的选区（`from <= to`） */
  selection: { from: number; to: number }
}

/** 选区两端要剥掉的空白：空格、制表符、换行都算（定界规则只认 Unicode 空白） */
function trimBounds(doc: string, from: number, to: number): { from: number; to: number } {
  let start = from
  let end = to
  while (start < end && /\s/.test(doc[start] ?? '')) start += 1
  while (end > start && /\s/.test(doc[end - 1] ?? '')) end -= 1
  return { from: start, to: end }
}

/**
 * 判断区间是否已被同一标记包裹。
 *
 * 单字符标记（`*` / `` ` ``）要额外排除「多字符标记的一部分」：
 * `**加粗**` 里 from-1 是 `*`，若不检查再前一个字符，点斜体就会把加粗拆成斜体。
 */
function wrappedBy(doc: string, from: number, to: number, marker: string): boolean {
  const before = doc.slice(Math.max(0, from - marker.length), from)
  const after = doc.slice(to, to + marker.length)
  if (before !== marker || after !== marker) return false
  if (marker.length !== 1) return true
  return doc[from - 2] !== marker && doc[to + 1] !== marker
}

/** 空选区：插入一对标记，光标停在中间 */
function emptyPlan(from: number, marker: string): WrapPlan {
  const len = marker.length
  return {
    changes: [{ from, to: from, insert: `${marker}${marker}` }],
    selection: { from: from + len, to: from + len },
  }
}

/**
 * 把一次「包裹 / 取消包裹」翻译成文本变更。
 *
 * 覆盖四种输入：
 *  - 空选区：插一对标记，光标居中；
 *  - 选区两端有空白：只包裹**去掉空白后的内容**，空白留在标记外；
 *  - 跨空行（多段落）：强调不能跨段落，按行（逐段）分别包裹；
 *  - 已经完整包裹：去掉标记（再点一次即取消）。
 */
export function planInlineWrap(doc: string, from: number, to: number, marker: string): WrapPlan {
  const len = marker.length
  const start = Math.min(from, to)
  const end = Math.max(from, to)

  if (start === end) return emptyPlan(start, marker)

  const bounds = trimBounds(doc, start, end)
  // 选中全是空白：没有可强调的内容，按空选区处理（落一对标记给用户接着打字）
  if (bounds.from === bounds.to) return emptyPlan(start, marker)

  if (wrappedBy(doc, bounds.from, bounds.to, marker)) {
    return {
      changes: [
        { from: bounds.from - len, to: bounds.from, insert: '' },
        { from: bounds.to, to: bounds.to + len, insert: '' },
      ],
      selection: { from: bounds.from - len, to: bounds.to - len },
    }
  }

  const inner = doc.slice(bounds.from, bounds.to)
  const paragraphs = inner.split(/\n[ \t]*\n/)
  if (paragraphs.length === 1) {
    return {
      changes: [
        { from: bounds.from, to: bounds.from, insert: marker },
        { from: bounds.to, to: bounds.to, insert: marker },
      ],
      selection: { from: bounds.from + len, to: bounds.to + len },
    }
  }

  /*
   * 多段落：按物理行分别包裹。
   *
   * 空行保持原样（它的作用就是分隔段落）；同一段落内的软换行可以跨——
   * 但为了选区映射简单、也为了让用户看清「每一行都被划掉」，这里逐行包裹：
   * `~~第一行~~\n~~第二行~~`。结果与阅读态一致，撤销仍然是一次。
   */
  const changes: WrapChange[] = []
  const segments: Array<{ from: number; to: number }> = []
  let cursor = bounds.from
  for (const line of inner.split('\n')) {
    const lineFrom = cursor
    const lineTo = cursor + line.length
    const trimmed = trimBounds(doc, lineFrom, lineTo)
    if (trimmed.from !== trimmed.to) segments.push(trimmed)
    cursor = lineTo + 1
  }
  if (!segments.length) return emptyPlan(start, marker)

  let delta = 0
  let selection = { from: segments[0]!.from + len, to: segments[0]!.to + len }
  for (const [index, segment] of segments.entries()) {
    changes.push({ from: segment.from, to: segment.from, insert: marker })
    changes.push({ from: segment.to, to: segment.to, insert: marker })
    if (index === 0) selection = { from: segment.from + delta + len, to: segment.to + delta + len }
    else selection.to = segment.to + delta + len
    delta += len * 2
  }
  return { changes, selection }
}
