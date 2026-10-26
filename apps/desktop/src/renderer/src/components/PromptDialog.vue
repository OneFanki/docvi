<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'

import { useI18n } from '../lib/i18n'

/**
 * 单行输入框对话框：新建 / 重命名都用它。
 *
 * 为什么不复用 ConfirmDialog：那个组件只有按钮，没有输入位。把「输入 + 确认」
 * 硬塞进去会让它的 props 长出 `value / placeholder / validator`，从「问一句」
 * 变成一个小表单——边界一旦模糊就会继续长。
 *
 * 校验只做「非空 + 无路径分隔符」这一层，且**在本地先拦**：同名冲突只有主进程
 * 知道（要查磁盘），所以这里不预判，交给上层显示错误。
 */
const props = defineProps<{
  open: boolean
  title: string
  label: string
  /** 初始值（重命名时是原名，新建时为空） */
  initial: string
  /** 确认按钮文案 */
  confirmLabel: string
  /** 输入框后缀提示，例如 `.md` */
  suffix?: string
}>()

const emit = defineEmits<{
  confirm: [value: string]
  close: []
}>()

const { t } = useI18n()
const input = ref<HTMLInputElement | null>(null)
const value = ref('')
const invalid = ref('')

watch(
  () => props.open,
  async open => {
    if (!open) return
    value.value = props.initial
    invalid.value = ''
    await nextTick()
    const element = input.value
    if (!element) return
    element.focus()
    // 重命名时选中主干、保留扩展名：改名字不必重打 .md
    const dot = props.initial.lastIndexOf('.')
    if (dot > 0) element.setSelectionRange(0, dot)
    else element.select()
  },
)

function submit(): void {
  const raw = value.value.trim()
  if (!raw) {
    invalid.value = t('dialog.nameEmpty')
    return
  }
  if (/[/\\]/.test(raw)) {
    invalid.value = t('dialog.nameSlash')
    return
  }
  if (/[<>:"|?*]/.test(raw)) {
    invalid.value = t('dialog.nameInvalid')
    return
  }
  emit('confirm', raw)
}

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
    <div v-if="open" class="scrim" @mousedown.self="emit('close')" @keydown="onKeydown">
      <div class="dialog" role="dialog" aria-modal="true" :aria-label="title">
        <h2 class="dialog__title">{{ title }}</h2>
        <label class="dialog__row">
          <span class="dialog__label">{{ label }}</span>
          <span class="dialog__field">
            <input
              ref="input"
              v-model="value"
              class="dialog__input"
              type="text"
              autocomplete="off"
              spellcheck="false"
              @keydown.enter.prevent="submit"
              @input="invalid = ''"
            />
            <span v-if="suffix" class="dialog__suffix">{{ suffix }}</span>
          </span>
        </label>
        <p v-if="invalid" class="dialog__error" role="alert">{{ invalid }}</p>
        <div class="dialog__actions">
          <button class="btn btn--ghost" type="button" @click="emit('close')">
            {{ t('dialog.cancel') }}
          </button>
          <button class="btn btn--primary" type="button" @click="submit">
            {{ confirmLabel }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.scrim {
  position: fixed;
  inset: 0;
  z-index: 78;
  display: grid;
  place-items: center;
  background: color-mix(in srgb, var(--dv-ui-bg) 58%, transparent);
}

.dialog {
  width: min(400px, calc(100vw - 64px));
  padding: 20px;
  border: 1px solid var(--dv-ui-line);
  border-radius: var(--dv-ui-radius-md);
  background: var(--dv-ui-surface-2);
  box-shadow: var(--dv-ui-shadow-2);
}

.dialog__title {
  margin: 0 0 14px;
  font-size: 14px;
  font-weight: 600;
  color: var(--dv-ui-text);
}

.dialog__row {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.dialog__label {
  font-size: 11.5px;
  color: var(--dv-ui-text-muted);
}

.dialog__field {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 10px;
  border: 1px solid var(--dv-ui-line);
  border-radius: var(--dv-ui-radius-sm);
  background: var(--dv-ui-surface-1);
}

.dialog__field:focus-within {
  border-color: var(--dv-ui-accent);
}

.dialog__input {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  color: var(--dv-ui-text);
  font: inherit;
  font-size: 12.5px;
  outline: none;
}

.dialog__suffix {
  flex: none;
  font-size: 11.5px;
  color: var(--dv-ui-text-dim);
}

.dialog__error {
  margin: 8px 0 0;
  font-size: 11.5px;
  color: var(--dv-ui-danger);
}

.dialog__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 18px;
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

.btn--primary:hover {
  background: var(--dv-ui-accent-strong);
}

.btn--ghost {
  border-color: transparent;
  color: var(--dv-ui-text-dim);
}

.btn--ghost:hover {
  background: var(--dv-ui-surface-3);
}
</style>
