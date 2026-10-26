<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Check } from 'lucide-vue-next'

import { useI18n } from '../lib/i18n'
import type { ThemeOption } from '../lib/theme-options'

/**
 * 状态栏的主题下拉。
 *
 * 为什么是下拉而不是「点一下翻到另一套」：主题已经不止两套（插件可以带任意
 * 多套），「翻转」在 n 套主题下没有定义；而且翻转这个动作本身就是深浅二分的
 * 残留——用户想的是「我要换到那一套」，不是「我要反过来」。
 *
 * 为什么不用 ContextMenu：那里是纯文字命令（label + hint），主题项需要色板
 * 与选中勾，硬塞进去会把那一套通用菜单撑出一堆可选开关。
 *
 * 键盘：↑↓ 移动、Enter 选中、Esc 关闭；点外部或窗口 resize 关闭。
 * 定位：贴着按钮上沿展开（状态栏在底部，向下没有空间），右侧与按钮右缘对齐。
 */
const props = defineProps<{
  open: boolean
  /** 按钮的位置：菜单以它的上沿为基线向上展开 */
  anchor: { left: number; right: number; top: number } | null
  options: ThemeOption[]
  current: string
}>()

const emit = defineEmits<{
  close: []
  select: [id: string]
}>()

const { t } = useI18n()
const root = ref<HTMLElement | null>(null)
const cursor = ref(0)
const position = ref({ left: 0, bottom: 0 })

watch(
  () => props.open,
  async open => {
    if (!open) return
    const index = props.options.findIndex(item => item.id === props.current)
    cursor.value = index < 0 ? 0 : index
    await nextTick()
    place()
    root.value?.querySelector<HTMLElement>('[data-active="true"]')?.focus()
  },
)

/** 先按锚点右缘对齐，量出宽度后再夹进视口 */
function place(): void {
  const anchor = props.anchor
  const element = root.value
  if (!element) return
  const margin = 8
  const width = element.getBoundingClientRect().width
  const left = anchor
    ? Math.min(Math.max(margin, anchor.right - width), window.innerWidth - width - margin)
    : margin
  const bottom = anchor
    ? Math.max(margin, window.innerHeight - anchor.top + 6)
    : Math.max(margin, window.innerHeight - 40)
  position.value = { left, bottom }
}

function move(delta: number): void {
  const total = props.options.length
  if (!total) return
  cursor.value = (cursor.value + delta + total) % total
  void nextTick(() =>
    root.value?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({
      block: 'nearest',
    }),
  )
}

function choose(index = cursor.value): void {
  const option = props.options[index]
  if (!option) return
  emit('select', option.id)
  emit('close')
}

function onKeydown(event: KeyboardEvent): void {
  if (!props.open) return
  if (event.key === 'Escape') {
    event.preventDefault()
    emit('close')
  } else if (event.key === 'ArrowDown') {
    event.preventDefault()
    move(1)
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    move(-1)
  } else if (event.key === 'Enter') {
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

function onResize(): void {
  if (props.open) emit('close')
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown, true)
  window.addEventListener('mousedown', onPointerDown, true)
  window.addEventListener('resize', onResize)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown, true)
  window.removeEventListener('mousedown', onPointerDown, true)
  window.removeEventListener('resize', onResize)
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      ref="root"
      class="theme-menu"
      role="menu"
      :aria-label="t('status.chooseTheme')"
      :style="{ left: `${position.left}px`, bottom: `${position.bottom}px` }"
    >
      <button
        v-for="(option, index) in options"
        :key="option.id"
        class="theme-menu__item"
        :class="{ 'is-active': cursor === index }"
        type="button"
        role="menuitemradio"
        :aria-checked="option.id === current"
        :data-active="cursor === index"
        :tabindex="cursor === index ? 0 : -1"
        @click="choose(index)"
        @mouseenter="cursor = index"
      >
        <!-- 色板：两块叠色示意「窗口底 + 强调色」，一眼分得出深浅与冷暖 -->
        <span class="theme-menu__swatch" :data-appearance="option.appearance" aria-hidden="true">
          <span class="theme-menu__swatch-bar" />
        </span>
        <span class="theme-menu__label">{{ option.title }}</span>
        <span v-if="option.plugin" class="theme-menu__badge">{{ t('theme.badge') }}</span>
        <Check
          v-if="option.id === current"
          :size="13"
          :stroke-width="2.4"
          class="theme-menu__check"
          aria-hidden="true"
        />
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.theme-menu {
  position: fixed;
  z-index: 80;
  min-width: 208px;
  max-height: 60vh;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 4px;
  border: 1px solid var(--dv-ui-line);
  border-radius: var(--dv-ui-radius-md);
  background: var(--dv-ui-surface-2);
  box-shadow: var(--dv-ui-shadow-2);
}

.theme-menu__item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 9px;
  height: 30px;
  padding: 0 8px;
  border: none;
  border-radius: var(--dv-ui-radius-sm);
  background: transparent;
  color: var(--dv-ui-text-2);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.theme-menu__item.is-active {
  background: var(--dv-ui-surface-3);
  color: var(--dv-ui-text);
}

.theme-menu__swatch {
  flex: none;
  position: relative;
  width: 18px;
  height: 18px;
  border-radius: 4px;
  border: 1px solid var(--dv-ui-line);
  overflow: hidden;
}

.theme-menu__swatch[data-appearance='dark'] {
  background: #14161a;
}

.theme-menu__swatch[data-appearance='light'] {
  background: #f7f4ee;
}

/* 一根斜置的小色条，代表该主题的强调色方向 */
.theme-menu__swatch-bar {
  position: absolute;
  left: 3px;
  right: 3px;
  bottom: 4px;
  height: 3px;
  border-radius: 2px;
  background: linear-gradient(90deg, #d9a05b, #b8762f);
}

.theme-menu__swatch[data-appearance='light'] .theme-menu__swatch-bar {
  background: linear-gradient(90deg, #a8603a, #833d20);
}

.theme-menu__label {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.theme-menu__badge {
  flex: none;
  padding: 1px 5px;
  border-radius: 3px;
  background: var(--dv-ui-surface-3);
  color: var(--dv-ui-text-dim);
  font-size: 10px;
}

.theme-menu__check {
  flex: none;
  color: var(--dv-ui-accent);
}
</style>
