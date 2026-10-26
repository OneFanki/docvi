<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  AlignStartVertical,
  Plus,
  Trash2,
  X,
} from 'lucide-vue-next'

import {
  addColumn,
  addRow,
  cycleAlign,
  removeColumn,
  removeRow,
  serializeTable,
  setCell,
  type TableModel,
} from '@docvi/editor'

/**
 * 原生 Markdown 表格的网格编辑器。
 *
 * 定位：**这是原生 Markdown 表格的可视化外壳，不是另一种表格**。
 * 产物永远是 `| a | b |` 这种标准 Markdown 原文，改完另存，任何编辑器都能打开。
 * 所以这里没有「合并单元格」这类原生表达不了的按钮——那些能力属于富组件
 * （`::: merged`），若混进这个编辑器，用户会以为原生表格也能合并。
 *
 * 交互约定：
 *  - Enter：同列下移一格，已在最后一行就新增一行并移过去（连续录入不用离开键盘）；
 *  - Tab / Shift+Tab：浏览器默认的前后格移动；
 *  - 对齐按钮在列头上循环 左 / 中 / 右 / 默认。
 */
const props = defineProps<{
  open: boolean
  model: TableModel | null
}>()

const emit = defineEmits<{
  save: [model: TableModel]
  close: []
}>()

/** 编辑副本：保存前不碰文档，取消即丢弃 */
const draft = ref<TableModel>({ header: [''], align: [null], rows: [] })
const showSource = ref(false)
const grid = ref<HTMLElement | null>(null)

watch(
  () => props.open,
  async open => {
    if (!open) {
      showSource.value = false
      return
    }
    // 深拷贝：直接引用会边编辑边改宿主状态，取消就失去意义
    draft.value = props.model
      ? {
          header: [...props.model.header],
          align: [...props.model.align],
          rows: props.model.rows.map(row => [...row]),
        }
      : { header: ['列 1'], align: [null], rows: [['']] }
    await nextTick()
    focusCell('header', 0)
  },
)

const source = computed(() => serializeTable(draft.value))

function alignIcon(align: TableModel['align'][number]): typeof AlignLeft {
  if (align === 'center') return AlignCenter
  if (align === 'right') return AlignRight
  return AlignLeft
}

function alignLabel(align: TableModel['align'][number]): string {
  if (align === 'center') return '居中对齐'
  if (align === 'right') return '右对齐'
  if (align === 'left') return '左对齐'
  return '默认对齐'
}

function focusCell(row: number | 'header', column: number): void {
  const selector = `[data-cell="${row === 'header' ? -1 : row}:${column}"]`
  grid.value?.querySelector<HTMLInputElement>(selector)?.focus()
}

function onCellKeydown(event: KeyboardEvent, row: number, column: number): void {
  if (event.key !== 'Enter') return
  event.preventDefault()
  const isHeader = row === -1
  if (isHeader) {
    focusCell(0, column)
    return
  }
  if (row === draft.value.rows.length - 1) draft.value = addRow(draft.value)
  void nextTick(() => focusCell(row + 1, column))
}

function updateCell(row: number | 'header', column: number, value: string): void {
  draft.value = setCell(draft.value, row, column, value)
}

function doAddColumn(): void {
  draft.value = addColumn(draft.value)
}

function doRemoveColumn(index: number): void {
  draft.value = removeColumn(draft.value, index)
}

function doAddRow(): void {
  draft.value = addRow(draft.value)
}

function doRemoveRow(index: number): void {
  draft.value = removeRow(draft.value, index)
}

function cycle(column: number): void {
  draft.value = {
    ...draft.value,
    align: draft.value.align.map((current, index) =>
      index === column ? cycleAlign(current) : current,
    ),
  }
}

function submit(): void {
  emit('save', draft.value)
}

function onKeydown(event: KeyboardEvent): void {
  if (!props.open || event.key !== 'Escape') return
  event.preventDefault()
  event.stopPropagation()
  emit('close')
}

onMounted(() => window.addEventListener('keydown', onKeydown, true))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown, true))
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="tbl" @mousedown.self="emit('close')">
      <section class="tbl__card" role="dialog" aria-modal="true" aria-label="编辑表格">
        <header class="tbl__head">
          <div>
            <h2 class="tbl__title">编辑表格</h2>
            <p class="tbl__sub">保存后写回标准 Markdown 表格原文</p>
          </div>
          <button class="tbl__icon" type="button" aria-label="关闭" @click="emit('close')">
            <X :size="15" :stroke-width="2" />
          </button>
        </header>

        <div ref="grid" class="tbl__grid">
          <table>
            <thead>
              <tr>
                <th class="tbl__gutter" />
                <th v-for="(cell, column) in draft.header" :key="`h-${column}`" class="tbl__th">
                  <div class="tbl__colhead">
                    <input
                      class="tbl__input tbl__input--head"
                      :data-cell="`-1:${column}`"
                      :value="cell"
                      :placeholder="`列 ${column + 1}`"
                      @input="
                        updateCell('header', column, ($event.target as HTMLInputElement).value)
                      "
                      @keydown="onCellKeydown($event, -1, column)"
                    />
                    <button
                      v-tooltip="alignLabel(draft.align[column] ?? null)"
                      class="tbl__colbtn"
                      type="button"
                      @click="cycle(column)"
                    >
                      <component :is="alignIcon(draft.align[column] ?? null)" :size="12" />
                    </button>
                    <button
                      v-tooltip="'删除此列'"
                      class="tbl__colbtn"
                      type="button"
                      :disabled="draft.header.length <= 1"
                      @click="doRemoveColumn(column)"
                    >
                      <Trash2 :size="12" />
                    </button>
                  </div>
                </th>
                <th class="tbl__gutter" />
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, rowIndex) in draft.rows" :key="`r-${rowIndex}`">
                <th class="tbl__gutter">
                  <button
                    v-tooltip="'删除此行'"
                    class="tbl__rowbtn"
                    type="button"
                    @click="doRemoveRow(rowIndex)"
                  >
                    <Trash2 :size="12" />
                  </button>
                </th>
                <td v-for="(cell, column) in row" :key="`c-${rowIndex}-${column}`">
                  <input
                    class="tbl__input"
                    :data-cell="`${rowIndex}:${column}`"
                    :value="cell"
                    @input="updateCell(rowIndex, column, ($event.target as HTMLInputElement).value)"
                    @keydown="onCellKeydown($event, rowIndex, column)"
                  />
                </td>
                <td class="tbl__gutter" />
              </tr>
            </tbody>
          </table>
          <div v-if="!draft.rows.length" class="tbl__empty">还没有数据行</div>
        </div>

        <div class="tbl__tools">
          <button class="tbl__tool" type="button" @click="doAddRow">
            <Plus :size="13" /> 添加行
          </button>
          <button class="tbl__tool" type="button" @click="doAddColumn">
            <Plus :size="13" /> 添加列
          </button>
          <button
            class="tbl__tool tbl__tool--ghost"
            type="button"
            @click="showSource = !showSource"
          >
            <AlignStartVertical :size="13" />
            {{ showSource ? '隐藏源码' : '查看源码' }}
          </button>
        </div>

        <pre v-if="showSource" class="tbl__source">{{ source }}</pre>

        <footer class="tbl__foot">
          <span class="tbl__hint">Enter 下移一格 · Tab 前后切换</span>
          <button class="tbl__btn" type="button" @click="emit('close')">取消</button>
          <button class="tbl__btn tbl__btn--primary" type="button" @click="submit">保存</button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.tbl {
  position: fixed;
  inset: 0;
  z-index: 95;
  display: grid;
  place-items: center;
  padding: 24px;
  background: color-mix(in srgb, var(--dv-ui-bg) 62%, transparent);
}

.tbl__card {
  display: flex;
  flex-direction: column;
  width: min(760px, 100%);
  max-height: calc(100vh - 48px);
  border: 1px solid var(--dv-ui-line);
  border-radius: var(--dv-ui-radius-md);
  background: var(--dv-ui-surface-2);
  box-shadow: var(--dv-ui-shadow-2);
}

.tbl__head {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 16px 18px 12px;
  border-bottom: 1px solid var(--dv-ui-line-soft);
}

.tbl__title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--dv-ui-text);
}

.tbl__sub {
  margin: 3px 0 0;
  font-size: 11.5px;
  color: var(--dv-ui-text-dim);
}

.tbl__icon {
  margin-left: auto;
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border: none;
  border-radius: var(--dv-ui-radius-sm);
  background: transparent;
  color: var(--dv-ui-text-dim);
  cursor: pointer;
}

.tbl__icon:hover {
  background: var(--dv-ui-surface-3);
  color: var(--dv-ui-text);
}

.tbl__grid {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 12px 18px;
}

.tbl__grid table {
  border-collapse: separate;
  border-spacing: 0;
  width: 100%;
}

.tbl__th,
.tbl__grid td {
  border: 1px solid var(--dv-ui-line-soft);
  padding: 0;
}

.tbl__th {
  background: var(--dv-ui-surface-3);
}

.tbl__gutter {
  width: 26px;
  border: none !important;
  background: transparent;
  padding: 0;
}

.tbl__colhead {
  display: flex;
  align-items: center;
}

.tbl__colbtn,
.tbl__rowbtn {
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  flex: none;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--dv-ui-text-dim);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.12s ease;
}

.tbl__th:hover .tbl__colbtn,
tr:hover .tbl__rowbtn {
  opacity: 1;
}

.tbl__colbtn:hover,
.tbl__rowbtn:hover {
  background: var(--dv-ui-surface-2);
  color: var(--dv-ui-text);
}

.tbl__colbtn:disabled {
  opacity: 0.3;
  cursor: default;
}

.tbl__input {
  width: 100%;
  min-width: 90px;
  height: 30px;
  padding: 0 8px;
  border: none;
  background: transparent;
  color: var(--dv-ui-text);
  font-size: 12.5px;
  outline: none;
}

.tbl__input:focus {
  background: color-mix(in srgb, var(--dv-ui-accent) 12%, transparent);
}

.tbl__input--head {
  font-weight: 600;
}

.tbl__empty {
  padding: 14px 4px;
  font-size: 12px;
  color: var(--dv-ui-text-dim);
}

.tbl__tools {
  display: flex;
  gap: 8px;
  padding: 10px 18px;
  border-top: 1px solid var(--dv-ui-line-soft);
}

.tbl__tool {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 9px;
  border: 1px solid var(--dv-ui-line-soft);
  border-radius: var(--dv-ui-radius-sm);
  background: transparent;
  color: var(--dv-ui-text-2);
  font-size: 11.5px;
  cursor: pointer;
}

.tbl__tool:hover {
  background: var(--dv-ui-surface-3);
}

.tbl__tool--ghost {
  margin-left: auto;
  border-color: transparent;
  color: var(--dv-ui-text-dim);
}

.tbl__source {
  max-height: 33vh;
  margin: 0 18px 10px;
  padding: 10px;
  overflow: auto;
  border: 1px solid var(--dv-ui-line-soft);
  border-radius: var(--dv-ui-radius-sm);
  background: var(--dv-ui-bg);
  color: var(--dv-ui-text-muted);
  font-family: var(--dv-doc-font-mono, ui-monospace, 'Cascadia Code', Consolas, monospace);
  font-size: 11.5px;
  line-height: 1.6;
  white-space: pre;
}

.tbl__foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 18px 14px;
  border-top: 1px solid var(--dv-ui-line-soft);
}

.tbl__hint {
  margin-right: auto;
  font-size: 11px;
  color: var(--dv-ui-text-dim);
}

.tbl__btn {
  height: 28px;
  padding: 0 14px;
  border: 1px solid var(--dv-ui-line-soft);
  border-radius: var(--dv-ui-radius-sm);
  background: transparent;
  color: var(--dv-ui-text-2);
  font-size: 12px;
  cursor: pointer;
}

.tbl__btn:hover {
  background: var(--dv-ui-surface-3);
}

.tbl__btn--primary {
  border-color: transparent;
  background: var(--dv-ui-accent);
  color: var(--dv-ui-accent-fg);
}
</style>
