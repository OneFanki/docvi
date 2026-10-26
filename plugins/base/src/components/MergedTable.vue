<script setup lang="ts">
import { computed } from 'vue'

/**
 * 合并单元格表格。
 *
 * Markdown 原生表达不了 rowspan/colspan，这里用**结构化块**作为补充：
 * Markdown 仍是事实源（内容写在 ::: merged 容器里的 YAML），
 * 只是这一段以数据的形式描述表格结构，由组件负责渲染。
 *
 * 数据协议（YAML → props）：
 *   columns: [名称, 负责人, 状态]
 *   caption: 可选说明
 *   rows:
 *     - [甲, 张三, 完成]                 # 普通行
 *     - [{ cell: 乙, rowspan: 2 }, 李四, 进行中]
 *     - [{ cell: 同上, colspan: 2 }, 未开始]
 */
interface CellSpec {
  cell?: string | number | boolean
  /** 纵向合并行数 */
  rowspan?: number
  /** 横向合并列数 */
  colspan?: number
  align?: 'left' | 'center' | 'right'
  /** 作为行表头渲染（th） */
  head?: boolean
}

type Cell = string | number | boolean | null | CellSpec
type Row = Cell[]

const props = defineProps<{
  title?: string
  columns?: string[]
  caption?: string
  rows?: Row[]
}>()

function isSpec(cell: Cell): cell is CellSpec {
  return typeof cell === 'object' && cell !== null && !Array.isArray(cell)
}

function textOf(cell: Cell): string {
  if (cell === null || cell === undefined) return ''
  if (isSpec(cell)) return cell.cell === undefined ? '' : String(cell.cell)
  return String(cell)
}

function spanOf(cell: Cell, key: 'rowspan' | 'colspan'): number {
  if (!isSpec(cell)) return 1
  const value = cell[key]
  return typeof value === 'number' && Number.isFinite(value) && value > 1 ? Math.floor(value) : 1
}

/**
 * 布局：把每个单元格放到网格的「起始位置」，记录它覆盖的矩形。
 *
 * 为什么先建网格再渲染：合并单元格本质是有状态的列推进
 * （某个 rowspan 会占住下面若干行的同一列）。在模板里做这种推进既不可读，
 * 也容易在 rowspan ≥ 3 时算错——一次性算清楚，模板只负责输出。
 */
interface PlacedCell {
  text: string
  rowspan: number
  colspan: number
  align?: 'left' | 'center' | 'right'
  head: boolean
  /** 起始行/列 */
  row: number
  col: number
}

const layout = computed(() => {
  const rows = props.rows ?? []
  /** taken[row][col] = 该格已被某个合并单元格占用 */
  const taken: boolean[][] = Array.from({ length: rows.length }, () => [] as boolean[])

  const placed: PlacedCell[] = []
  let widest = props.columns?.length ?? 0

  rows.forEach((row, rowIndex) => {
    let col = 0
    for (const cell of row) {
      const line = taken[rowIndex] ?? (taken[rowIndex] = [])
      // 跳过被上方 rowspan 占住的列
      while (line[col]) col += 1

      const rowspan = Math.min(spanOf(cell, 'rowspan'), rows.length - rowIndex)
      const colspan = spanOf(cell, 'colspan')

      for (let r = rowIndex; r < rowIndex + rowspan; r += 1) {
        const target = taken[r] ?? (taken[r] = [])
        for (let c = col; c < col + colspan; c += 1) target[c] = true
      }

      placed.push({
        text: textOf(cell),
        rowspan,
        colspan,
        ...(isSpec(cell) && cell.align ? { align: cell.align } : {}),
        head: isSpec(cell) && cell.head === true,
        row: rowIndex,
        col,
      })

      col += colspan
      widest = Math.max(widest, col)
    }
    // 行尾被合并单元格占到的列也算进总列数
    widest = Math.max(widest, taken[rowIndex]?.length ?? 0)
  })

  const columnCount = Math.max(widest, 1)
  /** 按行分组，模板逐行输出 */
  const byRow = rows.map((_row, rowIndex) => placed.filter(cell => cell.row === rowIndex))
  return { columnCount, byRow }
})

/** 列头末列补齐：声明的列数少于实际网格时，让最后一列表头横跨剩余列 */
const headerTail = computed(() =>
  Math.max(0, layout.value.columnCount - (props.columns?.length ?? 0)),
)
</script>

<template>
  <section class="at-merged">
    <header v-if="title" class="at-merged__head">
      <span class="at-merged__title">{{ title }}</span>
    </header>

    <div class="at-merged__scroll">
      <table class="at-merged__table">
        <thead v-if="columns?.length">
          <tr>
            <th
              v-for="(column, index) in columns"
              :key="index"
              :colspan="index === columns.length - 1 && headerTail > 0 ? headerTail + 1 : 1"
            >
              {{ column }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, rowIndex) in layout.byRow" :key="rowIndex">
            <component
              :is="cell.head ? 'th' : 'td'"
              v-for="(cell, index) in row"
              :key="index"
              :rowspan="cell.rowspan > 1 ? cell.rowspan : undefined"
              :colspan="cell.colspan > 1 ? cell.colspan : undefined"
              :style="cell.align ? `text-align: ${cell.align}` : undefined"
            >
              {{ cell.text }}
            </component>
          </tr>
        </tbody>
      </table>
    </div>

    <p v-if="caption" class="at-merged__caption">{{ caption }}</p>
  </section>
</template>

<style scoped>
.at-merged {
  margin: 16px 0;
  border: 1px solid var(--dv-c-border);
  border-radius: var(--dv-c-radius-md, 8px);
  background: var(--dv-c-surface);
  overflow: hidden;
}

.at-merged__head {
  padding: 9px 14px;
  border-bottom: 1px solid var(--dv-c-border);
  background: var(--dv-c-surface-2);
}

.at-merged__title {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--dv-c-text);
}

.at-merged__scroll {
  overflow-x: auto;
}

.at-merged__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.at-merged__table th,
.at-merged__table td {
  padding: 8px 12px;
  border: 1px solid var(--dv-c-border);
  text-align: left;
  vertical-align: top;
  color: var(--dv-c-text);
}

.at-merged__table thead th {
  background: var(--dv-c-surface-2);
  font-weight: 600;
}

.at-merged__table tbody th {
  background: var(--dv-c-surface-2);
  font-weight: 560;
}

.at-merged__caption {
  margin: 0;
  padding: 8px 14px;
  border-top: 1px solid var(--dv-c-border);
  font-size: 11.5px;
  color: var(--dv-c-text-muted);
}
</style>
