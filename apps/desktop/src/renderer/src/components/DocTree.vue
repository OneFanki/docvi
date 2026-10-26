<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { FolderOpen } from 'lucide-vue-next'

import type { TreeNode } from '@docvi/shared'
import { useI18n } from '../lib/i18n'
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
 */
const props = defineProps<{
  nodes: TreeNode[]
  selectedPath: string | null
  /** 所属标签的展开集合 */
  expanded: string[]
  /** 键盘焦点所在节点（path） */
  focusedPath?: string | null
  /** 归属工作区名（显示在树顶部；空则不显示头部） */
  scopeLabel?: string
  /** 是否有可粘贴的条目（剪贴板内容由 App 持有；这里只决定菜单项是否可用） */
  canPaste?: boolean
  /**
   * 只读宿主（容器版）：右键菜单只留「在新标签页打开」「复制路径」。
   *
   * 新建 / 重命名 / 剪切 / 粘贴 / 删除全部依赖本地磁盘写权限，容器里点了
   * 只会拿到 E_FORBIDDEN——菜单里不留这些必然失败的项。
   */
  readonly?: boolean
}>()

const emit = defineEmits<{
  open: [path: string]
  /** 右键「在新标签页打开」 */
  openNewTab: [path: string]
  updateExpanded: [expanded: string[]]
  /**
   * 文件操作。`path` 是被操作条目；`dir` 是它的父目录相对路径
   * （工作区根用空串表示），新建动作也走这里。
   */
  fsAction: [action: TreeFsAction, path: string, dir: string]
}>()

/** 右键菜单里的文件操作；与 App 的 tree.* 命令一一对应 */
export type TreeFsAction = 'newFile' | 'newDir' | 'rename' | 'cut' | 'copy' | 'paste' | 'trash'

const { t } = useI18n()

const expandedSet = computed(() => new Set(props.expanded))
const focused = ref<string | null>(props.focusedPath ?? null)

/** 选中项变化（命令面板打开文档）→ 焦点跟随，方向键从当前位置继续 + 滚进视野 */
watch(
  () => props.selectedPath,
  async path => {
    if (!path) return
    focused.value = path
    /*
     * 从搜索 / 最近打开进来时，目标行可能在折叠目录里或者滚出视野。
     * 祖先展开由 App 负责（它才知道标签的 expanded），这里等一帧让 DOM 落定
     * 再把行滚进视野——`block: 'nearest'` 保证已经在视野内时不乱跳。
     */
    await nextTick()
    const selector = `[data-tree-path="${cssEscape(path)}"]`
    document.querySelector<HTMLElement>(selector)?.scrollIntoView({ block: 'nearest' })
  },
)

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

function onKeydown(event: KeyboardEvent): void {
  const index = indexOfActive()
  const row = visible.value[index]
  if (!row) return
  const isDir = row.node.type === 'dir'
  const open = isDir && expandedSet.value.has(row.node.path)

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

/* ---------- 右键菜单 ---------- */

const menu = ref<{
  open: boolean
  x: number
  y: number
  path: string
  /** 该条目是目录（决定「新建到它里面」还是「它所在的目录」） */
  isDir: boolean
}>({ open: false, x: 0, y: 0, path: '', isDir: false })

function onContextMenu(event: MouseEvent, path: string): void {
  event.preventDefault()
  if (!path) return
  const isDir = visible.value.find(row => row.node.path === path)?.node.type === 'dir'
  menu.value = { open: true, x: event.clientX, y: event.clientY, path, isDir }
}

/** 新建目标是「右键节点自己」（目录）还是「它所在的目录」 */
function newDirTarget(): string {
  if (menu.value.isDir) return menu.value.path
  const slash = menu.value.path.lastIndexOf('/')
  return slash < 0 ? '' : menu.value.path.slice(0, slash)
}

const menuItems = computed<MenuItem[]>(() => {
  const isDir = menu.value.isDir
  const openItem = isDir ? [] : [{ id: 'tree.openNewTab', label: t('tree.openNewTab') }]
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
    { id: 'tree.trash', label: t('tree.trash'), danger: true, separatorBefore: true, hint: 'Del' },
  ]
})

function onMenuSelect(id: string): void {
  const target = newDirTarget()
  if (id === 'tree.openNewTab') emit('openNewTab', menu.value.path)
  else if (id === 'tree.copyPath') void navigator.clipboard.writeText(menu.value.path)
  else if (id === 'tree.newFile') emit('fsAction', 'newFile', menu.value.path, target)
  else if (id === 'tree.newDir') emit('fsAction', 'newDir', menu.value.path, target)
  else if (id === 'tree.rename') emit('fsAction', 'rename', menu.value.path, target)
  else if (id === 'tree.cut') emit('fsAction', 'cut', menu.value.path, target)
  else if (id === 'tree.copy') emit('fsAction', 'copy', menu.value.path, target)
  else if (id === 'tree.paste') emit('fsAction', 'paste', menu.value.path, target)
  else if (id === 'tree.trash') emit('fsAction', 'trash', menu.value.path, target)
}
</script>

<template>
  <!--
    工作区标识放在树顶部，而不是窗口标题栏：标题栏在标签之上，放那里会被读成
    「全局状态」；工作区是标签内的上下文，这一条属于本标签的浏览现场。
  -->
  <div v-if="scopeLabel" v-tooltip="scopeLabel" class="tree__scope">
    <FolderOpen :size="13" :stroke-width="1.7" aria-hidden="true" />
    <span class="tree__scope-name">{{ scopeLabel }}</span>
  </div>

  <div
    class="tree"
    role="tree"
    :aria-label="scopeLabel || t('app.library')"
    :aria-activedescendant="activePath ? `tree-node-${activePath}` : undefined"
    @keydown="onKeydown"
    @focusin="onFocusIn"
  >
    <TreeItem
      v-for="node in nodes"
      :key="node.path"
      :node="node"
      :depth="0"
      :expanded="expandedSet"
      :selected-path="selectedPath"
      :focused-path="activePath"
      @open="emit('open', $event)"
      @toggle="toggle"
      @context="onContextMenu"
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
.tree__scope {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px 6px;
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

.tree {
  padding: 2px 6px 12px;
  user-select: none;
}
</style>
