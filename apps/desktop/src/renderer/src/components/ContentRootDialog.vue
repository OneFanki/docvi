<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { FolderTree, X } from 'lucide-vue-next'

import { useI18n } from '../lib/i18n'

/**
 * 内容根候选选择框。
 *
 * 为什么要有：用户添加目录时常选中「仓库根」或「文档总目录」，真正的文档根在
 * 里面一层。旧版会列出候选让用户挑；不挑的话，父目录加进去会得到一棵把无关
 * 目录全摊开的树，而且没有落地页。
 *
 * 两个出口都很重要：「用这个目录」不能省——有些用户就是想要自动扫描的整棵树，
 * 强行要求有 docs.config.yaml 会挡住他们。
 */
const props = defineProps<{
  open: boolean
  /** 用户实际选中的目录（坚持用它的按钮用） */
  root: string
  candidates: Array<{ name: string; path: string }>
}>()

const emit = defineEmits<{
  choose: [path: string]
  keep: []
  close: []
}>()

const { t } = useI18n()
const panel = ref<HTMLElement | null>(null)

watch(
  () => props.open,
  async open => {
    if (!open) return
    await nextTick()
    panel.value?.querySelector<HTMLElement>('button')?.focus()
  },
)

function onKeydown(event: KeyboardEvent): void {
  if (!props.open) return
  if (event.key === 'Escape') {
    event.preventDefault()
    emit('close')
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="overlay" @mousedown.self="emit('close')" @keydown="onKeydown">
      <div
        ref="panel"
        class="candidates"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cand-title"
      >
        <div class="candidates__head">
          <FolderTree :size="15" :stroke-width="1.8" class="candidates__icon" />
          <h2 id="cand-title" class="candidates__title">{{ t('workspace.candidates.title') }}</h2>
          <button
            v-tooltip="t('confirm.cancel')"
            class="candidates__close"
            type="button"
            :aria-label="t('confirm.cancel')"
            @click="emit('close')"
          >
            <X :size="14" :stroke-width="1.8" />
          </button>
        </div>
        <p class="candidates__hint">{{ t('workspace.candidates.hint') }}</p>

        <ul class="candidates__list">
          <li v-for="item in candidates" :key="item.path">
            <button class="candidate" type="button" @click="emit('choose', item.path)">
              <span class="candidate__name">{{ item.name }}</span>
              <span v-tooltip="item.path" class="candidate__path">{{ item.path }}</span>
            </button>
          </li>
        </ul>

        <div class="candidates__foot">
          <button class="btn btn--ghost" type="button" @click="emit('keep')">
            {{ t('workspace.candidates.keep') }}
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

.candidates {
  width: min(520px, calc(100vw - 64px));
  max-height: min(560px, calc(100vh - 96px));
  display: flex;
  flex-direction: column;
  padding: 16px;
  border: 1px solid var(--dv-ui-line);
  border-radius: var(--dv-ui-radius-md);
  background: var(--dv-ui-surface-2);
  box-shadow: var(--dv-ui-shadow-2);
}

.candidates__head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.candidates__icon {
  flex: none;
  color: var(--dv-ui-accent);
}

.candidates__title {
  flex: 1;
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--dv-ui-text);
}

.candidates__close {
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

.candidates__close:hover {
  background: var(--dv-ui-surface-3);
  color: var(--dv-ui-text);
}

.candidates__hint {
  margin: 8px 0 12px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--dv-ui-text-muted);
}

.candidates__list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.candidate {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 9px 10px;
  border: 1px solid var(--dv-ui-line-soft);
  border-radius: var(--dv-ui-radius-sm);
  background: var(--dv-ui-surface-1);
  text-align: left;
  cursor: pointer;
}

.candidate:hover {
  border-color: var(--dv-ui-accent);
  background: var(--dv-ui-surface-3);
}

.candidate__name {
  font-size: 12.5px;
  font-weight: 560;
  color: var(--dv-ui-text);
}

/* 长路径从尾部截断：目录的尾部才是用户真正在找的那一段 */
.candidate__path {
  direction: rtl;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--dv-font-mono, ui-monospace, monospace);
  font-size: 10.5px;
  color: var(--dv-ui-text-dim);
}

.candidates__foot {
  display: flex;
  justify-content: flex-end;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--dv-ui-line-soft);
}

.btn {
  height: 30px;
  padding: 0 12px;
  border: 1px solid var(--dv-ui-line);
  border-radius: var(--dv-ui-radius-sm);
  background: transparent;
  color: var(--dv-ui-text-2);
  font-size: 12px;
  cursor: pointer;
}

.btn:hover {
  background: var(--dv-ui-surface-3);
  color: var(--dv-ui-text);
}
</style>
