/**
 * 原生 Markdown 表格模型：解析 ↔ 序列化。
 *
 * 为什么要有它：可视化表格编辑器的产物**必须是标准 Markdown 表格原文**。
 * 一旦改存成结构化数据（frontmatter / 组件），这份文件就不再能被任何别的
 * Markdown 编辑器打开——那样等于用编辑器把文档锁死了。
 *
 * 所以这里只做「文本 ↔ 网格」的无损转换，不引入任何私有语法。
 */

export type CellAlign = 'left' | 'center' | 'right' | null

export interface TableModel {
  header: string[]
  align: CellAlign[]
  rows: string[][]
}

/** 拆一行表格：按未转义的 `|` 切分，保留单元格内的 `\|` 原样 */
function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  const cells: string[] = []
  let current = ''
  for (let i = 0; i < trimmed.length; i += 1) {
    const char = trimmed[i]
    if (char === '\\' && trimmed[i + 1] === '|') {
      current += '\\|'
      i += 1
      continue
    }
    if (char === '|') {
      cells.push(current.trim())
      current = ''
      continue
    }
    current += char
  }
  cells.push(current.trim())
  return cells
}

/** 对齐行：`---` / `:--` / `--:` / `:-:` */
function parseAlign(cell: string): CellAlign {
  const value = cell.trim()
  if (!/^:?-{1,}:?$/.test(value)) return null
  const left = value.startsWith(':')
  const right = value.endsWith(':')
  if (left && right) return 'center'
  if (right) return 'right'
  if (left) return 'left'
  return null
}

/**
 * 解析表格源码。
 *
 * 宽松策略：列数不齐时按最宽列补齐（缺的格子当空串）。表格在人工维护的
 * 文档里几乎必然出现「少写一个竖线」的情况，直接判失败会让编辑器打不开。
 */
export function parseTable(source: string): TableModel | null {
  const lines = source
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0)
  if (lines.length < 2) return null
  const header = splitRow(lines[0] ?? '')
  const delimiter = splitRow(lines[1] ?? '')
  if (!header.length) return null
  // 分隔行至少要有一个 `---` 形式的格子，否则这不是表格
  if (!delimiter.some(cell => parseAlign(cell) !== null || /^-+$/.test(cell))) return null

  const columns = Math.max(header.length, delimiter.length)
  const rows = lines.slice(2).map(line => {
    const cells = splitRow(line)
    return Array.from({ length: columns }, (_, i) => cells[i] ?? '')
  })

  return {
    header: Array.from({ length: columns }, (_, i) => header[i] ?? ''),
    align: Array.from({ length: columns }, (_, i) => parseAlign(delimiter[i] ?? '') ?? null),
    rows,
  }
}

function alignMark(align: CellAlign): string {
  if (align === 'center') return ':---:'
  if (align === 'left') return ':---'
  if (align === 'right') return '---:'
  return '---'
}

function escapeCell(text: string): string {
  // 单元格里的裸 `|` 会把列切开；只转义未转义的竖线，换行压成空格
  return text
    .replace(/(?<!\\)\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .trim()
}

/**
 * 序列化成标准 Markdown 表格。
 *
 * 按列内容宽度补空格对齐（最小 3，给 `---` 留位置）——不是为了好看而已：
 * 宽度固定的输出意味着「打开再保存」不会产生无意义的大 diff，表格在版本
 * 历史里才看得清到底改了什么。
 */
export function serializeTable(model: TableModel): string {
  const columns = Math.max(model.header.length, model.align.length, 1)
  const header = Array.from({ length: columns }, (_, i) => escapeCell(model.header[i] ?? ''))
  const align = Array.from({ length: columns }, (_, i) => model.align[i] ?? null)
  const rows = model.rows.map(row =>
    Array.from({ length: columns }, (_, i) => escapeCell(row[i] ?? '')),
  )

  const widths = Array.from({ length: columns }, (_, i) => {
    const candidates = [header[i]?.length ?? 0, alignMark(align[i] ?? null).length, 3]
    for (const row of rows) candidates.push(row[i]?.length ?? 0)
    return Math.max(...candidates)
  })

  const pad = (text: string, width: number): string => text + ' '.repeat(width - text.length)
  const line = (cells: string[]): string =>
    `| ${cells.map((cell, i) => pad(cell, widths[i] ?? 3)).join(' | ')} |`

  return [
    line(header),
    line(align.map(mark => alignMark(mark))),
    ...rows.map(row => line(row)),
  ].join('\n')
}

/** 新表格：rows × columns，带表头文字，便于插入后立刻能认出来 */
export function createTable(rows: number, columns: number): TableModel {
  const safeRows = Math.max(0, rows)
  const safeColumns = Math.max(1, columns)
  return {
    header: Array.from({ length: safeColumns }, (_, i) => `列 ${i + 1}`),
    align: Array.from({ length: safeColumns }, () => null),
    rows: Array.from({ length: safeRows }, () => Array.from({ length: safeColumns }, () => '')),
  }
}

/** 加/删行（keepHeader 永远保留表头） */
export function addRow(model: TableModel): TableModel {
  return { ...model, rows: [...model.rows, Array.from({ length: model.header.length }, () => '')] }
}

export function removeRow(model: TableModel, index: number): TableModel {
  return { ...model, rows: model.rows.filter((_, i) => i !== index) }
}

export function addColumn(model: TableModel): TableModel {
  return {
    header: [...model.header, `列 ${model.header.length + 1}`],
    align: [...model.align, null],
    rows: model.rows.map(row => [...row, '']),
  }
}

export function removeColumn(model: TableModel, index: number): TableModel {
  if (model.header.length <= 1) return model
  return {
    header: model.header.filter((_, i) => i !== index),
    align: model.align.filter((_, i) => i !== index),
    rows: model.rows.map(row => row.filter((_, i) => i !== index)),
  }
}

export function setCell(
  model: TableModel,
  row: number | 'header',
  column: number,
  value: string,
): TableModel {
  if (row === 'header') {
    return { ...model, header: model.header.map((cell, i) => (i === column ? value : cell)) }
  }
  return {
    ...model,
    rows: model.rows.map((cells, r) =>
      r === row ? cells.map((cell, i) => (i === column ? value : cell)) : cells,
    ),
  }
}

export function cycleAlign(align: CellAlign): CellAlign {
  if (align === null) return 'left'
  if (align === 'left') return 'center'
  if (align === 'center') return 'right'
  return null
}
