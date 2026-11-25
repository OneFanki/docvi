<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { Blocks, FileText, Folder, ListChecks, Settings, X } from 'lucide-vue-next'

import type { TabRecord } from '../stores/tabs'
import { isRealScopeLabel, tabTitleOf } from '../stores/tabs'
import { useI18n } from '../lib/i18n'
import { MOD_LABEL, TAB_MOD_LABEL } from '../lib/shortcuts'
import ContextMenu, { type MenuItem } from './ContextMenu.vue'

/**
 * 标签条：一条可滚动的标签带，没有任何钉住区。
 *
 * 两条设计决定：
 *  1. **固定宽度 + 单行滚动**（可在设置里改）：自适应宽度会让两个标签各占半屏，
 *     标题长的时候反而更难扫读；
 *  2. **标题只写文档名**：标签里再带一段工作区名（或更糟——工作区 id）会挤掉
 *     真正要扫读的文档名，而工作区身份已经显示在侧栏顶部的切换器上。
 *
 * 右键菜单与命令面板动作同源：菜单项 id 直接对应 App 注册的 tab.* 命令。
 */
const props = defineProps<{
  tabs: TabRecord[]
  activeId: string | null
  /** 标签最大宽度：短标题按内容宽，长标题截断 */
  maxWidth: number
  wrap: boolean
  overflowX: 'scroll' | 'shrink'
  /** 当前标签是否有未保存修改 */
  dirty: boolean
}>()

const emit = defineEmits<{
  activate: [id: string]
  /** 双击预览标签 → 固定它（VSCode 语义） */
  pin: [id: string]
  close: [id: string]
  /** 菜单项 id（见 App 的 tab.* 命令） */
  command: [id: string, tabId: string]
  /** 打开 Ctrl+Tab 浮层 */
  switcher: []
  /** 拖动排序：把 fromId 拖到 toId 之前；toId = null 表示拖到末尾 */
  reorder: [fromId: string, toId: string | null]
}>()

const { t } = useI18n()

const scroller = ref<HTMLElement | null>(null)

const menu = ref<{ open: boolean; x: number; y: number; tabId: string }>({
  open: false,
  x: 0,
  y: 0,
  tabId: '',
})

const tabLabels = computed(() => ({
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

/** 中键关闭：桌面应用通用约定 */
function onAuxClick(event: MouseEvent, tab: TabRecord): void {
  if (event.button === 1) {
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
  const hasDoc = Boolean(tab?.history.length)
  return [
    { id: 'tab.close', label: t('tabmenu.close'), hint: `${MOD_LABEL}+W` },
    { id: 'tab.closeOthers', label: t('tabmenu.closeOthers') },
    { id: 'tab.closeRight', label: t('tabmenu.closeRight') },
    { id: 'tab.closeAll', label: t('tabmenu.closeAll') },
    {
      id: 'tab.copy',
      label: t('tabmenu.copy'),
      disabled: !hasDoc,
      separatorBefore: true,
    },
    { id: 'tab.copyPath', label: t('tabmenu.copyPath'), disabled: !hasDoc },
    { id: 'tab.copyAbsolutePath', label: t('tabmenu.copyAbsolutePath'), disabled: !hasDoc },
    { id: 'tab.revealInFolder', label: t('tabmenu.revealInFolder'), disabled: !hasDoc },
    { id: 'tab.copyFile', label: t('tabmenu.copyFile'), disabled: !hasDoc },
    { id: 'tab.cutFile', label: t('tabmenu.cutFile'), disabled: !hasDoc },
    { id: 'tab.settings', label: t('tabmenu.settings'), separatorBefore: true },
  ]
})

/* ---------- 拖动排序 ---------- */

/**
 * 用 HTML5 drag 而不是 pointer 事件：标签条是横向滚动容器，自己实现拖动要处理
 * 自动滚动、指针捕获与点击抑制三件事；原生 drag 已经把它们都做了，并且能拿到
 * 跨元素的 dragover 语义。
 *
 * `dropEffect = 'move'` 让光标在平台上是「移动」而不是「复制」。
 */
const draggingId = ref<string | null>(null)
/** 当前落点（高亮插入位置） */
const dropTarget = ref<{ id: string; after: boolean } | null>(null)

function onDragStart(event: DragEvent, tab: TabRecord): void {
  draggingId.value = tab.id
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    // 某些平台不带数据就不触发 drop，必须 setData
    event.dataTransfer.setData('text/plain', tab.id)
  }
}

function onDragOver(event: DragEvent, tab: TabRecord): void {
  if (!draggingId.value) return
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
  const order = props.tabs.map(tab => tab.id)
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
    <div
      ref="scroller"
      class="tabbar__scroll"
      :class="{ 'is-shrink': overflowX === 'shrink' && !wrap }"
    >
      <div
        v-for="tab in tabs"
        :key="tab.id"
        v-tooltip="{ text: tooltipOf(tab), placement: 'bottom' }"
        class="tab"
        :class="[
          {
            'is-active': tab.id === activeId,
            'is-file': tab.kind === 'file',
            'is-preview': tab.preview,
          },
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
        @dblclick="tab.preview && emit('pin', tab.id)"
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
      v-tooltip="{ text: `${t('switcher.title')} (${TAB_MOD_LABEL}+Tab)`, placement: 'bottom' }"
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

.tabbar__scroll {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: stretch;
  gap: 2px;
  padding: 0 4px 0 8px;
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

.tab__icon {
  flex: none;
  opacity: 0.8;
}

/* 单段标题：只有文档名，单行省略（工作区名交给侧栏顶部的切换器） */
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

/*
 * 预览标签：标题斜体。
 *
 * 斜体是 VSCode 用户已经形成的语感——「斜体 = 我还没决定留它」。
 * 只改字形不改颜色：颜色在标签上已经承担了「激活 / 脏」两种语义，
 * 再叠一种会让三者都失去可读性。
 */
.tab.is-preview .tab__doc {
  font-style: italic;
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
