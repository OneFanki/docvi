<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { FolderOpen } from 'lucide-vue-next'

import type { TreeNode } from '@docvi/shared'
import { useI18n } from '../lib/i18n'
import { isTreeDrag, parentDirOf, rangeSelection, TREE_DND_TYPE } from '../lib/tree-selection'
import TreeItem from './TreeItem.vue'
import ContextMenu, { type MenuItem } from './ContextMenu.vue'

/**
 * 文档树容器：展开状态由**所属标签**持有并下传。
 *
 * 为什么展开状态不能留在这里：同一个工作区可以开两个标签，一个停在「指南」、
 * 另一个停在「参考」——展开状态属于「这个标签的浏览现场」，不属于工作区。
 *
 * 键盘导航按 ARIA tree 规范：整棵树只有一个 tabindex=0 的当前项（roving），
 * ↑↓ 在可见行之间移动、→ 展开/进入子项、← 折叠/回到父项、Enter 打开。
 *
 * 批量选中（checkedPaths）由 App 持有，选区算术（Shift 范围）在这里做——
 * 可见行序列只有这层知道。落点目录判定也在这层：文件行的落点是它的父目录。
 */
const props = defineProps<{
  nodes: TreeNode[]
  selectedPath: string | null
  /** 所属标签的展开集合 */
  expanded: string[]
  /** 批量选中的路径集合（App 持有；只读宿主恒为空） */
  checkedPaths?: string[]
  /** 键盘焦点所在节点（path） */
  focusedPath?: string | null
  /** 归属工作区名（显示在树顶部；空则不显示头部） */
  scopeLabel?: string
  /** 是否有可粘贴的条目（剪贴板内容由 App 持有；这里只决定菜单项是否可用） */
  canPaste?: boolean
  /**
   * 只读宿主（容器版）：右键菜单只留「在新标签页打开」「复制路径」，不可拖拽、
   * 不进多选。新建 / 重命名 / 剪切 / 粘贴 / 删除全部依赖本地磁盘写权限，容器里
   * 点了只会拿到 E_FORBIDDEN——菜单里不留这些必然失败的项。
   */
  readonly?: boolean
  /** 递增触发「滚动到当前文档行」（祖先展开由 App 先做完，这里只管滚） */
  revealSignal?: number
}>()

const emit = defineEmits<{
  open: [path: string]
  /** 右键「在新标签页打开」 */
  openNewTab: [path: string]
  updateExpanded: [expanded: string[]]
  /** 批量选中变化（完整替换；Shift 范围已在这里算完） */
  select: [paths: string[]]
  /** 拖拽落定：请 App 确认后移动到 targetDir（根目录用空串表示） */
  moveRequests: [paths: string[], targetDir: string]
  /**
   * 文件操作。`paths` 是被操作条目（选区批量时多项）；`dir` 是右键目标目录
   * （工作区根用空串表示），新建动作也走这里。
   */
  fsAction: [action: TreeFsAction, paths: string[], dir: string]
}>()

/** 右键菜单里的文件操作；与 App 的 tree.* 命令一一对应 */
export type TreeFsAction = 'newFile' | 'newDir' | 'rename' | 'cut' | 'copy' | 'paste' | 'trash'

const { t } = useI18n()

const treeEl = ref<HTMLElement | null>(null)
const expandedSet = computed(() => new Set(props.expanded))
const checkedSet = computed(() => new Set(props.checkedPaths ?? []))
const focused = ref<string | null>(props.focusedPath ?? null)

/** 选中项变化（命令面板打开文档）→ 焦点跟随，方向键从当前位置继续 + 滚进视野 */
watch(
  () => props.selectedPath,
  async path => {
    if (!path) return
    focused.value = path
    /*
     * 选区跟着当前文档走。从搜索 / 命令面板 / 右键新标签打开文档时，树的
     * 高亮变了，但没经过任何树内点击——选区还停在上次点过的节点上。
     * 之后「展开所选」就会铺开一个与当前文档无关的目录（2026-10-28 实测：
     * 收起全部 → 定位 → 展开所选，展开的是别的文件夹）。这里重置为当前
     * 文档行，让「展开所选」与「定位」语义连贯：都是围绕当前文档。
     */
    if (!props.readonly) emit('select', [path])
    /*
     * 从搜索 / 最近打开进来时，目标行可能在折叠目录里或者滚出视野。
     * 祖先展开由 App 负责（它才知道标签的 expanded），这里等一帧让 DOM 落定
     * 再把行滚进视野——`block: 'nearest'` 保证已经在视野内时不乱跳。
     */
    await nextTick()
    scrollPathIntoView(path)
  },
)

/** 「定位当前文档」按钮：路径没变（watch 不触发）也要滚一次，用递增信号驱动 */
watch(
  () => props.revealSignal,
  async () => {
    if (!props.selectedPath) return
    await nextTick()
    scrollPathIntoView(props.selectedPath)
  },
)

function scrollPathIntoView(path: string): void {
  document
    .querySelector<HTMLElement>(`[data-tree-path="${cssEscape(path)}"]`)
    ?.scrollIntoView({ block: 'nearest' })
}

function toggle(path: string): void {
  const next = new Set(expandedSet.value)
  if (next.has(path)) next.delete(path)
  else next.add(path)
  emit('updateExpanded', [...next])
}

/** 可见行（深度优先；折叠的子树不出现） */
const visible = computed<Array<{ node: TreeNode; depth: number; parent: string | null }>>(() => {
  const out: Array<{ node: TreeNode; depth: number; parent: string | null }> = []
  const walk = (list: TreeNode[], depth: number, parent: string | null): void => {
    for (const node of list) {
      out.push({ node, depth, parent })
      if (node.type === 'dir' && expandedSet.value.has(node.path) && node.children?.length) {
        walk(node.children, depth + 1, node.path)
      }
    }
  }
  walk(props.nodes, 0, null)
  return out
})

const activePath = computed(() => {
  const candidate = focused.value ?? props.selectedPath
  if (candidate && visible.value.some(row => row.node.path === candidate)) return candidate
  return visible.value[0]?.node.path ?? null
})

function indexOfActive(): number {
  const path = activePath.value
  return path ? visible.value.findIndex(row => row.node.path === path) : -1
}

async function moveTo(index: number): Promise<void> {
  const row = visible.value[Math.max(0, Math.min(index, visible.value.length - 1))]
  if (!row || row.node.path === activePath.value) return
  focused.value = row.node.path
  await nextTick()
  document.querySelector<HTMLElement>(`[data-tree-path="${cssEscape(row.node.path)}"]`)?.focus()
}

function cssEscape(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

/* ---------- 批量选中 ---------- */

/** Shift 范围的锚点：最近一次单击/Ctrl 单击所在行 */
const anchor = ref<string | null>(null)

function onSelect(mode: 'single' | 'toggle' | 'range', path: string): void {
  if (props.readonly) return
  const visiblePaths = visible.value.map(row => row.node.path)
  if (mode === 'range') {
    emit('select', rangeSelection(visiblePaths, anchor.value, path))
    anchor.value = path
    return
  }
  if (mode === 'toggle') {
    const next = new Set(checkedSet.value)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    emit('select', [...next])
    anchor.value = path
    return
  }
  // single：单击伴随默认行为（打开/折叠），选区重置为该行
  emit('select', [path])
  anchor.value = path
}

/* ---------- 键盘 ---------- */

function onKeydown(event: KeyboardEvent): void {
  const index = indexOfActive()
  const row = visible.value[index]
  if (!row) return
  const isDir = row.node.type === 'dir'
  const open = isDir && expandedSet.value.has(row.node.path)

  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a' && !props.readonly) {
    event.preventDefault()
    emit(
      'select',
      visible.value.map(item => item.node.path),
    )
    return
  }
  if (event.key === 'Delete' && !props.readonly) {
    const paths = props.checkedPaths ?? []
    if (!paths.length) return
    event.preventDefault()
    emit('fsAction', 'trash', [...paths], '')
    return
  }
  if (event.key === 'F2' && !props.readonly) {
    const paths = props.checkedPaths ?? []
    if (paths.length !== 1) return
    event.preventDefault()
    emit('fsAction', 'rename', paths, '')
    return
  }
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    void moveTo(index + 1)
    return
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault()
    void moveTo(index - 1)
    return
  }
  if (event.key === 'Home') {
    event.preventDefault()
    void moveTo(0)
    return
  }
  if (event.key === 'End') {
    event.preventDefault()
    void moveTo(visible.value.length - 1)
    return
  }
  if (event.key === 'ArrowRight') {
    event.preventDefault()
    if (isDir && !open) {
      toggle(row.node.path)
      return
    }
    if (isDir && row.node.children?.length) void moveTo(index + 1)
    return
  }
  if (event.key === 'ArrowLeft') {
    event.preventDefault()
    if (isDir && open) {
      toggle(row.node.path)
      return
    }
    const parentIndex = row.parent
      ? visible.value.findIndex(item => item.node.path === row.parent)
      : -1
    if (parentIndex >= 0) void moveTo(parentIndex)
    return
  }
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    if (isDir) {
      if (row.node.landing) {
        emit('open', row.node.landing)
        if (!open) toggle(row.node.path)
      } else toggle(row.node.path)
      return
    }
    emit('open', row.node.path)
  }
}

function onFocusIn(event: FocusEvent): void {
  const target = event.target as HTMLElement | null
  const path = target?.dataset.treePath
  if (path) focused.value = path
}

/* ---------- 拖拽移动 ---------- */

const dropTarget = ref<string | null>(null)

/** 落点目录：目录行=其下，文件行=它所在目录（拖到文件上也能放进它的旁边） */
function targetDirOf(path: string): string {
  const node = visible.value.find(row => row.node.path === path)?.node
  if (!node) return ''
  return node.type === 'dir' ? node.path : parentDirOf(node.path)
}

function onDragStart(event: DragEvent, path: string): void {
  if (props.readonly) return
  // 拖动行在选区内 → 整组一起拖；不在 → 拖动同时把选区重置为该行
  const paths = (props.checkedPaths ?? []).includes(path)
    ? [...(props.checkedPaths as string[])]
    : [path]
  // 某些平台不带数据就不触发 drop，必须 setData
  event.dataTransfer?.setData(TREE_DND_TYPE, JSON.stringify(paths))
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
  if (paths.length > 1 || paths[0] !== path) emit('select', paths)
}

function onDragOverRow(_event: DragEvent, path: string): void {
  const dir = targetDirOf(path)
  if (dropTarget.value !== dir) dropTarget.value = dir
}

/** 树容器空白处的 dragover：落点=工作区根（''）。行内的已在行上处理并 stopPropagation */
function onTreeDragOver(event: DragEvent): void {
  if (!isTreeDrag(event)) return
  if ((event.target as HTMLElement).closest('.row')) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  if (dropTarget.value !== '') dropTarget.value = ''
}

function onTreeDragLeave(event: DragEvent): void {
  if (treeEl.value?.contains(event.relatedTarget as Node)) return
  dropTarget.value = null
}

function onTreeDrop(event: DragEvent): void {
  if (!isTreeDrag(event)) return
  if ((event.target as HTMLElement).closest('.row')) return
  event.preventDefault()
  dropTarget.value = null
  requestMove(readDragPaths(event), '')
}

function onDropRow(event: DragEvent, path: string): void {
  dropTarget.value = null
  requestMove(readDragPaths(event), targetDirOf(path))
}

function readDragPaths(event: DragEvent): string[] {
  try {
    const raw = event.dataTransfer?.getData(TREE_DND_TYPE)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : []
  } catch {
    return []
  }
}

function requestMove(paths: string[], targetDir: string): void {
  if (paths.length) emit('moveRequests', paths, targetDir)
}

function onDragEnd(): void {
  dropTarget.value = null
}

/* ---------- 右键菜单 ---------- */

const menu = ref<{
  open: boolean
  x: number
  y: number
  path: string
  /** 该条目是目录（决定「新建到它里面」还是「它所在的目录」） */
  isDir: boolean
  /** 菜单要作用的路径集合：右键选区内行=整个选区；否则单选该行 */
  paths: string[]
}>({ open: false, x: 0, y: 0, path: '', isDir: false, paths: [] })

function onContextMenu(event: MouseEvent, path: string): void {
  event.preventDefault()
  if (!path) return
  const row = visible.value.find(item => item.node.path === path)
  const checked = props.checkedPaths ?? []
  // 右键选区外的行：选区先重置为该行（WebStorm 惯例，操作只命中看到的那行）
  if (!checked.includes(path)) emit('select', [path])
  menu.value = {
    open: true,
    x: event.clientX,
    y: event.clientY,
    path,
    isDir: row?.node.type === 'dir',
    paths: checked.includes(path) ? [...checked] : [path],
  }
}

/** 新建目标是「右键节点自己」（目录）还是「它所在的目录」 */
function newDirTarget(): string {
  if (menu.value.isDir) return menu.value.path
  return parentDirOf(menu.value.path)
}

const menuItems = computed<MenuItem[]>(() => {
  const isDir = menu.value.isDir
  const single = menu.value.paths.length === 1
  const openItem = single && !isDir ? [{ id: 'tree.openNewTab', label: t('tree.openNewTab') }] : []
  const copyPath = { id: 'tree.copyPath', label: t('tree.copyPath'), separatorBefore: true }
  if (props.readonly) return [...openItem, copyPath]
  return [
    ...openItem,
    { id: 'tree.newFile', label: t('tree.newFile'), separatorBefore: !isDir },
    { id: 'tree.newDir', label: t('tree.newDir') },
    { id: 'tree.rename', label: t('tree.rename'), separatorBefore: true, hint: 'F2' },
    { id: 'tree.cut', label: t('tree.cut'), hint: 'Ctrl+X' },
    { id: 'tree.copy', label: t('tree.copy'), hint: 'Ctrl+C' },
    {
      id: 'tree.paste',
      label: t('tree.paste'),
      hint: 'Ctrl+V',
      disabled: !props.canPaste,
    },
    { id: 'tree.copyPath', label: t('tree.copyPath'), separatorBefore: true },
    {
      id: 'tree.trash',
      label: single ? t('tree.trash') : t('tree.trashMany', { count: menu.value.paths.length }),
      danger: true,
      separatorBefore: true,
      hint: 'Del',
    },
  ]
})

function onMenuSelect(id: string): void {
  const paths = menu.value.paths
  const target = newDirTarget()
  if (id === 'tree.openNewTab') emit('openNewTab', paths[0] ?? menu.value.path)
  else if (id === 'tree.copyPath') void navigator.clipboard.writeText(paths.join('\n'))
  else if (id === 'tree.newFile') emit('fsAction', 'newFile', paths, target)
  else if (id === 'tree.newDir') emit('fsAction', 'newDir', paths, target)
  else if (id === 'tree.rename') emit('fsAction', 'rename', paths, target)
  else if (id === 'tree.cut') emit('fsAction', 'cut', paths, target)
  else if (id === 'tree.copy') emit('fsAction', 'copy', paths, target)
  else if (id === 'tree.paste') emit('fsAction', 'paste', paths, target)
  else if (id === 'tree.trash') emit('fsAction', 'trash', paths, target)
}
</script>

<template>
  <!--
    工作区标识放在树顶部，而不是窗口标题栏：标题栏在标签之上，放那里会被读成
    「全局状态」；工作区是标签内的上下文，这一条属于本标签的浏览现场。
    右侧工具区留给宿主放定位/展开/收起按钮（slot），与工作区名同行。
  -->
  <div v-if="scopeLabel || $slots.tools" class="tree__header">
    <div v-if="scopeLabel" v-tooltip="scopeLabel" class="tree__scope">
      <FolderOpen :size="13" :stroke-width="1.7" aria-hidden="true" />
      <span class="tree__scope-name">{{ scopeLabel }}</span>
    </div>
    <div v-if="$slots.tools" class="tree__tools">
      <slot name="tools" />
    </div>
  </div>

  <div
    ref="treeEl"
    class="tree"
    :class="{ 'is-drop-root': dropTarget === '' }"
    role="tree"
    :aria-label="scopeLabel || t('app.library')"
    :aria-activedescendant="activePath ? `tree-node-${activePath}` : undefined"
    @keydown="onKeydown"
    @focusin="onFocusIn"
    @dragover="onTreeDragOver"
    @dragleave="onTreeDragLeave"
    @drop="onTreeDrop"
  >
    <TreeItem
      v-for="node in nodes"
      :key="node.path"
      :node="node"
      :depth="0"
      :expanded="expandedSet"
      :selected-path="selectedPath"
      :checked="checkedSet"
      :focused-path="activePath"
      :drop-target="dropTarget"
      :draggable="!readonly"
      @open="emit('open', $event)"
      @toggle="toggle"
      @context="onContextMenu"
      @select="onSelect"
      @drag-start="onDragStart"
      @drag-end="onDragEnd"
      @drag-over-row="onDragOverRow"
      @drop-row="onDropRow"
    />
  </div>

  <ContextMenu
    :open="menu.open"
    :x="menu.x"
    :y="menu.y"
    :items="menuItems"
    @close="menu.open = false"
    @select="onMenuSelect"
  />
</template>

<style scoped>
.tree__header {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 8px 8px 6px 12px;
  min-width: 0;
}

.tree__scope {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--dv-ui-text-2);
  user-select: none;
}

.tree__scope svg {
  flex: none;
  color: var(--dv-ui-text-dim);
}

.tree__scope-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tree__tools {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: none;
}

.tree {
  padding: 2px 6px 12px;
  user-select: none;
}

/* 空白区也是落点（移到工作区根）；行内落点由 TreeItem 自己描虚线框 */
.tree.is-drop-root {
  outline: 1.5px dashed var(--dv-ui-focus);
  outline-offset: -2px;
  border-radius: var(--dv-ui-radius-sm);
}
</style>
