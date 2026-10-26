import type { Directive } from 'vue'

/**
 * 全局 Tooltip 指令。
 *
 * 为什么不用原生 `title`：它由系统绘制——延迟约 1 秒、字号与配色不跟主题、
 * 不换行、无法同时显示「名称 + 说明」两行，而且会挡住相邻控件。同一个应用里
 * 一半是系统提示、一半是自绘浮层，观感很割裂。
 *
 * 为什么不引 UI 框架：这里需要的只是「悬停 400ms 后出现一个跟随主题的气泡」。
 * 引一个组件库为这一个能力付出整包体积与主题二次适配，不划算。
 *
 * 三条实现约束：
 *  1. **挂到 body + fixed 定位**：tooltip 常出现在 `overflow: hidden` 的容器里
 *     （标签条、状态栏、滚动区），作为子节点会被裁剪。
 *  2. **hover 与键盘焦点都要触发**：键盘用户同样看不到 title。
 *  3. **卸载时必须解绑**：列表项（目录树 / 标签）会频繁重建，漏解绑会累积监听器。
 */

export interface TooltipOptions {
  /** 主文案：动作名称 */
  text: string
  /** 次文案：一句话说明（可选）；与 text 合并成两行显示 */
  hint?: string
  placement?: 'top' | 'bottom'
  /** 触发延迟，缺省 380ms（比系统 title 快得多，但不会一闪而过） */
  delay?: number
}

type Binding = string | TooltipOptions

interface Attached {
  show: () => void
  hide: () => void
  destroy: () => void
  update: (next: Binding) => void
}

const attached = new WeakMap<HTMLElement, Attached>()

let tip: HTMLElement | null = null
let tipTimer: number | null = null
let owner: HTMLElement | null = null
/** 同一时刻只显示一个气泡：hover 到另一个元素时旧气泡必须立刻让位 */
let current: { text: string; hint?: string; placement?: 'top' | 'bottom' } | null = null

function element(): HTMLElement {
  if (tip) return tip
  tip = document.createElement('div')
  tip.className = 'dv-tip'
  tip.setAttribute('role', 'tooltip')
  document.body.appendChild(tip)
  return tip
}

function clearTimer(): void {
  if (tipTimer !== null) {
    window.clearTimeout(tipTimer)
    tipTimer = null
  }
}

function hide(): void {
  clearTimer()
  owner = null
  current = null
  if (tip) tip.classList.remove('is-open')
}

function place(target: HTMLElement, placement: 'top' | 'bottom'): void {
  const node = element()
  const rect = target.getBoundingClientRect()
  const width = node.offsetWidth
  const height = node.offsetHeight
  const margin = 8

  let top = placement === 'bottom' ? rect.bottom + 6 : rect.top - height - 6
  // 上边放不下就翻到下方；下方也放不下就夹在视口内
  if (top < margin) top = rect.bottom + 6
  if (top + height + margin > window.innerHeight) {
    top = Math.max(margin, window.innerHeight - height - margin)
  }
  const left = Math.min(
    Math.max(margin, rect.left + rect.width / 2 - width / 2),
    Math.max(margin, window.innerWidth - width - margin),
  )
  node.style.left = `${Math.round(left)}px`
  node.style.top = `${Math.round(top)}px`
}

function show(target: HTMLElement, config: NonNullable<typeof current>): void {
  const node = element()
  node.textContent = ''
  const main = document.createElement('span')
  main.className = 'dv-tip__text'
  main.textContent = config.text
  node.appendChild(main)
  if (config.hint) {
    const hint = document.createElement('span')
    hint.className = 'dv-tip__hint'
    hint.textContent = config.hint
    node.appendChild(hint)
  }
  node.classList.add('is-open')
  owner = target
  // 先量尺寸再定位：宽度依赖文本，必须等节点进 DOM 之后
  place(target, config.placement ?? 'top')
}

function readBinding(binding: Binding): {
  text: string
  hint?: string
  placement?: 'top' | 'bottom'
  delay?: number
} {
  if (typeof binding === 'string') return { text: binding }
  return binding
}

export const vTooltip: Directive<HTMLElement, Binding> = {
  mounted(el, binding) {
    let config = readBinding(binding.value)
    let timer: number | null = null

    // 元素自身已有 aria-label 时不覆盖；没有则用提示文案补上，读屏用户也能读到
    if (!el.hasAttribute('aria-label') && config.text) el.setAttribute('aria-label', config.text)

    const onEnter = (): void => {
      if (!config.text) return
      clearTimer()
      const delay = config.delay ?? 380
      timer = window.setTimeout(() => {
        timer = null
        if (owner && owner !== el) hide()
        current = { text: config.text, hint: config.hint, placement: config.placement }
        show(el, current)
      }, delay)
    }
    const onLeave = (): void => {
      if (timer !== null) {
        window.clearTimeout(timer)
        timer = null
      }
      if (owner === el) hide()
    }
    const onPress = (): void => {
      // 点击后气泡必须立刻消失：它常盖住刚打开的面板/菜单
      if (owner === el) hide()
    }

    const onScroll = (): void => {
      if (owner === el) hide()
    }

    el.addEventListener('mouseenter', onEnter)
    el.addEventListener('mouseleave', onLeave)
    el.addEventListener('focusin', onEnter)
    el.addEventListener('focusout', onLeave)
    el.addEventListener('mousedown', onPress)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)

    attached.set(el, {
      show: onEnter,
      hide: onLeave,
      destroy() {
        if (timer !== null) window.clearTimeout(timer)
        el.removeEventListener('mouseenter', onEnter)
        el.removeEventListener('mouseleave', onLeave)
        el.removeEventListener('focusin', onEnter)
        el.removeEventListener('focusout', onLeave)
        el.removeEventListener('mousedown', onPress)
        window.removeEventListener('scroll', onScroll, true)
        window.removeEventListener('resize', onScroll)
        if (owner === el) hide()
      },
      update(next) {
        config = readBinding(next)
        // 文案变了且气泡正显示着：直接换内容，避免「显示旧文案」
        if (owner === el) {
          current = { text: config.text, hint: config.hint, placement: config.placement }
          show(el, current)
        }
      },
    })
  },
  updated(el, binding) {
    attached.get(el)?.update(binding.value)
  },
  unmounted(el) {
    attached.get(el)?.destroy()
    attached.delete(el)
  },
}

/** 供验收脚本判断「气泡是否在显示」（不参与业务逻辑） */
export function activeTooltipText(): string | null {
  return current ? [current.text, current.hint].filter(Boolean).join(' · ') : null
}
