/**
 * 斜杠菜单的二维键盘导航（纯逻辑，只算下标，不碰 DOM 也不碰 Vue）。
 *
 * 为什么单独拆出来：菜单布局是「第一行基础 Markdown 图标 + 之后每行一个增强
 * 组件」，导航必须按二维理解。早先上下键与左右键都映射成 `move(±1)`，用户
 * 按下键想跳到下一行的组件，实际只是横向挪一格，得连按好几次穿过整排图标。
 * 这类「差一个维度」的错误肉眼审代码很难发现，抽成纯函数才锁得住。
 */

export interface NavItem {
  group: 'markdown' | 'component'
}

/**
 * 把一维的条目列表还原成视觉上的行。
 *
 * 标准 Markdown 项共用第一行；每个增强组件独占一行（右侧要放「表单 / 手写」
 * 标记，横排排不下）。两个分组都可能因为搜索过滤而变空，空行不参与导航。
 */
export function buildRows<T extends NavItem>(items: readonly T[]): T[][] {
  const markdownRow = items.filter(item => item.group === 'markdown')
  const componentRows = items.filter(item => item.group === 'component').map(item => [item])
  return [...(markdownRow.length ? [markdownRow] : []), ...componentRows]
}

/** 每行在扁平列表里的起始下标，用于 (row, col) 与扁平下标互转 */
export function rowOffsets(rows: readonly unknown[][]): number[] {
  const offsets: number[] = []
  let acc = 0
  for (const row of rows) {
    offsets.push(acc)
    acc += row.length
  }
  return offsets
}

/** 扁平下标 → { row, col } */
export function locate(
  rows: readonly unknown[][],
  offsets: readonly number[],
  index: number,
): { row: number; col: number } {
  let row = 0
  for (let i = 0; i < offsets.length; i += 1) {
    const start = offsets[i]
    if (start === undefined) break
    if (index >= start) row = i
    else break
  }
  const width = rows[row]?.length ?? 1
  const start = offsets[row] ?? 0
  // 下标越界时贴到行尾，避免算出负数或超出列宽
  const col = Math.min(Math.max(index - start, 0), Math.max(width - 1, 0))
  return { row, col }
}

/**
 * 上下移动：换到相邻**行**，列号尽量保持（目标行更短则贴到该行末尾）。
 *
 * 保持列号而不是重置到行首，是为了让「第一行第 3 个图标 → 键」这类动作
 * 符合二维直觉；到了组件区每行只有一个，列号自然归零。
 */
export function moveVertical(
  rows: readonly unknown[][],
  offsets: readonly number[],
  index: number,
  delta: number,
): number {
  if (!rows.length) return index
  const { row, col } = locate(rows, offsets, index)
  const nextRow = Math.min(rows.length - 1, Math.max(0, row + delta))
  if (nextRow === row) return index
  const width = rows[nextRow]?.length ?? 1
  const targetCol = Math.min(col, Math.max(width - 1, 0))
  return (offsets[nextRow] ?? 0) + targetCol
}

/**
 * 同行内左右移动：到头**不跨行**。
 *
 * 跨行交给上下键。若左右键也跨行，用户在长组件列表里按住右键会横穿分组边界，
 * 与「左右 = 同一行内挪」的视觉直觉冲突。
 */
export function moveHorizontal(
  rows: readonly unknown[][],
  offsets: readonly number[],
  index: number,
  delta: number,
): number {
  if (!rows.length) return index
  const { row, col } = locate(rows, offsets, index)
  const width = rows[row]?.length ?? 1
  const nextCol = Math.min(Math.max(width - 1, 0), Math.max(0, col + delta))
  return (offsets[row] ?? 0) + nextCol
}

/** Home / End：跳到当前行的首个 / 最后一个条目 */
export function moveToEdge(
  rows: readonly unknown[][],
  offsets: readonly number[],
  index: number,
  edge: 'start' | 'end',
): number {
  if (!rows.length) return index
  const { row } = locate(rows, offsets, index)
  const start = offsets[row] ?? 0
  if (edge === 'start') return start
  const width = rows[row]?.length ?? 1
  return start + Math.max(width - 1, 0)
}
