<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type Component } from 'vue'
import {
  Blocks,
  Code2,
  Heading1,
  Heading2,
  Heading3,
  Image,
  List,
  ListChecks,
  ListOrdered,
  Minus,
  Quote,
  Table,
} from 'lucide-vue-next'

import { groupItems, type InsertItem } from '../lib/insert-menu'

/**
 * 斜杠插入工具条。
 *
 * 形态取舍：**图标按钮 + 悬停提示**，不是一个带说明文字的竖列表。
 *  - 标准 Markdown 项都是通用语法，图标足以自明（列表 / 引用 / 代码块），
 *    再写「无序列表 · 标准 Markdown · 列表」只会让面板又宽又吵；
 *  - 富组件是这台应用特有的东西，图标不能自明，所以**保留文字标签**——
 *    这里恰恰是用户最需要知道「这是什么、会写出什么」的地方；
 *  - 因此面板是横向工具条：上排图标、下排组件 chip，必要时换行。
 *
 * 键盘完全归菜单：打开期间方向键 / Enter / Tab / Esc 在 window 捕获阶段被吃掉，
 * 否则方向键会同时移动编辑器光标，菜单与文档各动一半。
 */
const props = defineProps<{
  open: boolean
  /** 已过滤的候选（由宿主按文档里的 `/query` 过滤） */
  items: InsertItem[]
  /** 锚点：光标的屏幕坐标 */
  anchor: { left: number; top: number; bottom: number } | null
}>()

const emit = defineEmits<{
  select: [item: InsertItem]
  close: []
}>()

const root = ref<HTMLElement | null>(null)
const cursor = ref(0)
const position = ref({ left: 0, top: 0 })

const groups = computed(() => groupItems(props.items))
const markdown = computed(() => props.items.filter(item => item.group === 'markdown'))
const components = computed(() => props.items.filter(item => item.group === 'component'))
/** 扁平顺序：键盘移动要跨过分区 */
const flat = computed(() => groups.value.flatMap(group => group.items))

const ICONS: Record<string, Component> = {
  'heading-1': Heading1,
  'heading-2': Heading2,
  'heading-3': Heading3,
  table: Table,
  code: Code2,
  quote: Quote,
  list: List,
  ordered: ListOrdered,
  task: ListChecks,
  hr: Minus,
  image: Image,
}

function iconOf(item: InsertItem): Component {
  if (item.group === 'component') return Blocks
  return ICONS[item.id] ?? Blocks
}

function place(): void {
  const anchor = props.anchor
  if (!anchor) return
  const width = root.value?.offsetWidth ?? 380
  const height = root.value?.offsetHeight ?? 120
  const margin = 8
  let left = anchor.left
  if (left + width + margin > window.innerWidth) {
    left = Math.max(margin, window.innerWidth - width - margin)
  }
  // 默认贴光标下方；下方不够就翻到上方（两端都不够时取空间更大的一侧）
  const below = anchor.bottom + 4
  const above = anchor.top - height - 4
  const top =
    below + height + margin <= window.innerHeight
      ? below
      : Math.max(margin, above >= margin ? above : window.innerHeight - height - margin)
  position.value = { left, top }
}

watch(
  () => [props.open, props.anchor?.top, props.anchor?.left, props.items.length] as const,
  async () => {
    if (!props.open) return
    // query 变化会改变结果集：光标回到第一个候选，否则会停在已被过滤掉的位置
    if (cursor.value >= flat.value.length) cursor.value = 0
    await nextTick()
    place()
  },
  { immediate: true },
)

watch(
  () => props.items,
  () => {
    cursor.value = 0
  },
)

/**
 * 键盘模型：**上下键跨行、左右键行内移动**。
 *
 * 布局是「第一行基础 Markdown 图标 + 之后每行一个增强组件」，所以导航必须按
 * 二维来想。早先上下键与左右键都映射成 `move(±1)`（一维平铺），结果是：用户按
 * 下键想跳到下一行的组件，实际只是横向挪一格，要连按好几次穿过整排图标才到。
 *
 * 现在的规则：
 *  - ↑ / ↓：换到相邻**行**，列号尽量保持（越界则贴到该行末尾）；
 *  - ← / →：同一行内左右移动，到头不跨行（跨行交给上下键，符合二维直觉）；
 *  - Home / End：跳到当前行的首/尾。
 */
const rows = computed(() => {
  const markdownRow = props.items.filter(item => item.group === 'markdown')
  const componentRows = props.items.filter(item => item.group === 'component')
  return [...(markdownRow.length ? [markdownRow] : []), ...componentRows.map(item => [item])]
})

/** 每一行在 flat 里的起始下标，用于把 (row, col) 与 flat 下标互转 */
const rowOffsets = computed(() => {
  const offsets: number[] = []
  let acc = 0
  for (const row of rows.value) {
    offsets.push(acc)
    acc += row.length
  }
  return offsets
})

/** flat 下标 → { row, col } */
function locate(index: number): { row: number; col: number } {
  const offsets = rowOffsets.value
  let row = 0
  for (let i = 0; i < offsets.length; i += 1) {
    const start = offsets[i]
    if (start === undefined) break
    if (index >= start) row = i
    else break
  }
  return { row, col: index - (offsets[row] ?? 0) }
}

function moveVertical(delta: number): void {
  const layout = rows.value
  if (!layout.length) return
  const { row, col } = locate(cursor.value)
  const nextRow = Math.min(layout.length - 1, Math.max(0, row + delta))
  if (nextRow === row) return
  // 列号尽量保持；目标行更短时贴到末尾
  const targetRow = layout[nextRow] ?? []
  const targetCol = Math.min(col, Math.max(0, targetRow.length - 1))
  cursor.value = (rowOffsets.value[nextRow] ?? 0) + targetCol
}

function moveHorizontal(delta: number): void {
  const layout = rows.value
  if (!layout.length) return
  const { row, col } = locate(cursor.value)
  const width = layout[row]?.length ?? 0
  if (!width) return
  const nextCol = Math.min(width - 1, Math.max(0, col + delta))
  cursor.value = (rowOffsets.value[row] ?? 0) + nextCol
}

function moveToEdge(edge: 'start' | 'end'): void {
  const layout = rows.value
  if (!layout.length) return
  const { row } = locate(cursor.value)
  const width = layout[row]?.length ?? 0
  if (!width) return
  cursor.value = (rowOffsets.value[row] ?? 0) + (edge === 'start' ? 0 : width - 1)
}

function choose(): void {
  const item = flat.value[cursor.value]
  if (!item) return
  emit('select', item)
}

function onKeydown(event: KeyboardEvent): void {
  if (!props.open) return
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    event.stopPropagation()
    moveVertical(1)
    return
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault()
    event.stopPropagation()
    moveVertical(-1)
    return
  }
  if (event.key === 'ArrowRight') {
    event.preventDefault()
    event.stopPropagation()
    moveHorizontal(1)
    return
  }
  if (event.key === 'ArrowLeft') {
    event.preventDefault()
    event.stopPropagation()
    moveHorizontal(-1)
    return
  }
  if (event.key === 'Home') {
    event.preventDefault()
    event.stopPropagation()
    moveToEdge('start')
    return
  }
  if (event.key === 'End') {
    event.preventDefault()
    event.stopPropagation()
    moveToEdge('end')
    return
  }
  if (event.key === 'Enter' || event.key === 'Tab') {
    event.preventDefault()
    event.stopPropagation()
    choose()
    return
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    emit('close')
  }
}

onMounted(() => {
  // 捕获阶段：必须早于 CM6 自己的 keymap 与编辑器冒泡处理
  window.addEventListener('keydown', onKeydown, true)
  window.addEventListener('resize', () => props.open && place())
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown, true)
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      ref="root"
      class="slash"
      role="listbox"
      aria-label="插入"
      :style="{ left: `${position.left}px`, top: `${position.top}px` }"
      @mousedown.prevent
    >
      <!--
        第一行：基础 Markdown，纯图标。
        表格是其中唯一支持表单编辑的项，用右下角小圆点标出来——
        图标行空间太窄，放不下文字徽标，圆点 + tooltip 是唯一可行的标记方式。
      -->
      <div v-if="markdown.length" class="slash__row" role="group" aria-label="标准 Markdown">
        <button
          v-for="item in markdown"
          :key="item.id"
          v-tooltip="{ text: item.label, hint: item.form ? '插入后可点开表单编辑' : item.hint }"
          class="slash__icon"
          :class="{ 'is-active': flat[cursor]?.id === item.id }"
          type="button"
          role="option"
          :aria-selected="flat[cursor]?.id === item.id"
          :aria-label="item.form ? `${item.label}（支持表单编辑）` : item.label"
          @mouseenter="cursor = flat.findIndex(candidate => candidate.id === item.id)"
          @click="emit('select', item)"
        >
          <component :is="iconOf(item)" :size="15" :stroke-width="1.8" />
          <span v-if="item.form" class="slash__icon-form" aria-hidden="true" />
        </button>
      </div>

      <div v-if="components.length" class="slash__group" role="group" aria-label="增强组件">
        <!-- 分组标题独占一行：和 chip 并排会让它看起来像又一个可点的项 -->
        <span class="slash__group-title">增强组件</span>
        <!--
          一行一个：右侧要放「表单 / 手写」标记，横向 chip 排不下；
          单列也让上下键的语义与视觉结构一一对应（按一下 = 下一条）。
        -->
        <button
          v-for="item in components"
          :key="item.id"
          v-tooltip="{ text: item.label, hint: item.hint }"
          class="slash__item"
          :class="{ 'is-active': flat[cursor]?.id === item.id }"
          type="button"
          role="option"
          :aria-selected="flat[cursor]?.id === item.id"
          :aria-label="item.label"
          @mouseenter="cursor = flat.findIndex(candidate => candidate.id === item.id)"
          @click="emit('select', item)"
        >
          <component :is="iconOf(item)" :size="13" :stroke-width="1.8" class="slash__item-icon" />
          <span class="slash__item-label">{{ item.label }}</span>
          <span v-if="item.hint" class="slash__item-hint">{{ item.hint }}</span>
          <span
            class="slash__badge"
            :class="item.form ? 'is-form' : 'is-manual'"
            :title="item.form ? '插入后可点开表单编辑' : '需要手写 YAML'"
          >
            {{ item.form ? '表单' : '手写' }}
          </span>
        </button>
      </div>

      <div v-if="!flat.length" class="slash__empty">没有匹配的插入项</div>

      <footer class="slash__foot">
        <span>{{ flat.length ? '↑↓ 换行 · ←→ 同行移动 · Enter 插入 · Esc 关闭' : '' }}</span>
      </footer>
    </div>
  </Teleport>
</template>

<style scoped>
.slash {
  position: fixed;
  z-index: 90;
  width: max-content;
  max-width: min(460px, calc(100vw - 24px));
  padding: 6px;
  border: 1px solid var(--dv-ui-line);
  border-radius: var(--dv-ui-radius-md);
  background: var(--dv-ui-surface-2);
  box-shadow: var(--dv-ui-shadow-2);
}

.slash__row {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
}

/* 组件区：与上排图标之间画分隔线，标题独占一行 */
.slash__group {
  margin-top: 6px;
  padding-top: 5px;
  border-top: 1px solid var(--dv-ui-line-soft);
}

.slash__group-title {
  display: block;
  padding: 0 0 2px 2px;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--dv-ui-text-dim);
  user-select: none;
}

.slash__icon {
  /* relative：承载右下角那颗「支持表单编辑」圆点 */
  position: relative;
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border: none;
  border-radius: var(--dv-ui-radius-sm);
  background: transparent;
  color: var(--dv-ui-text-2);
  cursor: pointer;
}

.slash__icon:hover,
.slash__icon.is-active {
  background: var(--dv-ui-surface-3);
  color: var(--dv-ui-text);
}

/* 图标行里的「支持表单编辑」圆点：右下角一点，不额外占空间 */
.slash__icon-form {
  position: absolute;
  right: 4px;
  bottom: 4px;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--dv-ui-accent);
}

/*
 * 组件条目：一行一个，右侧是「表单 / 手写」标记。
 *
 * 为什么从横向 chip 改成单列：一是右侧要放支持方式的标记，横排排不下；
 * 二是单列让「按一下下键 = 下一条」与视觉上的下一行完全对应——横排时
 * 下键在一维列表里只是挪一格，用户要连按多次才跨过整排图标。
 */
.slash__item {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  height: 28px;
  padding: 0 7px;
  border: 1px solid transparent;
  border-radius: var(--dv-ui-radius-sm);
  background: transparent;
  color: var(--dv-ui-text-2);
  font-size: 11.5px;
  text-align: left;
  cursor: pointer;
}

.slash__item:hover,
.slash__item.is-active {
  border-color: var(--dv-ui-line-soft);
  background: var(--dv-ui-surface-3);
  color: var(--dv-ui-text);
}

.slash__item-icon {
  flex: none;
  color: var(--dv-ui-text-muted);
}

.slash__item:hover .slash__item-icon,
.slash__item.is-active .slash__item-icon {
  color: var(--dv-ui-accent);
}

.slash__item-label {
  flex: none;
  white-space: nowrap;
}

/* 说明文字可省略：空间不够时先牺牲它，标记与名称必须始终可见 */
.slash__item-hint {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10.5px;
  color: var(--dv-ui-text-dim);
}

/* 标记固定在右侧：即使 hint 被省略，它也不会移位 */
.slash__badge {
  flex: none;
  margin-left: auto;
  padding: 1px 5px;
  border-radius: 999px;
  font-size: 9.5px;
  line-height: 1.6;
  letter-spacing: 0.02em;
  user-select: none;
}

.slash__badge.is-form {
  color: var(--dv-ui-accent);
  background: color-mix(in srgb, var(--dv-ui-accent) 14%, transparent);
}

.slash__badge.is-manual {
  color: var(--dv-ui-text-dim);
  background: var(--dv-ui-surface-3);
}

.slash__empty {
  padding: 10px 6px;
  font-size: 12px;
  color: var(--dv-ui-text-dim);
}

.slash__foot {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 5px;
  padding: 5px 6px 1px;
  border-top: 1px solid var(--dv-ui-line-soft);
  font-size: 10.5px;
  color: var(--dv-ui-text-dim);
}
</style>
