<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  Bold,
  Code,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link2,
  List,
  ListOrdered,
  Quote,
  Strikethrough,
} from 'lucide-vue-next'

import type { SelectionMarks } from '@docvi/editor'

/**
 * 选区气泡工具条。
 *
 * 只做「改文本语义」的最小集合，不做完整富文本工具栏——本项目的 Markdown 原文
 * 才是事实，工具条只是不让人背语法。
 *
 * 分三组（组间竖线）：**行内样式**（加粗/斜体/删除线/行内代码/链接）、
 * **行前缀**（无序列表/有序列表/引用）、**标题级别**（H1–H3）。用户心里是
 * 三件不同的事：把字变样子、把段落变结构、把段落变标题。
 *
 * 三个必须守住的细节：
 *  1. `mousedown.prevent`：按下瞬间不能让编辑器失焦，否则 selection 清空、气泡自己消失；
 *  2. 链接走两段式（先点链接按钮，再输 URL），不做系统弹窗——弹窗会打断心流，
 *     而且用户往往想从剪贴板粘 URL，输入框更顺手；
 *  3. **按钮要显示按下态**：选区已经在 `**加粗**` 里时加粗键必须亮着，否则用户
 *     无从判断「点了到底有没有生效」——实时预览把星号藏了，没法靠数符号自查。
 */
const props = defineProps<{
  /** 选区是否非空 */
  visible: boolean
  /** 选区上沿的屏幕坐标 */
  anchor: { left: number; top: number; bottom: number } | null
  /** 选区当前生效的格式；null = 未知（不显示任何按下态） */
  marks?: SelectionMarks | null
}>()

const emit = defineEmits<{
  bold: []
  italic: []
  strike: []
  code: []
  heading: [level: number]
  link: [url: string]
  /** 行前缀：无序列表 / 有序列表 / 引用 */
  prefix: [kind: 'bullet' | 'ordered' | 'quote']
}>()

const root = ref<HTMLElement | null>(null)
const linkMode = ref(false)
const url = ref('')
const urlInput = ref<HTMLInputElement | null>(null)
const position = ref({ left: 0, top: 0 })

const style = computed(() => ({ left: `${position.value.left}px`, top: `${position.value.top}px` }))

/** 按下态：`marks` 为空时全部为 false（未知不等于激活，宁可都不亮） */
function active(key: keyof SelectionMarks): boolean {
  return props.marks?.[key] === true
}

function headingActive(level: number): boolean {
  return props.marks?.heading === level
}

async function place(): Promise<void> {
  const anchor = props.anchor
  if (!anchor) return
  await nextTick()
  const width = root.value?.offsetWidth ?? 240
  const height = root.value?.offsetHeight ?? 32
  const margin = 8
  const left = Math.max(margin, Math.min(anchor.left, window.innerWidth - width - margin))
  // 一律贴着选区上方：贴下方会盖住接下来要读的正文
  const top = Math.max(margin, anchor.top - height - 8)
  position.value = { left, top }
}

watch(
  () => [props.visible, props.anchor?.left, props.anchor?.top] as const,
  () => {
    if (!props.visible) {
      linkMode.value = false
      url.value = ''
      return
    }
    void place()
  },
)

watch(linkMode, async open => {
  if (!open) return
  await nextTick()
  urlInput.value?.focus()
})

function startLink(): void {
  url.value = ''
  linkMode.value = true
}

function submitLink(): void {
  const value = url.value.trim()
  // 允许直接粘贴裸域名：补 https，省一步手动改
  const href = !value
    ? ''
    : /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('#') || value.startsWith('/')
      ? value
      : `https://${value}`
  linkMode.value = false
  url.value = ''
  if (href) emit('link', href)
}

function onRootMousedown(event: MouseEvent): void {
  // 输入框需要正常获得焦点；其余按钮按下时不能让编辑器失焦（失焦即选区清空、气泡消失）
  if ((event.target as HTMLElement | null)?.closest('input')) return
  event.preventDefault()
}

function onKeydown(event: KeyboardEvent): void {
  if (!props.visible || !linkMode.value) return
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    linkMode.value = false
    url.value = ''
  }
  if (event.key === 'Enter') {
    event.preventDefault()
    event.stopPropagation()
    submitLink()
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown, true))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown, true))
</script>

<template>
  <Teleport to="body">
    <div
      v-if="visible"
      ref="root"
      class="bubble"
      role="toolbar"
      aria-label="文本格式"
      :style="style"
      @mousedown="onRootMousedown"
    >
      <template v-if="linkMode">
        <input
          ref="urlInput"
          v-model="url"
          class="bubble__input"
          type="text"
          placeholder="粘贴或输入链接"
          spellcheck="false"
          @keydown.enter.prevent="submitLink"
          @keydown.esc.prevent="linkMode = false"
        />
        <button class="bubble__btn bubble__btn--text" type="button" @click="submitLink">
          确定
        </button>
      </template>

      <template v-else>
        <button
          v-tooltip="'加粗（Ctrl+B）'"
          class="bubble__btn"
          :class="{ 'is-active': active('bold') }"
          :aria-pressed="active('bold')"
          type="button"
          @click="emit('bold')"
        >
          <Bold :size="14" :stroke-width="2" />
        </button>
        <button
          v-tooltip="'斜体（Ctrl+I）'"
          class="bubble__btn"
          :class="{ 'is-active': active('italic') }"
          :aria-pressed="active('italic')"
          type="button"
          @click="emit('italic')"
        >
          <Italic :size="14" :stroke-width="2" />
        </button>
        <button
          v-tooltip="'删除线'"
          class="bubble__btn"
          :class="{ 'is-active': active('strike') }"
          :aria-pressed="active('strike')"
          type="button"
          @click="emit('strike')"
        >
          <Strikethrough :size="14" :stroke-width="2" />
        </button>
        <button
          v-tooltip="'行内代码'"
          class="bubble__btn"
          :class="{ 'is-active': active('code') }"
          :aria-pressed="active('code')"
          type="button"
          @click="emit('code')"
        >
          <Code :size="14" :stroke-width="2" />
        </button>
        <button
          v-tooltip="'链接'"
          class="bubble__btn"
          :class="{ 'is-active': active('link') }"
          :aria-pressed="active('link')"
          type="button"
          @click="startLink"
        >
          <Link2 :size="14" :stroke-width="2" />
        </button>

        <span class="bubble__sep" role="separator" />

        <button
          v-tooltip="'无序列表'"
          class="bubble__btn"
          :class="{ 'is-active': active('bullet') }"
          :aria-pressed="active('bullet')"
          type="button"
          @click="emit('prefix', 'bullet')"
        >
          <List :size="14" :stroke-width="2" />
        </button>
        <button
          v-tooltip="'有序列表'"
          class="bubble__btn"
          :class="{ 'is-active': active('ordered') }"
          :aria-pressed="active('ordered')"
          type="button"
          @click="emit('prefix', 'ordered')"
        >
          <ListOrdered :size="14" :stroke-width="2" />
        </button>
        <button
          v-tooltip="'引用'"
          class="bubble__btn"
          :class="{ 'is-active': active('quote') }"
          :aria-pressed="active('quote')"
          type="button"
          @click="emit('prefix', 'quote')"
        >
          <Quote :size="14" :stroke-width="2" />
        </button>

        <span class="bubble__sep" role="separator" />

        <button
          v-tooltip="'一级标题'"
          class="bubble__btn"
          :class="{ 'is-active': headingActive(1) }"
          :aria-pressed="headingActive(1)"
          type="button"
          @click="emit('heading', 1)"
        >
          <Heading1 :size="14" :stroke-width="2" />
        </button>
        <button
          v-tooltip="'二级标题'"
          class="bubble__btn"
          :class="{ 'is-active': headingActive(2) }"
          :aria-pressed="headingActive(2)"
          type="button"
          @click="emit('heading', 2)"
        >
          <Heading2 :size="14" :stroke-width="2" />
        </button>
        <button
          v-tooltip="'三级标题'"
          class="bubble__btn"
          :class="{ 'is-active': headingActive(3) }"
          :aria-pressed="headingActive(3)"
          type="button"
          @click="emit('heading', 3)"
        >
          <Heading3 :size="14" :stroke-width="2" />
        </button>
      </template>
    </div>
  </Teleport>
</template>

<style scoped>
.bubble {
  position: fixed;
  z-index: 90;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
  border: 1px solid var(--dv-ui-line);
  border-radius: var(--dv-ui-radius-md);
  background: var(--dv-ui-surface-2);
  box-shadow: var(--dv-ui-shadow-2);
}

.bubble__btn {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border: none;
  border-radius: var(--dv-ui-radius-sm);
  background: transparent;
  color: var(--dv-ui-text-2);
  cursor: pointer;
}

.bubble__btn:hover {
  background: var(--dv-ui-surface-3);
  color: var(--dv-ui-text);
}

/*
 * 按下态：选区已经在对应语法里时按钮必须亮着。
 *
 * 用主色底 + 主色文字而不是只加边框：工具条很小，细边框在 26px 的按钮上
 * 几乎看不出来，用户会继续以为「点了没生效」。
 */
.bubble__btn.is-active {
  background: color-mix(in srgb, var(--dv-ui-accent) 20%, transparent);
  color: var(--dv-ui-accent);
}

.bubble__btn.is-active:hover {
  background: color-mix(in srgb, var(--dv-ui-accent) 28%, transparent);
}

.bubble__btn--text {
  width: auto;
  padding: 0 9px;
  font-size: 11.5px;
}

.bubble__sep {
  width: 1px;
  height: 16px;
  margin: 0 3px;
  background: var(--dv-ui-line-soft);
}

.bubble__input {
  width: 190px;
  height: 26px;
  padding: 0 7px;
  border: 1px solid var(--dv-ui-line-soft);
  border-radius: var(--dv-ui-radius-sm);
  background: var(--dv-ui-bg);
  color: var(--dv-ui-text);
  font-size: 12px;
  outline: none;
}
</style>
