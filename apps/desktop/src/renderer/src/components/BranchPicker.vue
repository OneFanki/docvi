<script setup lang="ts">
import { computed, ref } from 'vue'
import { ChevronDown, GitBranch } from 'lucide-vue-next'

import type { PortalWorkspace } from '@docvi/shared'
import { useI18n } from '../lib/i18n'

/**
 * 容器读者面的分支选择器。
 *
 * 与桌面版 `BranchDialog` 的本质区别：桌面切分支会**换一棵工作树**（写操作，
 * 走 git API）；容器读者切分支只是给地址加上 `?branch=`——不动服务器、不影响
 * 其他读者。因此这里不弹模态，就地展开一个小面板，选中即刷新。
 *
 * 只列**有产物**的分支为可选项：构建中/失败/无产物的分支点进去只会得到 503
 * 「分支工作树未就绪」，把必然失败的选项做成可点是更差的体验。
 */
const props = defineProps<{
  workspace: PortalWorkspace
  /** 当前分支（来自 ?branch=，缺省为仓库默认分支） */
  current: string | null
}>()

const emit = defineEmits<{ select: [branch: string] }>()

const { t } = useI18n()
const open = ref(false)

const activeBranch = computed(
  () =>
    props.current ?? props.workspace.defaultBranch ?? props.workspace.branches[0]?.branch ?? null,
)

/** 可浏览的分支在前；不可用的仍列出，但禁用并给出状态文字 */
const items = computed(() =>
  props.workspace.branches.map(item => ({
    ...item,
    usable: item.artifact === 'ready',
    stateLabel:
      item.artifact === 'ready'
        ? item.index === 'indexed'
          ? t('portal.state.ready')
          : item.index === 'indexing'
            ? t('portal.state.indexing')
            : t('portal.state.pending')
        : item.artifact === 'building'
          ? t('portal.state.building')
          : item.artifact === 'failed'
            ? t('portal.state.failed')
            : t('portal.state.none'),
  })),
)

function choose(branch: string, usable: boolean): void {
  if (!usable) return
  open.value = false
  if (branch !== activeBranch.value) emit('select', branch)
}
</script>

<template>
  <div class="branchpick">
    <button
      v-tooltip="t('portal.branchHint')"
      class="branchpick__head"
      type="button"
      :aria-expanded="open"
      aria-haspopup="menu"
      @click="open = !open"
    >
      <GitBranch :size="12" :stroke-width="1.8" aria-hidden="true" />
      <span class="branchpick__name">{{ activeBranch ?? '—' }}</span>
      <ChevronDown
        :size="11"
        :stroke-width="2"
        class="branchpick__chevron"
        :class="{ 'is-open': open }"
        aria-hidden="true"
      />
    </button>

    <div v-if="open" class="branchpick__panel" role="menu">
      <div class="branchpick__title">{{ t('portal.branches') }}</div>
      <button
        v-for="item in items"
        :key="item.branch"
        class="branchpick__item"
        :class="{ 'is-active': item.branch === activeBranch, 'is-disabled': !item.usable }"
        type="button"
        role="menuitem"
        :disabled="!item.usable"
        @click="choose(item.branch, item.usable)"
      >
        <span class="branchpick__dot" :data-state="item.usable ? item.index : item.artifact" />
        <span class="branchpick__label">{{ item.branch }}</span>
        <span class="branchpick__state">{{ item.stateLabel }}</span>
      </button>
      <p class="branchpick__hint">{{ t('portal.branchHint') }}</p>
    </div>
  </div>
</template>

<style scoped>
.branchpick {
  position: relative;
  flex: none;
}

.branchpick__head {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 180px;
  padding: 3px 7px;
  border: none;
  border-radius: var(--dv-ui-radius-sm);
  background: transparent;
  color: var(--dv-ui-text-dim);
  font-size: 11px;
  cursor: pointer;
}

.branchpick__head:hover {
  background: var(--dv-ui-surface-2);
  color: var(--dv-ui-text);
}

.branchpick__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.branchpick__chevron {
  flex: none;
  transition: transform 0.12s ease;
}

.branchpick__chevron.is-open {
  transform: rotate(180deg);
}

.branchpick__panel {
  position: absolute;
  z-index: 60;
  top: calc(100% + 4px);
  left: 0;
  min-width: 220px;
  padding: 6px;
  border: 1px solid var(--dv-ui-line);
  border-radius: var(--dv-ui-radius-md);
  background: var(--dv-ui-surface-1);
  box-shadow: var(--dv-ui-shadow-2);
}

.branchpick__title {
  padding: 2px 6px 6px;
  color: var(--dv-ui-text-dim);
  font-size: 10.5px;
  letter-spacing: 0.02em;
}

.branchpick__item {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 5px 6px;
  border: none;
  border-radius: var(--dv-ui-radius-sm);
  background: transparent;
  color: var(--dv-ui-text-2);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.branchpick__item:hover:not(.is-disabled) {
  background: var(--dv-ui-surface-2);
}

.branchpick__item.is-active {
  color: var(--dv-ui-accent);
}

.branchpick__item.is-disabled {
  color: var(--dv-ui-text-dim);
  cursor: default;
  opacity: 0.6;
}

.branchpick__dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--dv-ui-text-dim);
}

/* 绿 = 最新且索引完成；蓝 = 正在索引；红 = 失败；其余灰 */
.branchpick__dot[data-state='indexed'],
.branchpick__dot[data-state='ready'] {
  background: #4ea36a;
}

.branchpick__dot[data-state='indexing'],
.branchpick__dot[data-state='pending'],
.branchpick__dot[data-state='building'] {
  background: #c98a3d;
}

.branchpick__dot[data-state='failed'] {
  background: #c25454;
}

.branchpick__label {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.branchpick__state {
  flex: none;
  color: var(--dv-ui-text-dim);
  font-size: 10.5px;
}

.branchpick__hint {
  margin: 6px 6px 2px;
  padding-top: 6px;
  border-top: 1px solid var(--dv-ui-line-soft);
  color: var(--dv-ui-text-dim);
  font-size: 10.5px;
  line-height: 1.5;
}
</style>
