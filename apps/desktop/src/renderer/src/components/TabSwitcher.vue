<script setup lang="ts">
import { computed } from 'vue'
import { Blocks, FileText, Folder, Settings } from 'lucide-vue-next'

import type { TabRecord } from '../stores/tabs'
import { isRealScopeLabel, tabTitleOf } from '../stores/tabs'
import { useI18n } from '../lib/i18n'

/**
 * Ctrl+Tab 切换浮层（WebStorm 手感）。
 *
 * 行为契约：
 *  - 列表按**最近使用**排序，不含文档库标签；
 *  - 按住 Ctrl 连按 Tab 前进、Ctrl+Shift+Tab 后退，**松开 Ctrl 才落地**；
 *  - 初始选中「上一次用的标签」，所以快速按一下松手就是 A↔B 来回；
 *  - Esc 取消，点条目直接落地。
 *
 * 这个组件只负责展示与选中；按键状态机在 App 里（它才知道什么时候松手）。
 */
const props = defineProps<{
  open: boolean
  items: TabRecord[]
  cursor: number
}>()

const emit = defineEmits<{
  select: [id: string]
  hover: [index: number]
}>()

const { t } = useI18n()

const tabLabels = computed(() => ({
  library: t('app.library'),
  settings: t('app.settings'),
  plugins: t('app.plugins'),
}))

function titleOf(tab: TabRecord): { scope: string; doc: string | null; label: string } {
  return tabTitleOf(tab, tabLabels.value)
}

const current = computed(() => props.items[props.cursor] ?? null)
</script>

<template>
  <div v-if="open" class="switcher-scrim" @click.self="emit('select', '')">
    <div class="switcher" role="listbox" aria-label="切换标签页">
      <div class="switcher__head">
        <span>{{ t('switcher.title') }}</span>
        <span class="switcher__hint">Ctrl+Tab · 松开切换</span>
      </div>
      <div class="switcher__list">
        <button
          v-for="(tab, index) in items"
          :key="tab.id"
          class="item"
          :class="{ 'is-active': index === cursor }"
          type="button"
          role="option"
          :aria-selected="index === cursor"
          @click="emit('select', tab.id)"
          @mouseenter="emit('hover', index)"
        >
          <Settings
            v-if="tab.kind === 'settings'"
            :size="13"
            :stroke-width="1.7"
            class="item__icon"
          />
          <Blocks
            v-else-if="tab.kind === 'plugins'"
            :size="13"
            :stroke-width="1.7"
            class="item__icon"
          />
          <Folder
            v-else-if="tab.kind === 'workspace'"
            :size="13"
            :stroke-width="1.7"
            class="item__icon"
          />
          <FileText v-else :size="13" :stroke-width="1.7" class="item__icon" />
          <span class="item__doc">{{ titleOf(tab).label }}</span>
          <span
            v-if="isRealScopeLabel(titleOf(tab).scope) && titleOf(tab).scope !== titleOf(tab).label"
            class="item__scope"
            >{{ titleOf(tab).scope }}</span
          >
        </button>
      </div>
      <div class="switcher__foot">
        {{ current ? `${props.cursor + 1} / ${items.length}` : '—' }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.switcher-scrim {
  position: fixed;
  inset: 0;
  z-index: 70;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--dv-ui-bg) 42%, transparent);
}

.switcher {
  width: min(520px, calc(100vw - 80px));
  max-height: min(420px, 70vh);
  display: flex;
  flex-direction: column;
  border: 1px solid var(--dv-ui-line);
  border-radius: var(--dv-ui-radius-md);
  background: var(--dv-ui-surface-1);
  box-shadow: var(--dv-ui-shadow-2);
  overflow: hidden;
}

.switcher__head,
.switcher__foot {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  font-size: 11px;
  color: var(--dv-ui-text-dim);
}

.switcher__head {
  border-bottom: 1px solid var(--dv-ui-line-soft);
}

.switcher__foot {
  border-top: 1px solid var(--dv-ui-line-soft);
  justify-content: flex-end;
  font-variant-numeric: tabular-nums;
}

.switcher__list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 4px;
}

.item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 30px;
  padding: 0 10px;
  border: none;
  border-radius: var(--dv-ui-radius-sm);
  background: transparent;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.item.is-active {
  background: var(--dv-ui-surface-3);
}

.item__icon {
  flex: none;
  color: var(--dv-ui-text-dim);
}

.item__doc {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dv-ui-text);
}

/* 工作区名做弱化后缀：主扫读对象是文档名 */
.item__scope {
  flex: none;
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dv-ui-text-dim);
  font-size: 11px;
}
</style>
