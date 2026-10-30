<script setup lang="ts">
import { computed, ref } from 'vue'
import { ChevronRight, FileText, Folder, FolderOpen } from 'lucide-vue-next'

import type { TreeNode } from '@docvi/shared'
import { TREE_DND_TYPE } from '../lib/tree-selection'

/**
 * 单个树节点（递归组件）。
 *
 * 展开状态由父级 DocTree 通过 Set 统一持有并下传——放在每个节点自己身上会
 * 导致「折叠父目录再展开，子目录的展开状态错乱」。
 */
const props = defineProps<{
  node: TreeNode
  depth: number
  expanded: Set<string>
  /** 当前打开的文档（行级强高亮，语义是「正在读」） */
  selectedPath: string | null
  /** 批量选中的路径集合（次级高亮，语义是「接下来要一起操作」） */
  checked: Set<string>
  /** 键盘焦点所在节点（roving tabindex） */
  focusedPath?: string | null
  /** 拖拽悬停的落点路径（高亮目标目录） */
  dropTarget?: string | null
  /** 是否可拖拽（只读宿主关闭） */
  draggable?: boolean
}>()

const emit = defineEmits<{
  open: [path: string]
  toggle: [path: string]
  /** 右键：交给 DocTree 弹菜单（需要节点路径与是否目录） */
  context: [event: MouseEvent, path: string]
  /** 修饰键选择：single=单选（伴随点击的默认行为）、toggle=Ctrl、range=Shift */
  select: [mode: 'single' | 'toggle' | 'range', path: string]
  dragStart: [event: DragEvent, path: string]
  dragEnd: [event: DragEvent]
  dragOverRow: [event: DragEvent, path: string]
  dragLeaveRow: [event: DragEvent]
  dropRow: [event: DragEvent, path: string]
}>()

const rowEl = ref<HTMLElement | null>(null)

const isDir = computed(() => props.node.type === 'dir')
const isOpen = computed(() => props.expanded.has(props.node.path))

/** 目录有落地页才可进入正文；无落地页的纯分组目录只负责展开 */
const canEnter = computed(() => props.node.landing !== undefined)

/**
 * 节点图标。
 *
 * 三个语义不能混：
 *  - 普通文档           → 文档图标
 *  - 有落地页的目录     → **文档图标**（它本身就是一篇可读的文章，只是下面还挂着子页）
 *  - 纯分组目录         → 文件夹（展开时打开状）
 *
 * 重构前有落地页的目录显示为文档图标，这版一度退化成统一文件夹，
 * 结果是「点它到底是展开还是打开正文」完全看不出来。
 */
const icon = computed(() => {
  if (!isDir.value) return FileText
  return canEnter.value ? FileText : isOpen.value ? FolderOpen : Folder
})

/**
 * 图标配色：按节点类型区分，不再全部涂成同一种灰。
 *
 * 整棵树的图标与文字同色时，扫视只能靠缩进，眼睛很累；但也不能上高饱和
 * （一屏几十个彩色图标会变成噪声），因此取「低饱和 + 明度略低于文字」的中间档。
 */
const iconClass = computed(() => {
  if (!isDir.value) return 'icon--doc'
  return canEnter.value ? 'icon--page' : 'icon--dir'
})

const isSelected = computed(() => {
  const target = props.node.landing ?? (isDir.value ? null : props.node.path)
  return target !== null && target === props.selectedPath
})

const isChecked = computed(() => props.checked.has(props.node.path))

const isDropTarget = computed(() => props.dropTarget === props.node.path)

function onRowClick(event: MouseEvent): void {
  // 修饰键选择只改选区，不触发打开/折叠——Ctrl 点目录把目录展开会直接
  // 违背「多选不产生副作用」的预期
  if (event.shiftKey) {
    emit('select', 'range', props.node.path)
    return
  }
  if (event.ctrlKey || event.metaKey) {
    emit('select', 'toggle', props.node.path)
    return
  }
  if (isDir.value) {
    // 有落地页：点目录名 = 进入它的正文，**不折叠**。
    // 折叠与进入绑在一起会出现「刚打开的目录自己收起来，子页全部消失」，
    // 用户想点下一层还得再展开一次。折叠只由箭头负责。
    if (canEnter.value) {
      emit('open', props.node.landing as string)
      if (!isOpen.value) emit('toggle', props.node.path)
    } else {
      emit('toggle', props.node.path)
    }
  } else {
    emit('open', props.node.path)
  }
  emit('select', 'single', props.node.path)
}

/* ---------- 拖拽 ---------- */

function isTreeDrag(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes(TREE_DND_TYPE) ?? false
}

function onDragStart(event: DragEvent): void {
  emit('dragStart', event, props.node.path)
}

function onDragOver(event: DragEvent): void {
  // 只对树内拖拽表态：外部文件拖入树区域不拦截（冒泡给 shell 打开文件）
  if (!isTreeDrag(event)) return
  event.preventDefault()
  event.dataTransfer!.dropEffect = 'move'
  emit('dragOverRow', event, props.node.path)
}

function onDragLeave(event: DragEvent): void {
  // 进入行内子元素（图标/文字）也会触发 leave，不是真的离开
  if (rowEl.value?.contains(event.relatedTarget as Node)) return
  emit('dragLeaveRow', event)
}

function onDrop(event: DragEvent): void {
  if (!isTreeDrag(event)) return
  event.preventDefault()
  // 树内移动到此为止，不许再冒泡给 shell 的外部文件拖放
  event.stopPropagation()
  emit('dropRow', event, props.node.path)
}
</script>

<template>
  <div
    :id="`tree-node-${node.path}`"
    ref="rowEl"
    class="row"
    role="treeitem"
    :data-tree-path="node.path"
    :aria-expanded="isDir ? isOpen : undefined"
    :aria-selected="isSelected || isChecked"
    :aria-level="depth + 1"
    :tabindex="focusedPath === node.path ? 0 : -1"
    :class="{
      'is-selected': isSelected,
      'is-checked': isChecked,
      'is-group': isDir && !canEnter,
      'is-drop-target': isDropTarget,
    }"
    :style="{ '--depth': depth }"
    :draggable="draggable ?? false"
    @click="onRowClick"
    @contextmenu="emit('context', $event, node.path)"
    @dragstart="onDragStart"
    @dragend="emit('dragEnd', $event)"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <span
      v-if="isDir"
      class="chevron"
      :class="{ 'is-open': isOpen }"
      aria-hidden="true"
      @click.stop="emit('toggle', node.path)"
    >
      <ChevronRight :size="12" :stroke-width="2" />
    </span>
    <span v-else class="chevron chevron--empty" aria-hidden="true" />

    <component
      :is="icon"
      :size="14"
      :stroke-width="1.6"
      class="icon"
      :class="iconClass"
      aria-hidden="true"
    />
    <span class="label">{{ node.name }}</span>
  </div>

  <template v-if="isDir && isOpen && node.children">
    <TreeItem
      v-for="child in node.children"
      :key="child.path"
      :node="child"
      :depth="depth + 1"
      :expanded="expanded"
      :selected-path="selectedPath"
      :checked="checked"
      :focused-path="focusedPath"
      :drop-target="dropTarget"
      :draggable="draggable"
      @open="emit('open', $event)"
      @toggle="emit('toggle', $event)"
      @context="(event, path) => emit('context', event, path)"
      @select="(mode, path) => emit('select', mode, path)"
      @drag-start="(event, path) => emit('dragStart', event, path)"
      @drag-end="emit('dragEnd', $event)"
      @drag-over-row="(event, path) => emit('dragOverRow', event, path)"
      @drag-leave-row="emit('dragLeaveRow', $event)"
      @drop-row="(event, path) => emit('dropRow', event, path)"
    />
  </template>
</template>

<style scoped>
.row {
  display: flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  padding-left: calc(8px + var(--depth, 0) * 14px);
  padding-right: 8px;
  border-radius: var(--dv-ui-radius-sm);
  color: var(--dv-ui-text-2);
  font-size: 12.5px;
  cursor: pointer;
  transition: background var(--dv-ui-dur-1) var(--dv-ui-ease);
}

.row:hover {
  background: var(--dv-ui-surface-2);
}

/* 批量选中是次级高亮：比 hover 沉、比「当前打开的文档」浅 */
.row.is-checked {
  background: var(--dv-ui-surface-2);
  color: var(--dv-ui-text);
}

.row.is-selected {
  background: var(--dv-ui-surface-3);
  color: var(--dv-ui-text);
}

/* 拖拽落点：虚线内框圈住目标目录，与 hover/选中都不同 */
.row.is-drop-target {
  outline: 1.5px dashed var(--dv-ui-focus);
  outline-offset: -2px;
}

/* 键盘焦点与选中是两件事：选中表示「当前打开的文档」，焦点表示「方向键会从这里动」 */
.row:focus-visible {
  outline: 2px solid var(--dv-ui-focus);
  outline-offset: -2px;
}

.row.is-group {
  color: var(--dv-ui-text-muted);
}

.chevron {
  width: 14px;
  flex: none;
  display: grid;
  place-items: center;
  color: var(--dv-ui-text-dim);
  transition: transform var(--dv-ui-dur-1) var(--dv-ui-ease);
}

.chevron.is-open {
  transform: rotate(90deg);
}

.chevron--empty {
  width: 14px;
}

.icon {
  flex: none;
}

/*
 * 三种图标各自一色：文档偏冷（蓝灰）、落地页目录偏暖（琥珀）、分组目录用中性灰。
 * 色相不同但明度接近，扫视时能分组又不会比标题更抢眼。
 */
.icon--doc {
  color: var(--dv-tree-file);
}

.icon--page {
  color: var(--dv-tree-page);
}

.icon--dir {
  color: var(--dv-tree-folder);
}

.label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
