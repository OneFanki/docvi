import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Ref } from 'vue'

/**
 * useZoomPan —— 画布类组件的滚轮缩放 + 拖拽平移（流程图 / 状态机 / 表关系图共用）。
 *
 * 为什么不是滚动条（2026-10-19 用户反馈）：宽图在窄容器里用滚动条只能左右挪一屏，
 * 想「先看全貌再决定看哪块」做不到；滚轮缩放 + 拖拽是图形阅读的惯用手势。
 *
 * 约定：
 * - 视口 = `overflow: hidden` 的容器（viewportRef）；测量对象 = contentRef；
 * - 变换原点固定左上角（`transform-origin: 0 0`），平移/缩放都换算到视口坐标；
 * - 滚轮缩放以光标位置为锚点（光标下的那一点保持不动）；
 * - **已到缩放下限/上限时不再拦截滚轮**——否则鼠标停在图上就滚不动页面。
 *
 * ⚠️ 变换必须落在 **SVG 元素自身**，不能落在包裹它的 div 上：
 * Chromium 对「HTML 包裹层带 CSS transform + 内含 SVG」的组合有绘制缺陷——
 * `<text>` 的字形不跟随 transform 缩放，而 `<rect>` 会。实测 300% 下节点框放大 3 倍、
 * 文字仍按 100% 绘制（用户截图里「框小字大、完全错位」就是它）。
 * 把 transform 挂到 `<svg>` 上，文字与图形同层重新栅格化，任意倍率都清晰且对齐。
 * 纯 HTML 内容（表关系图）没有这个问题，直接把 style 绑在包裹层即可。
 */
export interface ZoomPanOptions {
  /** 最小缩放（缺省 0.35） */
  min?: number
  /** 最大缩放（缺省 3） */
  max?: number
  /**
   * 「适应」的可读下限（缺省 0 = 不设限）。
   *
   * 内容远大于视口时，纯「装下」会算出 40% 这类比例——图是完整了但字读不了。
   * 设为 0.6 后，fit 至少保留 60%，超出的部分交给拖拽/滚轮（本组件本来就支持平移）。
   * 图表类内容（小字 + 密集标注）必须给下限；纯色块类可以不给。
   *
   * 传函数表示下限随内容类型变化（灯箱里图片要「装下」、SVG 图不能比正文里更小）。
   */
  fitFloor?: number | (() => number)
}

export function useZoomPan(
  viewportRef: Ref<HTMLElement | null>,
  contentRef: Ref<HTMLElement | null>,
  options: ZoomPanOptions = {},
) {
  const min = options.min ?? 0.35
  const max = options.max ?? 3
  const floorOf = (): number =>
    typeof options.fitFloor === 'function' ? options.fitFloor() : (options.fitFloor ?? 0)
  const scale = ref(1)
  const tx = ref(0)
  const ty = ref(0)
  const dragging = ref(false)
  const percent = computed(() => Math.round(scale.value * 100))

  let pointerId = -1
  let startX = 0
  let startY = 0
  let originTx = 0
  let originTy = 0
  let moved = false
  let suppressClick = false
  /** 用户是否手动调整过（手动调整后窗口 resize 不再自动回中） */
  let touched = false

  const style = computed(() => ({
    transform: `translate(${tx.value}px, ${ty.value}px) scale(${scale.value})`,
    transformOrigin: '0 0',
  }))

  function clamp(value: number) {
    return Math.min(max, Math.max(min, value))
  }

  function zoomAt(next: number, anchorX: number, anchorY: number) {
    const target = clamp(next)
    if (target === scale.value) return
    const ratio = target / scale.value
    tx.value = anchorX - (anchorX - tx.value) * ratio
    ty.value = anchorY - (anchorY - ty.value) * ratio
    scale.value = target
    touched = true
  }

  /** 按视口尺寸把内容居中（缩放保持 1） */
  function reset() {
    const viewport = viewportRef.value
    const content = contentRef.value
    if (!viewport || !content) {
      tx.value = 0
      ty.value = 0
      return
    }
    scale.value = 1
    tx.value = Math.max(0, (viewport.clientWidth - content.offsetWidth) / 2)
    ty.value = Math.max(0, (viewport.clientHeight - content.offsetHeight) / 2)
    // 「回到默认」= 恢复自动跟随容器，不算手动调整
    touched = false
  }

  /**
   * 缩放到刚好装下（全屏时调用；超大图会缩到 min 为止）。
   *
   * `honorFloor = false` 用于「适应」按钮：用户点它就是要看全貌，此时可读下限
   * 该让位。打开时的自动适配保留下限——一进来就把图缩成看不清的比例，
   * 等于「大图查看」比正文还小。
   */
  function fit(padding = 24, honorFloor = true) {
    const viewport = viewportRef.value
    const content = contentRef.value
    if (!viewport || !content) return
    const cw = content.offsetWidth
    const ch = content.offsetHeight
    const vpW = viewport.clientWidth
    const vpH = viewport.clientHeight
    // 布局未就绪时**跳过**，不要用一个瞬态尺寸算缩放：
    // 内嵌宿主会把内容先按 0 / 极小宽度排一帧（实测 cw=30、vw=0），
    // 用它算出 30%（最小档）并覆盖了正确的 72%（2026-10-19 实测）。
    if (cw < 40 || ch < 40 || vpW < 80 || vpH < 80) return
    const vw = Math.max(0, vpW - padding * 2)
    const vh = Math.max(0, vpH - padding * 2)
    // ⚠️ 上限必须夹到 1：内容比视口窄时 vw/cw 会远大于 1，单看图宽会算出 116%，
    // 结果高度方向被裁掉（2026-10-19 实测）。「适应」的语义是「装下」，不是「填满」。
    // 下限 = fitFloor：装下所需比例低于可读阈值时，宁可装不下也要保住字。
    const computed = Math.min(1, clamp(Math.min(vw / cw, vh / ch)))
    scale.value = honorFloor ? Math.max(computed, Math.min(1, floorOf())) : computed
    // 装不下时不能居中（会把内容左半截挤到视口外），改为贴左上
    const fits = cw * scale.value <= vw && ch * scale.value <= vh
    tx.value = fits ? (vpW - cw * scale.value) / 2 : padding
    ty.value = fits ? (vpH - ch * scale.value) / 2 : padding
    // 程序自动适配**不算**手动调整：否则布局中间态算出的比例会被锁死，
    // ResizeObserver 之后再也不重算（2026-10-19 实测缩到 50% 而正确值是 72%）。
  }

  function zoomBy(factor: number) {
    const viewport = viewportRef.value
    if (!viewport) return
    zoomAt(scale.value * factor, viewport.clientWidth / 2, viewport.clientHeight / 2)
  }

  /** 直接设平移量（focusTable 这类「把某块拖到视口中心」的场景用） */
  function panTo(x: number, y: number) {
    tx.value = x
    ty.value = y
    touched = true
  }

  function onWheel(event: WheelEvent) {
    const viewport = viewportRef.value
    if (!viewport) return
    // Ctrl/⌘ + 滚轮是浏览器缩放，交给浏览器
    if (event.ctrlKey || event.metaKey) return
    const next = scale.value * Math.exp(-event.deltaY * 0.0015)
    const clamped = clamp(next)
    // 已到边界：不拦截，让页面正常滚动
    if (clamped === scale.value) return
    event.preventDefault()
    const rect = viewport.getBoundingClientRect()
    zoomAt(next, event.clientX - rect.left, event.clientY - rect.top)
  }

  /**
   * 拖拽期间禁止文本选中。
   *
   * 直接改 `document.body.style.userSelect`，不走「加一个 body class」：
   * 旧实现加的是 `.at-drag-lock`，而全仓**没有任何一条规则**定义它——
   * 类名加上去了、样式不存在，拖动照样选中一片文字，日志与报错一概没有。
   * 内联样式自己生效，不依赖某个样式表被谁引入。
   */
  let previousUserSelect = ''

  function lockSelection(lock: boolean): void {
    const body = document.body
    if (lock) {
      previousUserSelect = body.style.userSelect
      body.style.userSelect = 'none'
      return
    }
    body.style.userSelect = previousUserSelect
  }

  function onPointerDown(event: PointerEvent) {
    if (event.button !== 0) return
    const target = event.target as Element | null
    // 按钮、链接、页签等交互元素上不启动拖拽（否则点不动）
    if (target?.closest('button, a, input, select, textarea, [role="tab"]')) return
    const viewport = viewportRef.value
    if (!viewport) return
    lockSelection(true)
    pointerId = event.pointerId
    startX = event.clientX
    startY = event.clientY
    originTx = tx.value
    originTy = ty.value
    moved = false
    dragging.value = true
    // preventDefault 让浏览器不再把它当成选区的起点（触屏同理）
    event.preventDefault()
    viewport.setPointerCapture(event.pointerId)
  }

  function onPointerMove(event: PointerEvent) {
    if (!dragging.value || event.pointerId !== pointerId) return
    const dx = event.clientX - startX
    const dy = event.clientY - startY
    if (!moved && Math.hypot(dx, dy) < 4) return
    moved = true
    touched = true
    event.preventDefault()
    tx.value = originTx + dx
    ty.value = originTy + dy
  }

  function endDrag(event: PointerEvent) {
    if (!dragging.value || event.pointerId !== pointerId) return
    dragging.value = false
    pointerId = -1
    lockSelection(false)
    const viewport = viewportRef.value
    if (viewport?.hasPointerCapture(event.pointerId)) {
      viewport.releasePointerCapture(event.pointerId)
    }
    if (moved) suppressClick = true
  }

  /** 拖拽结束后的那次 click 不应落到节点/卡片上 */
  function onClickCapture(event: MouseEvent) {
    if (!suppressClick) return
    suppressClick = false
    event.stopPropagation()
    event.preventDefault()
  }

  let resizeObserver: ResizeObserver | null = null
  let retryTimers: number[] = []

  /** 当前挂过监听的那个元素：条件渲染下 viewport 会换，必须记住挂给了谁 */
  let boundViewport: HTMLElement | null = null

  function onWindowResize() {
    if (!touched) fit()
  }

  /**
   * 把监听挂到当前 viewport 上。
   *
   * 单独抽出来是因为**不能只在 onMounted 里挂**：灯箱这类组件的根节点带
   * `v-if="open"`，组件本身却常驻挂载——挂载那一刻 viewport 还不存在，
   * onMounted 里 `if (!viewport) return` 会把滚轮与拖拽监听全部跳过，
   * 结果是覆盖层能打开、但缩放和拖拽完全没反应（实测就是这个症状）。
   */
  function bind(): void {
    const viewport = viewportRef.value
    if (!viewport || viewport === boundViewport) return
    unbind()
    boundViewport = viewport
    viewport.addEventListener('wheel', onWheel, { passive: false })
    viewport.addEventListener('pointerdown', onPointerDown)
    viewport.addEventListener('pointermove', onPointerMove)
    viewport.addEventListener('pointerup', endDrag)
    viewport.addEventListener('pointercancel', endDrag)
    viewport.addEventListener('click', onClickCapture, true)
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        // 用户没动过缩放/平移时跟随容器重新适配；动过就保留意图
        if (!touched) fit()
      })
      resizeObserver.observe(viewport)
    }
    // ⚠️ ResizeObserver 在部分内嵌宿主里**完全不回调**（实测 IAB 面板内 0 次触发），
    // window resize 是唯一可靠的容器尺寸变化信号，两条都挂上。
    window.addEventListener('resize', onWindowResize)
    // 初始状态「先看全貌」：内容超出视口时缩到装下（不放大超过 100%）。
    // 旧行为是 100% 居中裁切——长流程图一进来就只看得到中间一段（2026-10-19 实测）。
    //
    // ⚠️ 必须重复几次：挂载时内层 SVG 的 width/height 尚未应用，offsetHeight 读到
    // 的是中间态（实测 1148 而终值 799）。viewport 尺寸不变，ResizeObserver 兜不住。
    // ⚠️ 且**不能用 rAF 做延时**：内嵌浏览器面板不可见时 rAF 可能完全不推进
    // （本库 TableGraph 也踩过），要用真正会跑的 setTimeout。
    fit()
    for (const delay of [0, 60, 200, 600]) {
      const timer = window.setTimeout(() => {
        if (!touched) fit()
      }, delay)
      retryTimers.push(timer)
    }
  }

  function unbind(): void {
    const viewport = boundViewport
    if (!viewport) return
    viewport.removeEventListener('wheel', onWheel)
    viewport.removeEventListener('pointerdown', onPointerDown)
    viewport.removeEventListener('pointermove', onPointerMove)
    viewport.removeEventListener('pointerup', endDrag)
    viewport.removeEventListener('pointercancel', endDrag)
    viewport.removeEventListener('click', onClickCapture, true)
    window.removeEventListener('resize', onWindowResize)
    resizeObserver?.disconnect()
    resizeObserver = null
    for (const timer of retryTimers) window.clearTimeout(timer)
    retryTimers = []
    boundViewport = null
  }

  // viewport 是模板里刚渲染出来的 DOM：等本轮 DOM 更新后再取
  watch(viewportRef, () => bind())

  onMounted(bind)

  onBeforeUnmount(unbind)

  return { scale, percent, dragging, style, reset, fit, zoomBy, zoomAt, panTo }
}
