<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { GitBranch, Loader2, X } from 'lucide-vue-next'

import type { GitProgressEvent, GitState, WorkspaceEntry } from '@docvi/shared'
import { useI18n } from '../lib/i18n'

/**
 * 克隆 Git 仓库。
 *
 * 平台自持副本模型：克隆结果落在应用数据目录（`git/<名>.git` + 分支工作树），
 * 不写用户的任何目录。所以这里只需要地址/名称/分支三件事，没有「克隆到哪」。
 *
 * 克隆期间不允许关闭：git 进程一旦开始就无法从界面上中止，关掉对话框只会让
 * 用户以为已经取消，实际仍在后台跑。进度条是唯一的真相（phase 文案 + 百分比）。
 */
const props = defineProps<{
  open: boolean
  git: GitState | null
}>()

const emit = defineEmits<{
  done: [entry: WorkspaceEntry]
  close: []
}>()

const { t } = useI18n()

const url = ref('')
const name = ref('')
const branch = ref('')
const busy = ref(false)
const error = ref<string | null>(null)
const progress = ref<GitProgressEvent | null>(null)
const panel = ref<HTMLElement | null>(null)

let unsubscribe: (() => void) | null = null

/** 地址 → 建议名称：取末尾一段并去掉 .git（只做初值，用户可改） */
function suggestName(value: string): string {
  const cleaned = value
    .trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
  return cleaned.split(/[/:]/).filter(Boolean).pop() ?? ''
}

/** 名称跟随地址，但只在用户没手动改过时覆盖 */
const nameTouched = ref(false)

function onUrlInput(value: string): void {
  url.value = value
  if (!nameTouched.value) name.value = suggestName(value)
}

/** 手改名称后就不再跟随地址：两边同时被改写会让人没法填自己想要的名字 */
function onNameInput(value: string): void {
  nameTouched.value = true
  name.value = value
}

const disabledReason = computed(() => {
  if (props.git && !props.git.available) return props.git.reason ?? t('git.unavailable')
  return null
})

const percentLabel = computed(() => {
  const value = progress.value?.percent
  return value === null || value === undefined ? null : `${value}%`
})

watch(
  () => props.open,
  async open => {
    if (!open) {
      unsubscribe?.()
      unsubscribe = null
      return
    }
    error.value = null
    progress.value = null
    busy.value = false
    url.value = ''
    name.value = ''
    nameTouched.value = false
    branch.value = ''
    unsubscribe = window.docvi.onGitProgress(event => {
      // 只认这次克隆自己的进度：同一时刻也可能有别的窗口在拉取
      if (event.workspaceName === name.value.trim()) progress.value = event
    })
    await nextTick()
    panel.value?.querySelector<HTMLInputElement>('input')?.focus()
  },
)

onBeforeUnmount(() => {
  unsubscribe?.()
  unsubscribe = null
})

async function submit(): Promise<void> {
  if (busy.value || disabledReason.value) return
  const cleanUrl = url.value.trim()
  if (!cleanUrl) {
    error.value = t('git.urlRequired')
    return
  }
  const cleanName = name.value.trim() || suggestName(cleanUrl)
  if (!cleanName) {
    error.value = t('git.nameRequired')
    return
  }
  busy.value = true
  error.value = null
  name.value = cleanName
  progress.value = {
    workspaceName: cleanName,
    phase: 'start',
    message: t('git.connecting'),
    percent: null,
  }
  try {
    const result = await window.docvi.gitClone({
      url: cleanUrl,
      name: cleanName,
      ...(branch.value.trim() ? { branch: branch.value.trim() } : {}),
    })
    if (!result.ok) {
      error.value = result.error.message
      progress.value = null
      return
    }
    emit('done', result.data)
  } finally {
    busy.value = false
  }
}

function requestClose(): void {
  if (busy.value) return
  emit('close')
}

function onKeydown(event: KeyboardEvent): void {
  if (!props.open) return
  if (event.key === 'Escape') {
    event.preventDefault()
    requestClose()
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="overlay" @mousedown.self="requestClose" @keydown="onKeydown">
      <form
        ref="panel"
        class="clone"
        role="dialog"
        aria-modal="true"
        aria-labelledby="clone-title"
        @submit.prevent="submit"
      >
        <div class="clone__head">
          <GitBranch :size="15" :stroke-width="1.8" class="clone__icon" />
          <h2 id="clone-title" class="clone__title">{{ t('git.cloneTitle') }}</h2>
          <button
            v-if="!busy"
            v-tooltip="t('confirm.cancel')"
            class="clone__close"
            type="button"
            :aria-label="t('confirm.cancel')"
            @click="requestClose"
          >
            <X :size="14" :stroke-width="1.8" />
          </button>
        </div>

        <p v-if="disabledReason" class="clone__blocked">{{ disabledReason }}</p>

        <template v-else>
          <label class="field">
            <span class="field__label">{{ t('git.url') }}</span>
            <input
              class="field__input"
              type="text"
              spellcheck="false"
              autocomplete="off"
              :value="url"
              :placeholder="t('git.urlPlaceholder')"
              :disabled="busy"
              @input="onUrlInput(($event.target as HTMLInputElement).value)"
            />
          </label>

          <div class="field-row">
            <label class="field">
              <span class="field__label">{{ t('git.name') }}</span>
              <input
                class="field__input"
                type="text"
                spellcheck="false"
                autocomplete="off"
                :value="name"
                :placeholder="t('git.namePlaceholder')"
                :disabled="busy"
                @input="onNameInput(($event.target as HTMLInputElement).value)"
              />
            </label>
            <label class="field">
              <span class="field__label">{{ t('git.branch') }}</span>
              <input
                class="field__input"
                type="text"
                spellcheck="false"
                autocomplete="off"
                :value="branch"
                :placeholder="t('git.branchPlaceholder')"
                :disabled="busy"
                @input="branch = ($event.target as HTMLInputElement).value"
              />
            </label>
          </div>

          <p class="clone__hint">{{ t('git.cloneHint') }}</p>

          <div v-if="busy" class="progress" role="status" aria-live="polite">
            <div class="progress__row">
              <Loader2 :size="13" :stroke-width="2" class="progress__spin" />
              <span class="progress__text">{{ progress?.message ?? t('git.cloning') }}</span>
              <span v-if="percentLabel" class="progress__percent">{{ percentLabel }}</span>
            </div>
            <div class="progress__track">
              <div
                class="progress__bar"
                :class="{ 'is-indeterminate': percentLabel === null }"
                :style="percentLabel ? { width: percentLabel } : undefined"
              />
            </div>
          </div>

          <p v-if="error" class="clone__error" role="alert">{{ error }}</p>
        </template>

        <div class="clone__foot">
          <button class="btn" type="button" :disabled="busy" @click="requestClose">
            {{ t('confirm.cancel') }}
          </button>
          <button class="btn btn--primary" type="submit" :disabled="busy || !!disabledReason">
            {{ busy ? t('git.cloning') : t('git.cloneAction') }}
          </button>
        </div>
      </form>
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

.clone {
  width: min(520px, calc(100vw - 64px));
  display: flex;
  flex-direction: column;
  padding: 16px;
  border: 1px solid var(--dv-ui-line);
  border-radius: var(--dv-ui-radius-md);
  background: var(--dv-ui-surface-2);
  box-shadow: var(--dv-ui-shadow-2);
}

.clone__head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.clone__icon {
  flex: none;
  color: var(--dv-ui-accent);
}

.clone__title {
  flex: 1;
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--dv-ui-text);
}

.clone__close {
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

.clone__close:hover {
  background: var(--dv-ui-surface-3);
  color: var(--dv-ui-text);
}

.clone__blocked {
  margin: 12px 0 4px;
  padding: 10px 12px;
  border: 1px solid var(--dv-ui-line-soft);
  border-radius: var(--dv-ui-radius-sm);
  background: var(--dv-ui-surface-1);
  font-size: 12px;
  line-height: 1.7;
  color: var(--dv-ui-text-muted);
}

.field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin-top: 12px;
  flex: 1;
  min-width: 0;
}

.field-row {
  display: flex;
  gap: 10px;
}

.field__label {
  font-size: 11.5px;
  color: var(--dv-ui-text-2);
}

.field__input {
  height: 30px;
  padding: 0 9px;
  border: 1px solid var(--dv-ui-line);
  border-radius: var(--dv-ui-radius-sm);
  background: var(--dv-ui-surface-1);
  color: var(--dv-ui-text);
  font-family: var(--dv-font-mono, ui-monospace, monospace);
  font-size: 12px;
}

.field__input:focus {
  outline: none;
  border-color: var(--dv-ui-accent);
}

.field__input:disabled {
  opacity: 0.6;
}

.clone__hint {
  margin: 8px 0 0;
  font-size: 11px;
  line-height: 1.6;
  color: var(--dv-ui-text-dim);
}

.progress {
  margin-top: 12px;
}

.progress__row {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 11.5px;
  color: var(--dv-ui-text-2);
}

.progress__spin {
  flex: none;
  color: var(--dv-ui-accent);
  animation: clone-spin 1s linear infinite;
}

@keyframes clone-spin {
  to {
    transform: rotate(360deg);
  }
}

.progress__text {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.progress__percent {
  flex: none;
  font-variant-numeric: tabular-nums;
  color: var(--dv-ui-text-dim);
}

.progress__track {
  height: 3px;
  margin-top: 7px;
  border-radius: 999px;
  background: var(--dv-ui-surface-3);
  overflow: hidden;
}

.progress__bar {
  height: 100%;
  background: var(--dv-ui-accent);
  transition: width var(--dv-ui-dur-1) var(--dv-ui-ease);
}

/* 百分比未知（枚举/压缩阶段）时给一条来回跑的光带，避免进度条看起来卡死 */
.progress__bar.is-indeterminate {
  width: 38%;
  animation: clone-slide 1.2s ease-in-out infinite;
}

@keyframes clone-slide {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(300%);
  }
}

.clone__error {
  margin: 10px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--dv-ui-danger);
}

.clone__foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 14px;
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

.btn:hover:not(:disabled) {
  background: var(--dv-ui-surface-3);
  color: var(--dv-ui-text);
}

.btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.btn--primary {
  background: var(--dv-ui-accent);
  border-color: transparent;
  color: var(--dv-ui-accent-fg);
  font-weight: 560;
}

.btn--primary:hover:not(:disabled) {
  background: var(--dv-ui-accent-strong);
  color: var(--dv-ui-accent-fg);
}
</style>
