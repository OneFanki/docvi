/**
 * 分享页的图放大层（mermaid 全屏查看）。
 *
 * 桌面端用 Vue 组件 `ImageLightbox`；分享页没有 Vue，所以这里用原生 DOM 写一份
 * **行为对齐**的实现。两边能对齐的部分必须对齐——同一张图在应用里能放大看清、
 * 分享出去就只能看小图，是最直接的「两边不是同一个产品」。
 *
 * 对齐清单（与 plugins/base/src/components/ImageLightbox.vue 同口径）：
 *  - 根 `<svg>` 的 width 钉成 viewBox 实际尺寸：mermaid 写的是 `width="100%"`，
 *    放进 `width: max-content` 的容器后百分比失去参照，浏览器兜底成 300px，
 *    放大只会更糊（这是「大图查看看不清」的真正原因）；
 *  - 变换挂在 `<svg>` 自身而非包裹层：Chromium 对「HTML 层 transform + 内含 SVG」
 *    有绘制缺陷，`<rect>` 跟着缩放而 `<text>` 不跟，放大后框与字错位；
 *  - 滚轮以光标为锚点缩放；拖拽平移；Esc 关闭；点空白关闭（拖过不算）；
 *  - 变换原点固定左上角，缩放范围 0.1–8，「适应」允许缩到装下。
 *
 * 刻意简化：不做百分比读数与 100% 按钮（原生页面上按钮越少越好），保留
 * 「适应视口」入口的双击手势与滚轮主路径。
 */

import { diagramTitle } from '@docvi/renderer-core/mermaid'

/** 灯箱形态 */
interface LightboxState {
  root: HTMLElement
  viewport: HTMLElement
  svg: SVGSVGElement
  scale: number
  tx: number
  ty: number
}

const MIN_SCALE = 0.1
const MAX_SCALE = 8

let state: LightboxState | null = null
/** 当前灯箱的监听清理函数；关灯箱时一并摘掉 document 级监听 */
let cleanup: (() => void) | null = null

const clamp = (value: number): number => Math.min(MAX_SCALE, Math.max(MIN_SCALE, value))

/**
 * 把 viewBox 尺寸钉进 `<svg>` 的 width/height。
 *
 * 只在声明宽度不是绝对像素时才改（`100%` / `auto` / 空）：已经是具体像素值时
 * 保持原值，避免无意义的抖动。
 */
function pinSvgSize(svg: SVGSVGElement): void {
  const declared = svg.getAttribute('width')?.trim() ?? ''
  const isAbsolute = /^\d*\.?\d+$/.test(declared)
  const box = (svg.getAttribute('viewBox') ?? '')
    .trim()
    .split(/[\s,]+/)
    .map(Number)
  if (box.length !== 4) return
  const [, , vw, vh] = box
  if (vw === undefined || vh === undefined || !(vw > 0) || !(vh > 0)) return

  const width = isAbsolute ? Number.parseFloat(declared) : vw
  if (!Number.isFinite(width) || width <= 0) return
  svg.setAttribute('width', String(width))
  svg.setAttribute('height', String((width * vh) / vw))
  // 正文那条 max-width 会把钉好的宽度压回去
  svg.style.maxWidth = 'none'
}

function applyTransform(svg: SVGSVGElement): void {
  if (!state) return
  svg.style.transform = `translate(${state.tx}px, ${state.ty}px) scale(${state.scale})`
  svg.style.transformOrigin = '0 0'
}

/** 内容区尺寸（扣掉 padding，居中要按内容区算） */
function contentBox(el: HTMLElement): { w: number; h: number } {
  const style = getComputedStyle(el)
  const padX = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0)
  const padY = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0)
  return { w: el.clientWidth - padX, h: el.clientHeight - padY }
}

/** 缩放到刚好装下视口（内容比视口小时不放大——「适应」不是「填满」） */
function fit(svg: SVGSVGElement, viewport: HTMLElement): void {
  if (!state) return
  const box = contentBox(viewport)
  const cw = svg.getBoundingClientRect().width / state.scale
  const ch = svg.getBoundingClientRect().height / state.scale
  if (!(cw > 0) || !(ch > 0) || box.w < 80 || box.h < 80) {
    state.scale = 1
    state.tx = 0
    state.ty = 0
    applyTransform(svg)
    return
  }
  const padding = 24
  const scale = Math.min(1, clamp(Math.min((box.w - padding * 2) / cw, (box.h - padding * 2) / ch)))
  state.scale = scale
  const scaledW = cw * scale
  const scaledH = ch * scale
  // 装得下就居中，装不下的那一轴贴边（居中会把两头都挤出视口）
  state.tx = scaledW <= box.w - padding * 2 ? (box.w - scaledW) / 2 : padding
  state.ty = scaledH <= box.h - padding * 2 ? (box.h - scaledH) / 2 : padding
  applyTransform(svg)
}

function zoomAt(svg: SVGSVGElement, next: number, anchorX: number, anchorY: number): void {
  if (!state) return
  const target = clamp(next)
  if (target === state.scale) return
  const ratio = target / state.scale
  state.tx = anchorX - (anchorX - state.tx) * ratio
  state.ty = anchorY - (anchorY - state.ty) * ratio
  state.scale = target
  applyTransform(svg)
}

/** 生成灯箱 DOM 并挂上交互；返回关闭函数 */
function open(markup: string, title: string): void {
  if (state) close()

  const root = document.createElement('div')
  root.className = 'share-lightbox doc-surface'
  root.setAttribute('role', 'dialog')
  root.setAttribute('aria-modal', 'true')
  root.setAttribute('aria-label', title || '图表')
  /*
   * tabindex="-1"：容器要能接住程序化焦点。
   *
   * 焦点不能落在关闭按钮上——`<button>` 会响应空格/回车，用户在图上按空格
   * 想拖动，结果灯箱自己关了。焦点放在容器上，Esc 由 document 监听兜住，
   * Tab 仍能走到各个按钮。
   */
  root.tabIndex = -1

  const head = document.createElement('header')
  head.className = 'share-lightbox__head'

  const label = document.createElement('span')
  label.className = 'share-lightbox__title'
  label.textContent = title || '图表'

  const fitBtn = document.createElement('button')
  fitBtn.type = 'button'
  fitBtn.className = 'share-lightbox__btn'
  fitBtn.textContent = '适应'

  const downloadBtn = document.createElement('button')
  downloadBtn.type = 'button'
  downloadBtn.className = 'share-lightbox__btn'
  downloadBtn.textContent = '下载 SVG'

  const closeBtn = document.createElement('button')
  closeBtn.type = 'button'
  closeBtn.className = 'share-lightbox__btn share-lightbox__btn--close'
  closeBtn.setAttribute('aria-label', '关闭大图')
  closeBtn.textContent = '✕'

  head.append(label, fitBtn, downloadBtn, closeBtn)

  const viewport = document.createElement('div')
  viewport.className = 'share-lightbox__viewport'

  const content = document.createElement('div')
  content.className = 'share-lightbox__content'
  content.innerHTML = markup

  viewport.appendChild(content)
  root.append(head, viewport)
  document.body.appendChild(root)

  const svg = content.querySelector('svg')
  if (!svg) {
    root.remove()
    return
  }

  pinSvgSize(svg)
  state = { root, viewport, svg, scale: 1, tx: 0, ty: 0 }
  fit(svg, viewport)

  // ---- 交互 ----
  let pointerId = -1
  let startX = 0
  let startY = 0
  let originTx = 0
  let originTy = 0
  let moved = false
  let startedOnBackground = false

  const onWheel = (event: WheelEvent): void => {
    const next = state.scale * Math.exp(-event.deltaY * 0.0015)
    if (clamp(next) === state.scale) return
    event.preventDefault()
    const rect = viewport.getBoundingClientRect()
    zoomAt(svg, next, event.clientX - rect.left, event.clientY - rect.top)
  }

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return
    const target = event.target as Element | null
    if (target?.closest('button, a')) return
    startedOnBackground = !target?.closest('.share-lightbox__content')
    pointerId = event.pointerId
    startX = event.clientX
    startY = event.clientY
    originTx = state?.tx ?? 0
    originTy = state?.ty ?? 0
    moved = false
    viewport.classList.add('is-dragging')
    // 拖拽期间禁止选中文字（拖完满屏蓝底）
    document.body.style.userSelect = 'none'
    viewport.setPointerCapture(event.pointerId)
    event.preventDefault()
  }

  const onPointerMove = (event: PointerEvent): void => {
    if (!state || !viewport.classList.contains('is-dragging')) return
    if (event.pointerId !== pointerId) return
    const dx = event.clientX - startX
    const dy = event.clientY - startY
    if (!moved && Math.hypot(dx, dy) < 4) return
    moved = true
    state.tx = originTx + dx
    state.ty = originTy + dy
    applyTransform(svg)
  }

  const endDrag = (event: PointerEvent): void => {
    if (!viewport.classList.contains('is-dragging')) return
    if (event.pointerId !== pointerId) return
    pointerId = -1
    viewport.classList.remove('is-dragging')
    document.body.style.userSelect = ''
    if (viewport.hasPointerCapture(event.pointerId)) {
      viewport.releasePointerCapture(event.pointerId)
    }
  }

  /*
   * 点空白关闭的判据是**手势起点**而不是 click 的 target：指针捕获之后 target
   * 恒为 viewport，哪怕按在图上——只看 target 会让「双击图表」把灯箱关掉。
   */
  const onClick = (): void => {
    const isBackground = startedOnBackground && !moved
    startedOnBackground = false
    moved = false
    if (isBackground) closeLightbox()
  }

  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeLightbox()
    }
  }

  viewport.addEventListener('wheel', onWheel, { passive: false })
  viewport.addEventListener('pointerdown', onPointerDown)
  viewport.addEventListener('pointermove', onPointerMove)
  viewport.addEventListener('pointerup', endDrag)
  viewport.addEventListener('pointercancel', endDrag)
  viewport.addEventListener('click', onClick)
  document.addEventListener('keydown', onKeydown)

  fitBtn.addEventListener('click', () => {
    if (state) fit(svg, viewport)
  })
  downloadBtn.addEventListener('click', () => {
    const href = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' }))
    const link = document.createElement('a')
    link.href = href
    link.download = `${(title || 'diagram').trim()}.svg`
    link.click()
    URL.revokeObjectURL(href)
  })
  closeBtn.addEventListener('click', () => closeLightbox())

  // Esc 监听是 document 级的，必须随灯箱一起摘掉
  cleanup = () => {
    viewport.removeEventListener('wheel', onWheel)
    viewport.removeEventListener('pointerdown', onPointerDown)
    viewport.removeEventListener('pointermove', onPointerMove)
    viewport.removeEventListener('pointerup', endDrag)
    viewport.removeEventListener('pointercancel', endDrag)
    viewport.removeEventListener('click', onClick)
    document.removeEventListener('keydown', onKeydown)
    document.body.style.userSelect = ''
    root.remove()
  }

  root.focus()
}

function closeLightbox(): void {
  cleanup?.()
  cleanup = null
  state = null
}

/**
 * 给所有 mermaid 图挂上「全屏查看」按钮。
 *
 * 与桌面端完全同一套 DOM 约定（`.at-mermaid__expand` + `docvi-mermaid-expand`
 * 事件），样式也来自同一份 doc.css——分享页的按钮位置、悬停表现与应用内一致。
 */
export function bindMermaidExpand(host: HTMLElement): void {
  for (const holder of Array.from(host.querySelectorAll<HTMLElement>('.at-mermaid'))) {
    if (holder.querySelector('.at-mermaid__expand')) continue
    const svg = holder.querySelector('svg')
    if (!svg) continue

    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'at-mermaid__expand'
    button.setAttribute('aria-label', '全屏查看')
    button.title = '全屏查看'
    // 与 renderer-core 的 EXPAND_ICON 同形（maximize2）
    button.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>'

    button.addEventListener('click', () => {
      // 内部标识（flowchart-v2 等）翻成中文名，不把实现词露到标题上
      open(svg.outerHTML, diagramTitle(svg.getAttribute('aria-roledescription')))
    })
    holder.appendChild(button)
  }
}
