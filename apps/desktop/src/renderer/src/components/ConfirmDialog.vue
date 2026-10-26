<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'

/**
 * 通用确认对话框。
 *
 * 只做「问一句 + 三个以内选项」这一件事。需要更复杂内容的场景（冲突处理）
 * 各自有专用对话框，不硬塞进这里——通用组件的边界一旦模糊，就会长成一个万能弹窗。
 */
export interface ConfirmAction {
  id: string
  label: string
  /** primary = 主操作，danger = 破坏性操作 */
  tone?: 'primary' | 'danger' | 'ghost'
}

const props = defineProps<{
  open: boolean
  title: string
  message: string
  actions: ConfirmAction[]
}>()

const emit = defineEmits<{
  close: []
  choose: [id: string]
}>()

const panel = ref<HTMLElement | null>(null)

watch(
  () => props.open,
  async open => {
    if (!open) return
    await nextTick()
    // 焦点落到第一个按钮：键盘用户不必先 Tab 进来
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
  <div v-if="open" class="scrim" @click.self="emit('close')" @keydown="onKeydown">
    <div ref="panel" class="dialog" role="dialog" aria-modal="true" :aria-label="title">
      <h2 class="dialog__title">{{ title }}</h2>
      <p class="dialog__message">{{ message }}</p>
      <div class="dialog__actions">
        <button
          v-for="action in actions"
          :key="action.id"
          class="btn"
          :class="`btn--${action.tone ?? 'ghost'}`"
          type="button"
          @click="emit('choose', action.id)"
        >
          {{ action.label }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.scrim {
  position: fixed;
  inset: 0;
  z-index: 75;
  display: grid;
  place-items: center;
  background: color-mix(in srgb, var(--dv-ui-bg) 58%, transparent);
}

.dialog {
  width: min(440px, calc(100vw - 64px));
  padding: 20px;
  border: 1px solid var(--dv-ui-line);
  border-radius: var(--dv-ui-radius-md);
  background: var(--dv-ui-surface-2);
  box-shadow: var(--dv-ui-shadow-2);
}

.dialog__title {
  margin: 0 0 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--dv-ui-text);
}

.dialog__message {
  margin: 0 0 18px;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--dv-ui-text-muted);
  white-space: pre-wrap;
}

.dialog__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}

.btn {
  height: 30px;
  padding: 0 13px;
  border: 1px solid var(--dv-ui-line-soft);
  border-radius: var(--dv-ui-radius-sm);
  background: transparent;
  color: var(--dv-ui-text-2);
  font-size: 12px;
  cursor: pointer;
}

.btn--primary {
  background: var(--dv-ui-accent);
  border-color: transparent;
  color: var(--dv-ui-accent-fg);
}

.btn--danger {
  border-color: color-mix(in srgb, var(--dv-ui-danger) 45%, var(--dv-ui-line-soft));
  color: var(--dv-ui-danger);
}

.btn--ghost {
  border-color: transparent;
  color: var(--dv-ui-text-dim);
}

.btn:hover {
  background: var(--dv-ui-surface-3);
}

.btn--primary:hover {
  background: var(--dv-ui-accent-strong);
}
</style>
