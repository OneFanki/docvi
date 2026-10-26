<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

/**
 * 通用上下文菜单。
 *
 * 为什么自己写而不引 UI 库：项目只需要「一组命令 + 键盘可达 + 点外部关闭」，
 * 引一个菜单库会带来定位引擎与主题适配两套额外成本。
 *
 * 键盘：↑↓ 移动、Enter 执行、Esc 关闭；打开时焦点进第一个可用项。
 * 定位：优先出现在点击点右下方，贴近视口边缘时向内翻转。
 */

export interface MenuItem {
  id: string
  label: string
  /** 右侧快捷键提示（纯展示） */
  hint?: string
  danger?: boolean
  disabled?: boolean
  /** 与前一项之间画分隔线 */
  separatorBefore?: boolean
}

const props = defineProps<{
  open: boolean
  x: number
  y: number
  items: MenuItem[]
}>()

const emit = defineEmits<{
  close: []
  select: [id: string]
}>()

const root = ref<HTMLElement | null>(null)
const cursor = ref(0)
/** 实际渲染坐标：先按点击点放，量出尺寸后再纠偏 */
const position = ref({ left: props.x, top: props.y })

watch(
  () => props.open,
  async open => {
    if (!open) return
    cursor.value = props.items.findIndex(item => !item.disabled)
    if (cursor.value < 0) cursor.value = 0
    position.value = { left: props.x, top: props.y }
    await nextTick()
    const element = root.value
    if (!element) return
    const rect = element.getBoundingClientRect()
    const margin = 8
    let left = props.x
    let top = props.y
    if (left + rect.width + margin > window.innerWidth)
      left = Math.max(margin, props.x - rect.width)
    if (top + rect.height + margin > window.innerHeight) {
      top = Math.max(margin, window.innerHeight - rect.height - margin)
    }
    position.value = { left, top }
    element.querySelector<HTMLElement>('[data-active="true"]')?.focus()
  },
)

function move(delta: number): void {
  if (!props.items.length) return
  let index = cursor.value
  for (let step = 0; step < props.items.length; step += 1) {
    index = (index + delta + props.items.length) % props.items.length
    if (!props.items[index]?.disabled) {
      cursor.value = index
      return
    }
  }
}

function choose(index = cursor.value): void {
  const item = props.items[index]
  if (!item || item.disabled) return
  emit('select', item.id)
  emit('close')
}

function onKeydown(event: KeyboardEvent): void {
  if (!props.open) return
  if (event.key === 'Escape') {
    event.preventDefault()
    emit('close')
    return
  }
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    move(1)
    return
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault()
    move(-1)
    return
  }
  if (event.key === 'Enter') {
    event.preventDefault()
    choose()
  }
}

function onPointerDown(event: MouseEvent): void {
  if (!props.open) return
  const target = event.target as Node | null
  if (target && root.value?.contains(target)) return
  emit('close')
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown, true)
  window.addEventListener('mousedown', onPointerDown, true)
  window.addEventListener('resize', () => emit('close'))
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown, true)
  window.removeEventListener('mousedown', onPointerDown, true)
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      ref="root"
      class="menu"
      role="menu"
      :style="{ left: `${position.left}px`, top: `${position.top}px` }"
    >
      <template v-for="(item, index) in items" :key="item.id">
        <div v-if="item.separatorBefore" class="menu__sep" role="separator" />
        <button
          class="menu__item"
          :class="{ 'is-danger': item.danger, 'is-active': cursor === index }"
          type="button"
          role="menuitem"
          :data-active="cursor === index"
          :disabled="item.disabled"
          :tabindex="cursor === index ? 0 : -1"
          @click="choose(index)"
          @mouseenter="!item.disabled && (cursor = index)"
        >
          <span class="menu__label">{{ item.label }}</span>
          <span v-if="item.hint" class="menu__hint">{{ item.hint }}</span>
        </button>
      </template>
    </div>
  </Teleport>
</template>

<style scoped>
.menu {
  position: fixed;
  z-index: 80;
  min-width: 196px;
  padding: 4px;
  border: 1px solid var(--dv-ui-line);
  border-radius: var(--dv-ui-radius-md);
  background: var(--dv-ui-surface-2);
  box-shadow: var(--dv-ui-shadow-2);
}

.menu__sep {
  height: 1px;
  margin: 4px 6px;
  background: var(--dv-ui-line-soft);
}

.menu__item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 12px;
  height: 28px;
  padding: 0 8px;
  border: none;
  border-radius: var(--dv-ui-radius-sm);
  background: transparent;
  color: var(--dv-ui-text-2);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.menu__item.is-active,
.menu__item:hover {
  background: var(--dv-ui-surface-3);
  color: var(--dv-ui-text);
}

.menu__item.is-danger {
  color: var(--dv-ui-danger);
}

.menu__item:disabled {
  opacity: 0.4;
  cursor: default;
  background: transparent;
}

.menu__label {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.menu__hint {
  flex: none;
  font-size: 10.5px;
  color: var(--dv-ui-text-dim);
}
</style>
