<script setup lang="ts">
/**
 * ImageLightbox —— 正文图片 / mermaid 图的大图查看（缩放 + 拖拽）。
 *
 * 文档正文的阅读列有宽度上限，宽图与密集图表在列内看不清细节；浏览器原生
 * 「在新标签打开图片」会丢掉阅读上下文（回来说不清看的是哪一篇）。这里给一个
 * 覆盖层：原图铺满视口、滚轮缩放、按住拖拽、一键适应与 100%。
 *
 * 为什么单独做成通用组件而不是各组件内部实现：mermaid 是渲染 pass 注入的 DOM、
 * 图片是 markdown 渲染出来的 `<img>`，两者都没有 Vue 组件边界。统一由阅读视图
 * 在**事件委托**里打开这一个覆盖层，行为只有一份。
 *
 * 无障碍：Esc 关闭；覆盖层 `role="dialog"` + `aria-modal`；打开时焦点移到关闭按钮。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'

import { useZoomPan } from './useZoomPan'
import ZoomBar from './ZoomBar.vue'

const props = defineProps<{
  open: boolean
  /** 图片来源：图片 URL，或 mermaid 渲染出的 SVG 字符串 */
  src: string | null
  /** `svg` 时 src 是 SVG 源码（mermaid 产物），不走 <img> */
  kind: 'image' | 'svg'
  /** 文件名 / 图题，用作标题与下载名 */
  title?: string
  /** 是否允许下载（mermaid 允许导出 SVG；跨域图片会被浏览器拦住，故默认关） */
  downloadable?: boolean
}>()

const emit = defineEmits<{ close: [] }>()

const viewportRef = ref<HTMLElement | null>(null)
const contentRef = ref<HTMLElement | null>(null)
const closeRef = ref<HTMLButtonElement | null>(null)
const { percent, dragging, style, fit, zoomBy, reset } = useZoomPan(viewportRef, contentRef, {
  min: 0.1,
  max: 8,
})

const svgMarkup = computed(() => (props.kind === 'svg' ? (props.src ?? '') : ''))

function close(): void {
  emit('close')
}

function onKeydown(event: KeyboardEvent): void {
  if (!props.open) return
  if (event.key === 'Escape') {
    event.preventDefault()
    close()
  }
}

/** 100%：把缩放复位到实际像素，而不是「适应视口」 */
function actualSize(): void {
  reset()
}

function download(): void {
  if (!props.downloadable || !props.src) return
  let href = props.src
  let revoke = false
  if (props.kind === 'svg') {
    href = URL.createObjectURL(new Blob([props.src], { type: 'image/svg+xml' }))
    revoke = true
  }
  const link = document.createElement('a')
  link.href = href
  link.download = `${props.title?.trim() || 'diagram'}.svg`
  link.click()
  if (revoke) URL.revokeObjectURL(href)
}

watch(
  () => props.open,
  async open => {
    if (open) {
      document.addEventListener('keydown', onKeydown)
      await nextTick()
      // 等图片拿到自然尺寸再适应：否则 fit 会按 0×0 算出 100%
      const img = contentRef.value?.querySelector('img')
      if (img && !img.complete) {
        await new Promise<void>(resolve => {
          img.addEventListener('load', () => resolve(), { once: true })
          img.addEventListener('error', () => resolve(), { once: true })
        })
      }
      fit()
      closeRef.value?.focus()
      return
    }
    document.removeEventListener('keydown', onKeydown)
  },
)

onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div
    v-if="open && src"
    class="lightbox"
    role="dialog"
    aria-modal="true"
    :aria-label="title || '查看大图'"
  >
    <header class="lightbox__head">
      <span class="lightbox__title">{{ title || '查看大图' }}</span>
      <ZoomBar :percent="percent" @zoom-in="zoomBy(1.2)" @zoom-out="zoomBy(1 / 1.2)" @fit="fit" />
      <button type="button" class="lightbox__btn" @click="actualSize">100%</button>
      <button
        v-if="downloadable && kind === 'svg'"
        type="button"
        class="lightbox__btn"
        @click="download"
      >
        下载 SVG
      </button>
      <button
        ref="closeRef"
        type="button"
        class="lightbox__btn lightbox__btn--close"
        aria-label="关闭大图"
        @click="close"
      >
        <svg
          viewBox="0 0 24 24"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </header>

    <div
      ref="viewportRef"
      class="lightbox__viewport"
      :class="{ 'is-dragging': dragging }"
      @click.self="close"
    >
      <div ref="contentRef" class="lightbox__content" :style="style">
        <!-- eslint-disable-next-line vue/no-v-html -- SVG 来自 mermaid 渲染产物，非用户输入 -->
        <div v-if="kind === 'svg'" class="lightbox__svg" v-html="svgMarkup" />
        <img v-else :src="src" :alt="title || ''" class="lightbox__img" draggable="false" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.lightbox {
  position: fixed;
  inset: 0;
  z-index: 1200;
  display: flex;
  flex-direction: column;
  background: color-mix(in srgb, var(--at-bg) 96%, transparent);
  backdrop-filter: blur(2px);
}

.lightbox__head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.9rem;
  border-bottom: 1px solid var(--at-border);
  background: var(--at-surface);
}

.lightbox__title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--at-text-2);
  font-size: 0.82rem;
}

.lightbox__btn {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 1.6rem;
  padding: 0 0.5rem;
  border: 1px solid var(--at-border);
  border-radius: var(--at-radius-sm);
  background: var(--at-bg);
  color: var(--at-text-2);
  font-size: 0.76rem;
  cursor: pointer;
}

.lightbox__btn:hover {
  border-color: var(--at-accent);
  color: var(--at-accent);
}

.lightbox__btn--close {
  width: 1.6rem;
  padding: 0;
}

.lightbox__viewport {
  flex: 1;
  min-height: 0;
  position: relative;
  overflow: hidden;
  cursor: grab;
  touch-action: none;
}

.lightbox__viewport.is-dragging {
  cursor: grabbing;
}

/*
 * 内容盒必须「按原尺寸排版、由 transform 缩放」：
 * 给 img 设 max-width 会让用户在放大后看到的仍是缩过的位图，白放大一场。
 */
.lightbox__content {
  transform-origin: 0 0;
  width: max-content;
}

.lightbox__img {
  display: block;
  /* 防止超大图在 100% 下把内存打爆：只做上限约束，不参与缩放计算 */
  max-width: none;
  user-select: none;
}

.lightbox__svg {
  display: block;
}

.lightbox__svg :deep(svg) {
  display: block;
  max-width: none !important;
  max-height: none !important;
}
</style>
