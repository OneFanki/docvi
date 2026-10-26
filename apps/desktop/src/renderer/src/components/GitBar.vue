<script setup lang="ts">
import { GitBranch, RefreshCw } from 'lucide-vue-next'

import type { GitWorkspace } from '@docvi/shared'
import { useI18n } from '../lib/i18n'

/**
 * 侧栏顶部的 git 状态条。
 *
 * 为什么放在这里而不是只留在文档库卡片上：读文档时用户不会回文档库，但「我现在
 * 看的是哪条分支」「有没有更新」恰恰是阅读时必须随时知道的信息——文档内容本身
 * 就取决于分支。两个动作（切分支 / 拉取）也放在这一行，省一次来回。
 */
defineProps<{
  git: GitWorkspace
  busy?: boolean
}>()

const emit = defineEmits<{
  switchBranch: []
  pull: []
}>()

const { t } = useI18n()
</script>

<template>
  <div class="gitbar">
    <button v-tooltip="git.url" class="gitbar__branch" type="button" @click="emit('switchBranch')">
      <GitBranch :size="12" :stroke-width="1.8" aria-hidden="true" />
      <span class="gitbar__name">{{ git.branch }}</span>
    </button>
    <button
      v-tooltip="t('git.pullNow')"
      class="gitbar__pull"
      type="button"
      :aria-label="t('git.pullNow')"
      :disabled="busy"
      @click="emit('pull')"
    >
      <RefreshCw :size="12" :stroke-width="1.8" :class="{ 'is-spin': busy }" />
    </button>
  </div>
</template>

<style scoped>
.gitbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px 6px 10px;
  border-bottom: 1px solid var(--dv-ui-line-soft);
}

.gitbar__branch {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 6px;
  border: 1px solid transparent;
  border-radius: var(--dv-ui-radius-sm);
  background: transparent;
  color: var(--dv-ui-text-2);
  cursor: pointer;
}

.gitbar__branch:hover {
  border-color: var(--dv-ui-line-soft);
  background: var(--dv-ui-surface-2);
  color: var(--dv-ui-text);
}

.gitbar__branch > svg {
  flex: none;
  color: var(--dv-ui-accent);
}

.gitbar__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--dv-font-mono, ui-monospace, monospace);
  font-size: 11px;
}

.gitbar__pull {
  flex: none;
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: var(--dv-ui-radius-sm);
  background: transparent;
  color: var(--dv-ui-text-dim);
  cursor: pointer;
}

.gitbar__pull:hover:not(:disabled) {
  background: var(--dv-ui-surface-2);
  color: var(--dv-ui-text);
}

.gitbar__pull:disabled {
  cursor: default;
  opacity: 0.6;
}

.is-spin {
  animation: gitbar-spin 1s linear infinite;
}

@keyframes gitbar-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
