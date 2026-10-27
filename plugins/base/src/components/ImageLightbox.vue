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
import { pinSize } from './svg-size'
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
const {
  percent,
  dragging,
  style,
  fit: fitZoom,
  zoomBy,
  reset,
} = useZoomPan(viewportRef, contentRef, {
  min: 0.1,
  max: 8,
  /*
   * 图表不能比正文里更小：正文里的 mermaid 是按内容宽度完整排版的，
   * 一进大图就被「装下」压到 85% 会**比刚才还难读**——那正是用户说的
   * 「大图查看看不清」。这里给 100% 下限，装不下就交给拖拽与滚轮。
   * 图片（位图）不设下限：照片装得下才是重点。
   */
  fitFloor: () => (props.kind === 'svg' ? 1 : 0),
})

/** 「适应」按钮：用户明确要看全貌，可读下限让位 */
function fit(): void {
  fitZoom(24, false)
}

const svgMarkup = computed(() => (props.kind === 'svg' ? (props.src ?? '') : ''))

/**
 * mermaid 产物把根 `<svg>` 写成 `width="100%"`（配 `max-width: 原宽px`）。
 *
 * 这在正文里是对的——跟随阅读列自适应。但放进灯箱的 `width: max-content`
 * 容器后，百分比宽度失去可参照的包含块，浏览器回落到 SVG 的初始值 300px：
 * 800×949 的图被排成 300×356，再被「适应」放大，字糊成一团（实测就是这个）。
 *
 * 所以打开时把宽度**钉成 viewBox 的实际尺寸**，让「100%」变成确定值。
 */
function pinSvgSize(): void {
  const svg = contentRef.value?.querySelector('svg')
  if (!svg) return
  const box = svg.getAttribute('viewBox')
  const size = pinSize(svg.getAttribute('width'), box)
  if (!size) return
  svg.setAttribute('width', String(size.width))
  svg.setAttribute('height', String(size.height))
  // 正文那条 max-width 会把钉好的宽度压回去，必须清掉
  svg.style.maxWidth = 'none'
  /*
   * 变换必须落在 `<svg>` 自身，不能落在 HTML 包裹层：Chromium 对「HTML 包裹层
   * 带 transform + 内含 SVG」有绘制缺陷——`<rect>` 跟着缩放、`<text>` 不跟，
   * 放大后框和字完全错位（useZoomPan 顶部注释里有完整记录）。
   */
  svg.style.transform = style.value.transform
  svg.style.transformOrigin = style.value.transformOrigin
}

// 开着灯箱时换了图源（连点两张图）：重新钉尺寸并适配，否则沿用上一张的比例
watch(
  () => props.src,
  async () => {
    if (!props.open) return
    await nextTick()
    pinSvgSize()
    await nextTick()
    fitZoom()
  },
)

// 缩放/平移变化时同步到 SVG 自身
watch(style, value => {
  const svg = contentRef.value?.querySelector('svg')
  if (!svg) return
  svg.style.transform = value.transform
  svg.style.transformOrigin = value.transformOrigin
})

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
      // SVG 先钉死尺寸再算适应：百分比宽度在 max-content 容器里没有参照
      pinSvgSize()
      await nextTick()
      fitZoom()
      closeRef.value?.focus()
      return
    }
    document.removeEventListener('keydown', onKeydown)
  },
)

onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown))
</script>

<template>
  <!--
    `doc-surface` 是必需类名，不是装饰：组件配色用的 `--at-*` / `--dv-c-*`
    token 只在 `.doc-surface` 上定义（见 renderer-core 的 theme.css）。灯箱挂在
    阅读滚动容器的**兄弟节点**上，不声明的后果是所有颜色变量都是 undefined——
    背景变透明、正文从底下透出来，按钮边框与文字色也全部失效。
  -->
  <div
    v-if="open && src"
    class="lightbox doc-surface"
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
      <!--
        SVG 的变换挂在 svg 自身（见 pinSvgSize 与 useZoomPan 顶部注释），
        所以包裹层只对位图应用 transform；两层都挂会缩放两次。
      -->
      <div ref="contentRef" class="lightbox__content" :style="kind === 'svg' ? undefined : style">
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
  /*
   * 顶部让出窗口按钮带，**铺满其余全部窗口**。
   *
   * 窗口按钮由系统画在标题栏那一条上：Windows 在右上（最小化/最大化/关闭），
   * macOS 在左上（红绿灯）。灯箱要是不让位，自己的功能按钮就落进同一条带里
   * ——最右那个关闭按钮会被窗口的 ✕ 盖住，点下去关的是窗口而不是大图。
   *
   * 让位方式是把**头栏**下移一个标题栏高度，而不是把整个覆盖层往下缩：
   * 后者会让应用标题栏（搜索框、面板开关）浮在大图上方，全屏看图时非常割裂。
   * 现在覆盖层仍铺满全窗，顶部那条带只有系统按钮，没有我们的控件。
   */
  padding-top: var(--at-overlay-top, 0px);
  /*
   * 必须完全不透明。
   *
   * 旧实现是「96% 底色 + backdrop-filter: blur(2px)」——那层模糊只在 4% 的
   * 空隙里起作用，结果正文与侧栏在图表背后糊成一片灰影，读图时始终有一层
   * 干扰纹理（mermaid 图尤其明显：图形本身就是细线稿）。大图查看的前提是
   * 眼睛只看这一张图，所以这里用实底。
   */
  background: var(--at-bg);
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
  /* 拖拽是这里的主动作，任何位置都不该出选区（拖完满屏蓝底） */
  user-select: none;
}

.lightbox__img {
  display: block;
  /* 防止超大图在 100% 下把内存打爆：只做上限约束，不参与缩放计算 */
  max-width: none;
  user-select: none;
  -webkit-user-drag: none;
}

.lightbox__svg {
  display: block;
}

.lightbox__svg :deep(svg) {
  display: block;
  max-width: none !important;
  max-height: none !important;
  /*
   * 变换由脚本写在 svg 自身（Chromium 下 svg 文字不跟随 HTML 包裹层缩放）。
   * 这里只声明变换原点，与脚本的 transform 配合。
   */
  transform-origin: 0 0;
  user-select: none;
}
</style>
