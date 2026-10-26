<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { Check, GitBranch, Loader2, X } from 'lucide-vue-next'

import type { WorkspaceEntry } from '@docvi/shared'
import { useI18n } from '../lib/i18n'
import { useAppStore } from '../stores/app'

/**
 * 切换分支。
 *
 * 平台自持副本模型下，每个分支都有自己的工作树：切分支不是 `git checkout`，而是
 * 「换一个工作区」（id/root 都会变，由主进程重算）。所以这里的动作是切换现场，
 * 不是改动仓库——工作树里的任何本地修改都会在切回来时按云端重置。
 */
const props = defineProps<{
  open: boolean
  workspace: WorkspaceEntry | null
}>()

const emit = defineEmits<{
  switched: [entry: WorkspaceEntry]
  close: []
}>()

const store = useAppStore()
const { t } = useI18n()

const branches = ref<string[]>([])
const loading = ref(false)
const switching = ref<string | null>(null)
const error = ref<string | null>(null)
const panel = ref<HTMLElement | null>(null)

const current = computed(() => props.workspace?.git?.branch ?? null)

/** 分支多时先过滤：仓库常有几十个分支，靠肉眼翻列表太慢 */
const filter = ref('')
const filtered = computed(() => {
  const keyword = filter.value.trim().toLowerCase()
  if (!keyword) return branches.value
  return branches.value.filter(branch => branch.toLowerCase().includes(keyword))
})

async function load(): Promise<void> {
  if (!props.workspace) return
  loading.value = true
  error.value = null
  try {
    const list = await store.listBranches(props.workspace.id)
    branches.value = list ?? []
  } finally {
    loading.value = false
  }
}

watch(
  () => props.open,
  async open => {
    if (!open) {
      branches.value = []
      filter.value = ''
      switching.value = null
      error.value = null
      return
    }
    await load()
    await nextTick()
    panel.value?.querySelector<HTMLElement>('input')?.focus()
  },
)

async function choose(branch: string): Promise<void> {
  if (!props.workspace || switching.value) return
  if (branch === current.value) {
    emit('close')
    return
  }
  switching.value = branch
  error.value = null
  try {
    const entry = await store.switchBranch(props.workspace.id, branch)
    if (!entry) {
      error.value = store.error ?? t('git.switchFailed')
      return
    }
    emit('switched', entry)
  } finally {
    switching.value = null
  }
}

function requestClose(): void {
  if (switching.value) return
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
      <div ref="panel" class="branches" role="dialog" aria-modal="true" aria-labelledby="br-title">
        <div class="branches__head">
          <GitBranch :size="15" :stroke-width="1.8" class="branches__icon" />
          <h2 id="br-title" class="branches__title">
            {{ t('git.branchesTitle', { name: workspace?.name ?? '' }) }}
          </h2>
          <button
            v-if="!switching"
            v-tooltip="t('confirm.cancel')"
            class="branches__close"
            type="button"
            :aria-label="t('confirm.cancel')"
            @click="requestClose"
          >
            <X :size="14" :stroke-width="1.8" />
          </button>
        </div>

        <p v-if="workspace?.git" v-tooltip="workspace.git.url" class="branches__repo">
          {{ workspace.git.url }}
        </p>

        <input
          v-model="filter"
          class="branches__filter"
          type="text"
          spellcheck="false"
          autocomplete="off"
          :placeholder="t('git.filterBranches')"
          :disabled="!!switching"
        />

        <div class="branches__list">
          <div v-if="loading" class="branches__state">
            <Loader2 :size="13" :stroke-width="2" class="branches__spin" />
            <span>{{ t('git.loadingBranches') }}</span>
          </div>
          <div v-else-if="!filtered.length" class="branches__state">
            {{ filter ? t('git.noMatch') : t('git.noBranches') }}
          </div>
          <button
            v-for="branch in filtered"
            :key="branch"
            class="branch"
            type="button"
            :class="{ 'is-current': branch === current }"
            :disabled="!!switching"
            @click="choose(branch)"
          >
            <span class="branch__name">{{ branch }}</span>
            <Loader2
              v-if="switching === branch"
              :size="13"
              :stroke-width="2"
              class="branches__spin"
            />
            <Check
              v-else-if="branch === current"
              :size="13"
              :stroke-width="2.2"
              class="branch__check"
            />
          </button>
        </div>

        <p v-if="error" class="branches__error" role="alert">{{ error }}</p>
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

.branches {
  width: min(460px, calc(100vw - 64px));
  max-height: min(560px, calc(100vh - 96px));
  display: flex;
  flex-direction: column;
  padding: 16px;
  border: 1px solid var(--dv-ui-line);
  border-radius: var(--dv-ui-radius-md);
  background: var(--dv-ui-surface-2);
  box-shadow: var(--dv-ui-shadow-2);
}

.branches__head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.branches__icon {
  flex: none;
  color: var(--dv-ui-accent);
}

.branches__title {
  flex: 1;
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
  font-weight: 600;
  color: var(--dv-ui-text);
}

.branches__close {
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

.branches__close:hover {
  background: var(--dv-ui-surface-3);
  color: var(--dv-ui-text);
}

.branches__repo {
  margin: 6px 0 10px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
  text-align: left;
  font-family: var(--dv-font-mono, ui-monospace, monospace);
  font-size: 10.5px;
  color: var(--dv-ui-text-dim);
}

.branches__filter {
  height: 30px;
  padding: 0 9px;
  border: 1px solid var(--dv-ui-line);
  border-radius: var(--dv-ui-radius-sm);
  background: var(--dv-ui-surface-1);
  color: var(--dv-ui-text);
  font-size: 12px;
}

.branches__filter:focus {
  outline: none;
  border-color: var(--dv-ui-accent);
}

.branches__list {
  flex: 1;
  min-height: 80px;
  overflow-y: auto;
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.branches__state {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 10px;
  font-size: 12px;
  color: var(--dv-ui-text-dim);
}

.branches__spin {
  flex: none;
  animation: branch-spin 1s linear infinite;
  color: var(--dv-ui-accent);
}

@keyframes branch-spin {
  to {
    transform: rotate(360deg);
  }
}

.branch {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 30px;
  padding: 0 9px;
  border: 1px solid transparent;
  border-radius: var(--dv-ui-radius-sm);
  background: transparent;
  color: var(--dv-ui-text-2);
  font-family: var(--dv-font-mono, ui-monospace, monospace);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.branch:hover:not(:disabled) {
  border-color: var(--dv-ui-line-soft);
  background: var(--dv-ui-surface-1);
  color: var(--dv-ui-text);
}

.branch.is-current {
  border-color: var(--dv-ui-line-soft);
  background: var(--dv-ui-surface-1);
  color: var(--dv-ui-text);
  font-weight: 560;
}

.branch:disabled {
  cursor: default;
}

.branch__name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.branch__check {
  flex: none;
  color: var(--dv-ui-accent);
}

.branches__error {
  margin: 10px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--dv-ui-danger);
}
</style>
