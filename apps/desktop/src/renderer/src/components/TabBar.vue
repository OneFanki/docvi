<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { Blocks, FileText, Folder, House, ListChecks, Settings, X } from 'lucide-vue-next'

import type { TabRecord } from '../stores/tabs'
import { isRealScopeLabel, tabTitleOf } from '../stores/tabs'
import { useI18n } from '../lib/i18n'
import ContextMenu, { type MenuItem } from './ContextMenu.vue'

/**
 * 标签条：左边钉住文档库，右边是可滚动的工作区标签区。
 *
 * 三条设计决定：
 *  1. **文档库不参与滚动**：它必须永远在第一眼可见的位置，不能被标签挤出视野；
 *  2. **固定宽度 + 单行滚动**（可在设置里改）：自适应宽度会让两个标签各占半屏，
 *     标题长的时候反而更难扫读；
 *  3. **标题只写文档名**：标签里再带一段工作区名（或更糟——工作区 id）会挤掉
 *     真正要扫读的文档名，而工作区身份已经显示在标签内的目录树顶部。
 *
 * 右键菜单与命令面板动作同源：菜单项 id 直接对应 App 注册的 tab.* 命令。
 */
const props = defineProps<{
  tabs: TabRecord[]
  activeId: string | null
  /** 固定宽度（px） */
  /** 标签最大宽度：短标题按内容宽，长标题截断 */
  maxWidth: number
  wrap: boolean
  overflowX: 'scroll' | 'shrink'
  /** 当前标签是否有未保存修改 */
  dirty: boolean
}>()

const emit = defineEmits<{
  activate: [id: string]
  close: [id: string]
  /** 菜单项 id（见 App 的 tab.* 命令） */
  command: [id: string, tabId: string]
  /** 打开 Ctrl+Tab 浮层 */
  switcher: []
  /** 拖动排序：把 fromId 拖到 toId 之前；toId = null 表示拖到末尾 */
  reorder: [fromId: string, toId: string | null]
}>()

const { t } = useI18n()

const library = computed(() => props.tabs.find(tab => tab.kind === 'library') ?? null)
const workspaceTabs = computed(() => props.tabs.filter(tab => tab.kind !== 'library'))
const scroller = ref<HTMLElement | null>(null)

const menu = ref<{ open: boolean; x: number; y: number; tabId: string }>({
  open: false,
  x: 0,
  y: 0,
  tabId: '',
})

const tabLabels = computed(() => ({
  library: t('app.library'),
  settings: t('app.settings'),
  plugins: t('app.plugins'),
}))

function titleOf(tab: TabRecord): { scope: string; doc: string | null; label: string } {
  return tabTitleOf(tab, tabLabels.value)
}

/** 悬浮提示：工作区名可信时才带上（不能把哈希当名字显示） */
function tooltipOf(tab: TabRecord): string {
  const { scope, label } = titleOf(tab)
  return isRealScopeLabel(scope) && scope !== label ? `${scope} / ${label}` : label
}

/** 中键关闭：桌面应用通用约定（文档库不可关） */
function onAuxClick(event: MouseEvent, tab: TabRecord): void {
  if (event.button === 1 && tab.kind !== 'library') {
    event.preventDefault()
    emit('close', tab.id)
  }
}

function openMenu(event: MouseEvent, tab: TabRecord): void {
  event.preventDefault()
  menu.value = { open: true, x: event.clientX, y: event.clientY, tabId: tab.id }
}

const menuItems = computed<MenuItem[]>(() => {
  const tab = props.tabs.find(item => item.id === menu.value.tabId)
  const isLibrary = tab?.kind === 'library'
  const hasDoc = Boolean(tab?.history.length)
  return [
    { id: 'tab.close', label: t('tabmenu.close'), disabled: isLibrary, hint: 'Ctrl+W' },
    { id: 'tab.closeOthers', label: t('tabmenu.closeOthers'), disabled: isLibrary },
    { id: 'tab.closeRight', label: t('tabmenu.closeRight'), disabled: isLibrary },
    {
      id: 'tab.closeAll',
      label: t('tabmenu.closeAll'),
      // 只剩文档库时不必给这个入口：点了什么都不会发生
      disabled: props.tabs.every(item => item.kind === 'library'),
    },
    {
      id: 'tab.copy',
      label: t('tabmenu.copy'),
      disabled: !hasDoc,
      separatorBefore: true,
    },
    { id: 'tab.copyPath', label: t('tabmenu.copyPath'), disabled: !hasDoc },
    { id: 'tab.settings', label: t('tabmenu.settings'), separatorBefore: true },
  ]
})

/* ---------- 拖动排序 ---------- */

/**
 * 用 HTML5 drag 而不是 pointer 事件：标签条是横向滚动容器，自己实现拖动要处理
 * 自动滚动、指针捕获与点击抑制三件事；原生 drag 已经把它们都做了，并且能拿到
 * 跨元素的 dragover 语义。
 *
 * 拖动源必须排除文档库（钉住的首页不该被挪走），`dropEffect = 'move'` 让光标
 * 在平台上是「移动」而不是「复制」。
 */
const draggingId = ref<string | null>(null)
/** 当前落点（高亮插入位置） */
const dropTarget = ref<{ id: string; after: boolean } | null>(null)

function onDragStart(event: DragEvent, tab: TabRecord): void {
  if (tab.kind === 'library') {
    event.preventDefault()
    return
  }
  draggingId.value = tab.id
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    // 某些平台不带数据就不触发 drop，必须 setData
    event.dataTransfer.setData('text/plain', tab.id)
  }
}

function onDragOver(event: DragEvent, tab: TabRecord): void {
  if (!draggingId.value || tab.kind === 'library') return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  // 以中点为界：左半 = 插到它前面，右半 = 插到它后面
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  dropTarget.value = { id: tab.id, after: event.clientX > rect.left + rect.width / 2 }
}

function onDrop(event: DragEvent): void {
  event.preventDefault()
  const from = draggingId.value
  const target = dropTarget.value
  resetDrag()
  if (!from || !target || from === target.id) return
  const order = props.tabs.filter(tab => tab.kind !== 'library').map(tab => tab.id)
  const fromIndex = order.indexOf(from)
  if (fromIndex < 0) return
  // 先摘掉自己，再按落点计算插入位置
  const without = order.filter(id => id !== from)
  let insertAt = without.indexOf(target.id)
  if (insertAt < 0) insertAt = without.length
  else if (target.after) insertAt += 1
  if (insertAt === fromIndex) return
  emit('reorder', from, without[insertAt] ?? null)
}

function resetDrag(): void {
  draggingId.value = null
  dropTarget.value = null
}

function dropClass(tab: TabRecord): Record<string, boolean> {
  const target = dropTarget.value
  return {
    'is-dragging': draggingId.value === tab.id,
    'is-drop-before': target?.id === tab.id && !target.after,
    'is-drop-after': target?.id === tab.id && target.after,
  }
}

function onMenuSelect(id: string): void {
  emit('command', id, menu.value.tabId)
}

/**
 * 键盘语义按 ARIA tablist：roving tabindex + ←/→ 移动。
 * 焦点跟随新激活项，否则下一次按键会从旧位置重新计算（看起来像卡住）。
 */
async function onArrow(event: KeyboardEvent, delta: number | 'first' | 'last'): Promise<void> {
  if (!props.tabs.length) return
  event.preventDefault()
  const index = props.tabs.findIndex(tab => tab.id === props.activeId)
  let next: number
  if (delta === 'first') next = 0
  else if (delta === 'last') next = props.tabs.length - 1
  else next = ((index < 0 ? 0 : index) + delta + props.tabs.length) % props.tabs.length
  const target = props.tabs[next]
  if (!target) return
  emit('activate', target.id)
  await nextTick()
  document.querySelector<HTMLElement>(`[data-tab-id="${target.id}"]`)?.focus()
}

/** 激活时把标签滚进视野（Ctrl+Tab 切到远处的标签不会「消失」） */
async function revealTab(id: string): Promise<void> {
  await nextTick()
  document
    .querySelector<HTMLElement>(`[data-tab-id="${id}"]`)
    ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}
defineExpose({ revealTab })
</script>

<template>
  <div class="tabbar" :class="{ 'is-wrap': wrap }" role="tablist" aria-label="标签页">
    <!-- 钉住区：文档库不随标签滚动 -->
    <div class="tabbar__pinned">
      <div
        v-if="library"
        :data-tab-id="library.id"
        class="tab tab--library"
        :class="{ 'is-active': activeId === library.id }"
        role="tab"
        :aria-selected="activeId === library.id"
        :tabindex="activeId === library.id ? 0 : -1"
        @click="emit('activate', library.id)"
        @keydown.enter.prevent="emit('activate', library.id)"
        @keydown.space.prevent="emit('activate', library.id)"
      >
        <House :size="13" :stroke-width="1.7" class="tab__icon" aria-hidden="true" />
        <span class="tab__title">{{ titleOf(library).scope }}</span>
      </div>
    </div>

    <div
      ref="scroller"
      class="tabbar__scroll"
      :class="{ 'is-shrink': overflowX === 'shrink' && !wrap }"
    >
      <div
        v-for="tab in workspaceTabs"
        :key="tab.id"
        v-tooltip="{ text: tooltipOf(tab), placement: 'bottom' }"
        class="tab"
        :class="[
          { 'is-active': tab.id === activeId, 'is-file': tab.kind === 'file' },
          dropClass(tab),
        ]"
        :style="{ maxWidth: `${maxWidth}px` }"
        :data-tab-id="tab.id"
        role="tab"
        :aria-selected="tab.id === activeId"
        :tabindex="tab.id === activeId ? 0 : -1"
        :draggable="true"
        @dragstart="onDragStart($event, tab)"
        @dragover="onDragOver($event, tab)"
        @drop="onDrop"
        @dragend="resetDrag"
        @click="emit('activate', tab.id)"
        @keydown.enter.prevent="emit('activate', tab.id)"
        @keydown.space.prevent="emit('activate', tab.id)"
        @keydown.left.prevent="onArrow($event, -1)"
        @keydown.right.prevent="onArrow($event, 1)"
        @keydown.home.prevent="onArrow($event, 'first')"
        @keydown.end.prevent="onArrow($event, 'last')"
        @keydown.delete.prevent="emit('close', tab.id)"
        @auxclick="onAuxClick($event, tab)"
        @contextmenu="openMenu($event, tab)"
      >
        <Settings
          v-if="tab.kind === 'settings'"
          :size="13"
          :stroke-width="1.7"
          class="tab__icon"
          aria-hidden="true"
        />
        <Blocks
          v-else-if="tab.kind === 'plugins'"
          :size="13"
          :stroke-width="1.7"
          class="tab__icon"
          aria-hidden="true"
        />
        <Folder
          v-else-if="tab.kind === 'workspace'"
          :size="13"
          :stroke-width="1.7"
          class="tab__icon"
          aria-hidden="true"
        />
        <FileText v-else :size="13" :stroke-width="1.7" class="tab__icon" aria-hidden="true" />
        <span class="tab__labels">
          <span class="tab__doc">{{ titleOf(tab).doc ?? titleOf(tab).scope }}</span>
        </span>
        <span v-if="tab.id === activeId && dirty" class="tab__dirty" aria-label="未保存" />
        <button
          class="tab__close"
          type="button"
          :aria-label="t('tabbar.close', { title: titleOf(tab).label })"
          :tabindex="tab.id === activeId ? 0 : -1"
          @click.stop="emit('close', tab.id)"
        >
          <X :size="12" :stroke-width="2" />
        </button>
      </div>
    </div>

    <button
      v-tooltip="{ text: `${t('switcher.title')} (Ctrl+Tab)`, placement: 'bottom' }"
      class="tabbar__switcher"
      type="button"
      :aria-label="t('switcher.title')"
      @click="emit('switcher')"
    >
      <ListChecks :size="14" :stroke-width="1.7" />
    </button>

    <ContextMenu
      :open="menu.open"
      :x="menu.x"
      :y="menu.y"
      :items="menuItems"
      @close="menu.open = false"
      @select="onMenuSelect"
    />
  </div>
</template>

<style scoped>
.tabbar {
  height: var(--dv-ui-tabbar-h);
  flex: none;
  display: flex;
  align-items: stretch;
  background: var(--dv-ui-bg);
  border-bottom: 1px solid var(--dv-ui-line-soft);
}

.tabbar.is-wrap {
  height: auto;
  flex-wrap: wrap;
}

.tabbar__pinned {
  flex: none;
  display: flex;
  align-items: stretch;
  padding-left: 8px;
  position: relative;
  /* 右侧发丝线：视觉上把「固定首页」和「可滚动工作区」分开 */
  box-shadow: 1px 0 0 var(--dv-ui-line-soft);
  z-index: 1;
}

.tabbar__scroll {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: stretch;
  gap: 2px;
  padding: 0 4px;
  overflow-x: auto;
  overflow-y: hidden;
}

.tabbar.is-wrap .tabbar__scroll {
  flex-wrap: wrap;
  overflow-x: hidden;
}

.tabbar__scroll.is-shrink .tab {
  flex: 1 1 0;
  min-width: 88px;
}

.tabbar__switcher {
  flex: none;
  width: 34px;
  display: grid;
  place-items: center;
  border: none;
  border-left: 1px solid var(--dv-ui-line-soft);
  background: transparent;
  color: var(--dv-ui-text-muted);
  cursor: pointer;
}

.tabbar__switcher:hover {
  background: var(--dv-ui-surface-2);
  color: var(--dv-ui-text);
}

/*
 * 标签宽度：内容自适应 + 上限封顶。
 *
 * flex: 0 1 auto 而不是固定 width——短标题（「设置」「插件」）只占自己需要的宽度，
 * 一排能多放几个；长标题到 maxWidth 就截断，不会把整条挤爆。
 */
.tab {
  flex: 0 1 auto;
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 0 4px 0 10px;
  border-bottom: 2px solid transparent;
  color: var(--dv-ui-text-muted);
  font-size: 12px;
  cursor: pointer;
  user-select: none;
  transition:
    color var(--dv-ui-dur-1) var(--dv-ui-ease),
    border-color var(--dv-ui-dur-1) var(--dv-ui-ease);
}

.tab:hover {
  color: var(--dv-ui-text-2);
  background: color-mix(in srgb, var(--dv-ui-surface-2) 60%, transparent);
}

.tab.is-active {
  color: var(--dv-ui-text);
  border-bottom-color: var(--dv-ui-accent);
}

/* 拖动排序：拖动源半透明，落点用一侧竖线标出插入位置 */
.tab.is-dragging {
  opacity: 0.45;
}

.tab.is-drop-before {
  box-shadow: inset 2px 0 0 var(--dv-ui-accent);
}

.tab.is-drop-after {
  box-shadow: inset -2px 0 0 var(--dv-ui-accent);
}

.tab--library {
  padding-right: 10px;
}

.tab__icon {
  flex: none;
  opacity: 0.8;
}

/* 单段标题：只有文档名，单行省略（工作区名交给标签内的树顶部） */
.tab__labels {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: baseline;
  overflow: hidden;
}

.tab__doc {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tab__title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tab__dirty {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--dv-ui-accent);
}

.tab__close {
  flex: none;
  width: 18px;
  height: 18px;
  display: grid;
  place-items: center;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--dv-ui-text-dim);
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--dv-ui-dur-1) var(--dv-ui-ease);
}

.tab:hover .tab__close,
.tab.is-active .tab__close,
.tab__close:focus-visible {
  opacity: 1;
}

.tab__close:hover {
  background: var(--dv-ui-surface-3);
  color: var(--dv-ui-text);
}
</style>
