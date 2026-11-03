<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Check } from 'lucide-vue-next'

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
  /**
   * 勾选态（单选项用）：给定时这一项渲染成 `menuitemradio` + 左侧勾。
   *
   * 为什么放进通用菜单而不是另写一个下拉：勾选是**标准菜单能力**，
   * 与「色板」「开关」这类特定形态不同，塞进来不会把通用菜单撑歪。
   * 注意 `undefined` 与 `false` 有别——前者是普通命令项，后者是「未选中的单选项」，
   * 所以这里用 `!== undefined` 判断，不能用真值判断。
   */
  checked?: boolean
}

const props = defineProps<{
  open: boolean
  x: number
  y: number
  items: MenuItem[]
  /**
   * 触发按钮（下拉菜单用）。点在它上面不算「点外部」——否则 mousedown 会先把
   * 菜单关掉，紧接着的 click 又打开，第二次点触发按钮永远关不上。
   * 右键菜单不需要它，省略即可。
   */
  anchor?: HTMLElement | null
}>()

const emit = defineEmits<{
  close: []
  select: [id: string]
}>()

const root = ref<HTMLElement | null>(null)
const cursor = ref(0)
/** 实际渲染坐标：先按点击点放，量出尺寸后再纠偏 */
const position = ref({ left: props.x, top: props.y })

/**
 * 含单选项的菜单要**每一行都留出勾的位置**：只给选中行渲染图标会让未选行的
 * 提示文字左右跳一下，两行长度不齐看起来像没对齐。
 */
const isCheckable = computed(() => props.items.some(item => item.checked !== undefined))

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
    if (left + rect.width + margin > window.innerWidth) left = props.x - rect.width
    if (top + rect.height + margin > window.innerHeight) {
      top = window.innerHeight - rect.height - margin
    }
    /*
     * 最后统一夹进视口：视口窄到装不下菜单时，上面的翻转会算出负坐标，
     * 面板顶部被切掉、勾选行看不见。夹紧后至少从左上角露出来。
     */
    position.value = {
      left: Math.min(
        Math.max(margin, left),
        Math.max(margin, window.innerWidth - rect.width - margin),
      ),
      top: Math.min(
        Math.max(margin, top),
        Math.max(margin, window.innerHeight - rect.height - margin),
      ),
    }
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
  if (target && props.anchor?.contains(target)) return
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
          :role="item.checked === undefined ? 'menuitem' : 'menuitemradio'"
          :aria-checked="item.checked === undefined ? undefined : item.checked"
          :data-active="cursor === index"
          :disabled="item.disabled"
          :tabindex="cursor === index ? 0 : -1"
          @click="choose(index)"
          @mouseenter="!item.disabled && (cursor = index)"
        >
          <span class="menu__label">{{ item.label }}</span>
          <span v-if="item.hint" class="menu__hint">{{ item.hint }}</span>
          <Check
            v-if="item.checked"
            :size="13"
            :stroke-width="2.4"
            class="menu__check"
            aria-hidden="true"
          />
          <span v-else-if="isCheckable" class="menu__check" aria-hidden="true" />
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

/* 勾选标记放在行尾：与 ThemeMenu 的选中勾同一位置，两处菜单读起来是同一套 */
/* 定宽 13px = 图标尺寸：未选中的行用同宽空位占住，提示文字不会左右跳 */
.menu__check {
  flex: none;
  width: 13px;
  color: var(--dv-ui-accent);
}
</style>
