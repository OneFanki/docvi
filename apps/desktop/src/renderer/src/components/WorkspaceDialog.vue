<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { Check, FolderOpen, FileText, Share2, Trash2, X } from 'lucide-vue-next'

import type { WorkspaceEntry } from '@docvi/shared'

import { useI18n } from '../lib/i18n'

/**
 * 工作区弹窗（左栏顶部切换器点开）。
 *
 * 为什么居中弹窗而不是下拉框：
 *  - 下拉框贴着按钮，条目多了会被窗口边缘裁掉，还得自己算翻转；
 *  - 这里不止「选一个」，还有分享目录 / 移除 / 打开新目录几个动作，菜单项挤在
 *    一个窄条里读起来费劲；弹窗有标题、有分组、有空间写路径；
 *  - 居中是「一次决策」的语义——选完就关，不像下拉框那样容易被误读成常驻侧栏。
 *
 * 只做选择与派发，不碰 store：切换 / 添加 / 移除都在 App 里（那里才知道标签要不要跟）。
 */
const props = defineProps<{
  open: boolean
  workspaces: WorkspaceEntry[]
  activeId: string | null
}>()

const emit = defineEmits<{
  /** 切到某个工作区（只换左栏的树） */
  switch: [id: string]
  addFolder: []
  openFile: []
  /** 分享当前工作区目录 */
  share: []
  remove: []
  close: []
}>()

const { t } = useI18n()
const panel = ref<HTMLElement | null>(null)

watch(
  () => props.open,
  async open => {
    if (!open) return
    await nextTick()
    // 焦点落到当前工作区那一行：键盘用户开窗后直接回车就是「保持现状并关闭」前的落脚点
    panel.value?.querySelector<HTMLElement>('[data-current="true"]')?.focus()
  },
)

function onKeydown(event: KeyboardEvent): void {
  if (!props.open) return
  if (event.key === 'Escape') {
    event.preventDefault()
    emit('close')
  }
}

function pick(id: string): void {
  // 选当前这个就是「什么都不用做」：直接关窗，不重新加载树
  if (id === props.activeId) {
    emit('close')
    return
  }
  emit('switch', id)
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="overlay" @mousedown.self="emit('close')" @keydown="onKeydown">
      <div ref="panel" class="wsdialog" role="dialog" aria-modal="true" aria-labelledby="ws-title">
        <div class="wsdialog__head">
          <h2 id="ws-title" class="wsdialog__title">{{ t('ws.dialog.title') }}</h2>
          <button
            class="wsdialog__close"
            type="button"
            :aria-label="t('confirm.cancel')"
            @click="emit('close')"
          >
            <X :size="14" :stroke-width="1.8" />
          </button>
        </div>

        <ul class="wsdialog__list">
          <li v-for="item in workspaces" :key="item.id">
            <button
              class="wsrow"
              :class="{ 'is-current': item.id === activeId }"
              :data-current="item.id === activeId"
              type="button"
              @click="pick(item.id)"
            >
              <span class="wsrow__mark" aria-hidden="true">
                <Check v-if="item.id === activeId" :size="13" :stroke-width="2.2" />
              </span>
              <span class="wsrow__body">
                <span class="wsrow__name">{{ item.name }}</span>
                <span class="wsrow__root" :title="item.root">{{ item.root }}</span>
              </span>
            </button>
          </li>
        </ul>

        <div class="wsdialog__actions">
          <button class="wsaction" type="button" @click="emit('addFolder')">
            <FolderOpen :size="13" :stroke-width="1.8" aria-hidden="true" />
            {{ t('cmd.openFolder') }}
          </button>
          <button class="wsaction" type="button" @click="emit('openFile')">
            <FileText :size="13" :stroke-width="1.8" aria-hidden="true" />
            {{ t('cmd.openFile') }}
          </button>
          <button v-if="activeId" class="wsaction" type="button" @click="emit('share')">
            <Share2 :size="13" :stroke-width="1.8" aria-hidden="true" />
            {{ t('ws.shareDir') }}
          </button>
          <button
            v-if="activeId && !workspaces.find(item => item.id === activeId)?.default"
            class="wsaction wsaction--danger"
            type="button"
            @click="emit('remove')"
          >
            <Trash2 :size="13" :stroke-width="1.8" aria-hidden="true" />
            {{ t('ws.remove') }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: grid;
  place-items: center;
  background: rgb(0 0 0 / 42%);
}

.wsdialog {
  width: min(480px, calc(100vw - 64px));
  max-height: min(560px, calc(100vh - 96px));
  display: flex;
  flex-direction: column;
  padding: 16px;
  border: 1px solid var(--dv-ui-line);
  border-radius: var(--dv-ui-radius-md);
  background: var(--dv-ui-surface-2);
  box-shadow: var(--dv-ui-shadow-2);
}

.wsdialog__head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.wsdialog__title {
  flex: 1;
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--dv-ui-text);
}

.wsdialog__close {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: var(--dv-ui-radius-sm);
  background: transparent;
  color: var(--dv-ui-text-muted);
  cursor: pointer;
}

.wsdialog__close:hover {
  background: var(--dv-ui-surface-3);
  color: var(--dv-ui-text);
}

.wsdialog__list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  margin: 10px 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.wsrow {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid transparent;
  border-radius: var(--dv-ui-radius-sm);
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.wsrow:hover {
  background: var(--dv-ui-surface-3);
}

.wsrow.is-current {
  border-color: var(--dv-ui-line-soft);
  background: var(--dv-ui-surface-1);
}

.wsrow__mark {
  flex: none;
  width: 13px;
  display: grid;
  place-items: center;
  color: var(--dv-ui-accent);
}

.wsrow__body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.wsrow__name {
  font-size: 12.5px;
  font-weight: 560;
  color: var(--dv-ui-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 长路径从尾部截断：目录的尾部才是用户真正在找的那一段 */
.wsrow__root {
  direction: rtl;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--dv-font-mono);
  font-size: 10.5px;
  color: var(--dv-ui-text-dim);
}

.wsdialog__actions {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--dv-ui-line-soft);
}

.wsaction {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  padding: 0 10px;
  border: 1px solid transparent;
  border-radius: var(--dv-ui-radius-sm);
  background: transparent;
  color: var(--dv-ui-text-2);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.wsaction:hover {
  background: var(--dv-ui-surface-3);
  color: var(--dv-ui-text);
}

.wsaction--danger {
  margin-left: auto;
  color: var(--dv-ui-text-muted);
}

.wsaction--danger:hover {
  background: color-mix(in srgb, var(--dv-ui-danger) 14%, transparent);
  color: var(--dv-ui-danger);
}
</style>
