<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { X } from 'lucide-vue-next'

import { SHORTCUT_GROUPS, formatKeys } from '../lib/shortcuts'
import { useI18n } from '../lib/i18n'

/**
 * 快捷键与帮助面板（Ctrl+/）。
 *
 * 内容直接来自 `lib/shortcuts.ts` 的同一份表——帮助里写了什么，App 的键盘处理器
 * 就按同一批 id 实现，不会出现「文档有、实际没绑」的漂移。
 */
const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()

const panel = ref<HTMLElement | null>(null)
const { t } = useI18n()

watch(
  () => props.open,
  async open => {
    if (!open) return
    await nextTick()
    // 焦点移进对话框：否则 Tab 会跑到背后的界面上
    panel.value?.querySelector<HTMLElement>('button')?.focus()
  },
)

function onKeydown(event: KeyboardEvent): void {
  if (!props.open) return
  if (event.key === 'Escape') {
    event.preventDefault()
    emit('close')
    return
  }
  if (event.key !== 'Tab') return
  // 焦点陷阱：面板里只有关闭按钮一个可聚焦元素，Tab 循环留在里面
  const focusable = panel.value?.querySelectorAll<HTMLElement>('button, [href], [tabindex="0"]')
  if (!focusable?.length) return
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (!first || !last) return
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div v-if="open" class="scrim" @click.self="emit('close')">
    <div
      ref="panel"
      class="panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby="shortcuts-title"
    >
      <header class="panel__head">
        <h2 id="shortcuts-title" class="panel__title">{{ t('shortcuts.title') }}</h2>
        <button
          class="panel__close"
          type="button"
          :aria-label="t('shortcuts.close')"
          @click="emit('close')"
        >
          <X :size="15" :stroke-width="1.8" />
        </button>
      </header>

      <div class="panel__body">
        <section v-for="group in SHORTCUT_GROUPS" :key="group.title" class="group">
          <h3 class="group__title">{{ group.title }}</h3>
          <dl class="rows">
            <div v-for="item in group.items" :key="item.action" class="row">
              <dt class="row__keys">
                <kbd v-for="key in formatKeys(item.keys)" :key="key" class="key">{{ key }}</kbd>
              </dt>
              <dd class="row__action">{{ item.action }}</dd>
            </div>
          </dl>
        </section>
      </div>

      <footer class="panel__foot">
        {{ t('shortcuts.tip') }}
      </footer>
    </div>
  </div>
</template>

<style scoped>
.scrim {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 6vh 16px;
  background: color-mix(in srgb, var(--dv-ui-bg) 62%, transparent);
  backdrop-filter: blur(2px);
}

.panel {
  width: min(660px, 100%);
  max-height: 100%;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--dv-ui-line);
  border-radius: var(--dv-ui-radius-md);
  background: var(--dv-ui-surface-1);
  box-shadow: var(--dv-ui-shadow-2);
  overflow: hidden;
}

.panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 13px 16px;
  border-bottom: 1px solid var(--dv-ui-line-soft);
}

.panel__title {
  margin: 0;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--dv-ui-text);
}

.panel__close {
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  border: none;
  border-radius: var(--dv-ui-radius-sm);
  background: transparent;
  color: var(--dv-ui-text-dim);
  cursor: pointer;
}

.panel__close:hover {
  background: var(--dv-ui-surface-3);
  color: var(--dv-ui-text);
}

.panel__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 14px 16px 4px;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 4px 26px;
}

.group {
  margin-bottom: 14px;
}

.group__title {
  margin: 0 0 6px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--dv-ui-text-dim);
}

.rows {
  margin: 0;
}

.row {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 4px 0;
}

.row__keys {
  flex: none;
  display: flex;
  gap: 3px;
  min-width: 96px;
}

.key {
  display: inline-block;
  min-width: 20px;
  padding: 1px 5px;
  border: 1px solid var(--dv-ui-line);
  border-bottom-width: 2px;
  border-radius: 4px;
  background: var(--dv-ui-surface-2);
  font-family: var(--dv-ed-font, ui-monospace, monospace);
  font-size: 10.5px;
  line-height: 1.5;
  text-align: center;
  color: var(--dv-ui-text-2);
}

.row__action {
  margin: 0;
  flex: 1;
  font-size: 12px;
  line-height: 1.6;
  color: var(--dv-ui-text-2);
}

.panel__foot {
  padding: 10px 16px;
  border-top: 1px solid var(--dv-ui-line-soft);
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--dv-ui-text-dim);
}
</style>
