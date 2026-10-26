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

function move(delta: number): void {
  const count = flat.value.length
  if (!count) return
  cursor.value = (cursor.value + delta + count) % count
}

function choose(): void {
  const item = flat.value[cursor.value]
  if (!item) return
  emit('select', item)
}

function onKeydown(event: KeyboardEvent): void {
  if (!props.open) return
  if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
    event.preventDefault()
    event.stopPropagation()
    move(1)
    return
  }
  if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
    event.preventDefault()
    event.stopPropagation()
    move(-1)
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
      <div v-if="markdown.length" class="slash__row" role="group" aria-label="标准 Markdown">
        <button
          v-for="item in markdown"
          :key="item.id"
          v-tooltip="{ text: item.label, hint: item.hint }"
          class="slash__icon"
          :class="{ 'is-active': flat[cursor]?.id === item.id }"
          type="button"
          role="option"
          :aria-selected="flat[cursor]?.id === item.id"
          :aria-label="item.label"
          @mouseenter="cursor = flat.findIndex(candidate => candidate.id === item.id)"
          @click="emit('select', item)"
        >
          <component :is="iconOf(item)" :size="15" :stroke-width="1.8" />
        </button>
      </div>

      <div v-if="components.length" class="slash__group" role="group" aria-label="增强组件">
        <!-- 分组标题独占一行：和 chip 并排会让它看起来像又一个可点的项 -->
        <span class="slash__group-title">增强组件</span>
        <div class="slash__row slash__row--components">
          <button
            v-for="item in components"
            :key="item.id"
            v-tooltip="{ text: item.label, hint: item.hint }"
            class="slash__chip"
            :class="{ 'is-active': flat[cursor]?.id === item.id }"
            type="button"
            role="option"
            :aria-selected="flat[cursor]?.id === item.id"
            :aria-label="item.label"
            @mouseenter="cursor = flat.findIndex(candidate => candidate.id === item.id)"
            @click="emit('select', item)"
          >
            <component :is="iconOf(item)" :size="13" :stroke-width="1.8" class="slash__chip-icon" />
            <span class="slash__chip-label">{{ item.label }}</span>
          </button>
        </div>
      </div>

      <div v-if="!flat.length" class="slash__empty">没有匹配的插入项</div>

      <footer class="slash__foot">
        <span>{{ flat.length ? '↑↓ 选择 · Enter 插入 · Esc 关闭' : '' }}</span>
      </footer>
    </div>
  </Teleport>
</template>

<style scoped>
.slash {
  position: fixed;
  z-index: 90;
  width: max-content;
  max-width: min(420px, calc(100vw - 24px));
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

.slash__row--components {
  gap: 4px;
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

.slash__chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 8px;
  border: 1px solid transparent;
  border-radius: var(--dv-ui-radius-sm);
  background: transparent;
  color: var(--dv-ui-text-2);
  font-size: 11.5px;
  white-space: nowrap;
  cursor: pointer;
}

.slash__chip:hover,
.slash__chip.is-active {
  border-color: var(--dv-ui-line-soft);
  background: var(--dv-ui-surface-3);
  color: var(--dv-ui-text);
}

.slash__chip-icon {
  flex: none;
  color: var(--dv-ui-text-muted);
}

.slash__chip:hover .slash__chip-icon,
.slash__chip.is-active .slash__chip-icon {
  color: var(--dv-ui-accent);
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
