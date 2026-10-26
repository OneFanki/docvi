import { syntaxTree } from '@codemirror/language'
import { EditorSelection, type EditorState, type Extension } from '@codemirror/state'
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'

/**
 * 标题悬浮徽标（飞书手感）。
 *
 * 鼠标停在一行标题上时，行左侧浮出一个 `H1`…`H6` 小徽标；点它弹出
 * `正文 / H1 / H2 / H3` 菜单，选中后**改写原文的行首前缀**。
 *
 * 关键取舍：
 *  1. **绝对定位而不是 Decoration**：Decoration 会进入正文流，徽标占位会让
 *     文字左右跳动，而且每次移动鼠标都要重建装饰（还会触发撤销栈无关的重排）。
 *     这里徽标是挂在 `.cm-editor`（它自带 `position: relative`）下的普通 DOM 节点，
 *     只改 `left/top`，文本排版完全不动。
 *  2. **不改文档结构之外的任何东西**：切换级别只替换行首 `#{1,6}\s+`，
 *     正文一字不动，Markdown 原文仍是唯一事实源。
 *  3. **不抢编辑器焦点**：徽标与菜单项的 `mousedown` 都 `preventDefault`，
 *     点击不会把光标从正文里带走（与表格「编辑表格」按钮同一套做法）。
 *
 * 定位：`view.coordsAtPos(line.from)` 取行首的视口坐标，减去徽标宽度与间距；
 * 编辑器根节点上打 `data-lp-badge-host` 属性让 `.cm-content` 多留一点左内边距，
 * 保证窄窗口下徽标也有落点（不额外留白时徽标会被编辑器边界裁掉，或压到文字上）。
 *
 * ⚠️ 标记用 data 属性而不是 class：CM6 每次 `updateAttrs()` 都会整体重写
 * `.cm-editor` 的 `class`（`cm-editor cm-focused ͼ…`），追加的 class 会在第一次
 * 更新时被冲掉，表现为「样式规则莫名失效」。attribute 不会被重写。
 */

/** 菜单里给出的层级：够用即可，不必到 H6 */
const MENU_LEVELS: ReadonlyArray<{ level: number; label: string }> = [
  { level: 0, label: '正文' },
  { level: 1, label: 'H1' },
  { level: 2, label: 'H2' },
  { level: 3, label: 'H3' },
]

/** 徽标与行首之间的间距（px） */
const BADGE_GAP = 3

/** 某一行是几级标题；不是标题返回 0 */
function headingLevelAt(state: EditorState, pos: number): number {
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1)
  while (node) {
    const match = /^ATXHeading([1-6])$/.exec(node.name)
    if (match?.[1]) return Number(match[1])
    node = node.parent
  }
  return 0
}

export function headingBadge(): Extension {
  return ViewPlugin.fromClass(
    class {
      readonly view: EditorView
      readonly badge: HTMLButtonElement
      menu: HTMLElement | null = null
      /** 当前徽标对应的行首偏移；-1 = 当前没有徽标 */
      lineFrom = -1
      level = 0

      constructor(view: EditorView) {
        this.view = view
        // live 模式标记：CSS 靠它给 .cm-content 留出徽标空间
        view.dom.setAttribute('data-lp-badge-host', '')

        const badge = document.createElement('button')
        badge.type = 'button'
        badge.className = 'cm-lp-badge'
        badge.contentEditable = 'false'
        badge.tabIndex = -1
        badge.setAttribute('aria-label', '修改标题级别')
        badge.addEventListener('mousedown', this.onBadgeDown)
        badge.addEventListener('click', this.onBadgeClick)
        this.badge = badge
        view.dom.appendChild(badge)

        // mousemove 挂在编辑器根上：挂着正文上会在徽标/菜单上丢事件；
        // 用捕获阶段拿 scroll 是为了在滚动容器上也能收到（scroll 不冒泡）
        view.dom.addEventListener('mousemove', this.onMouseMove)
        view.dom.addEventListener('mouseleave', this.onMouseLeave)
        view.dom.addEventListener('focusout', this.onFocusOut)
        view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true })
      }

      update(update: ViewUpdate): void {
        // 文档变了：旧的行首偏移可能已经失效，先收起；鼠标下一动会重新判断
        if (update.docChanged) this.hideBadge()
        // 失焦（焦点移出编辑器）时也要收起：徽标只在「人正看着这段」时出现
        if (update.focusChanged && !update.view.hasFocus) this.hideBadge()
      }

      destroy(): void {
        this.closeMenu()
        this.view.dom.removeEventListener('mousemove', this.onMouseMove)
        this.view.dom.removeEventListener('mouseleave', this.onMouseLeave)
        this.view.dom.removeEventListener('focusout', this.onFocusOut)
        this.view.scrollDOM.removeEventListener('scroll', this.onScroll)
        this.badge.remove()
        this.view.dom.removeAttribute('data-lp-badge-host')
      }

      /* ---------- 鼠标定位 ---------- */

      onMouseMove = (event: MouseEvent): void => {
        const target = event.target as HTMLElement | null
        // 停在徽标或菜单上不算「离开标题行」，否则鼠标一挪到徽标就消失
        if (target?.closest('.cm-lp-badge, .cm-lp-badge-menu')) return
        if (this.menu) return

        const pos = this.view.posAtCoords({ x: event.clientX, y: event.clientY })
        if (pos === null) {
          this.hideBadge()
          return
        }
        const line = this.view.state.doc.lineAt(pos)
        const level = headingLevelAt(this.view.state, line.from)
        if (!level) {
          this.hideBadge()
          return
        }
        // 同一行不用重算 DOM，但滚轮/布局变化后坐标可能变，位置每次刷新。
        // 先上 is-visible 再定位：display:none 时 offsetWidth 恒为 0，
        // 会落到兜底宽度上，徽标与文字的间距随之偏大。
        this.lineFrom = line.from
        if (this.level !== level) {
          this.level = level
          this.badge.textContent = `H${level}`
        }
        this.badge.classList.add('is-visible')
        this.placeBadge()
      }

      onMouseLeave = (): void => {
        if (this.menu) return
        this.hideBadge()
      }

      onFocusOut = (event: FocusEvent): void => {
        // 焦点在编辑器内部移动（正文 → 别的可编辑区域）不算失焦
        const next = event.relatedTarget as Node | null
        if (next && this.view.dom.contains(next)) return
        this.hideBadge()
        this.closeMenu()
      }

      onScroll = (): void => {
        // 滚动后行首坐标全变了；与其逐帧重算，不如先收起，鼠标再动时自然出现
        this.hideBadge()
        this.closeMenu()
      }

      /* ---------- 徽标 → 菜单 ---------- */

      onBadgeDown = (event: MouseEvent): void => {
        // 关键：不让 mousedown 把焦点从正文挪到按钮上（否则点一下就丢光标）
        event.preventDefault()
        event.stopPropagation()
      }

      onBadgeClick = (event: MouseEvent): void => {
        event.preventDefault()
        event.stopPropagation()
        this.toggleMenu()
      }

      toggleMenu(): void {
        if (this.menu) {
          this.closeMenu()
          return
        }
        if (this.lineFrom < 0) return

        const menu = document.createElement('div')
        menu.className = 'cm-lp-badge-menu'
        menu.setAttribute('role', 'menu')
        for (const item of MENU_LEVELS) {
          const button = document.createElement('button')
          button.type = 'button'
          button.className = 'cm-lp-badge-menu__item'
          if (item.level === this.level) button.classList.add('is-current')
          button.dataset.level = String(item.level)
          button.textContent = item.label
          // 同样不抢焦点：菜单关闭后光标还在原来的正文位置
          button.addEventListener('mousedown', event => event.preventDefault())
          button.addEventListener('click', event => {
            event.preventDefault()
            this.applyLevel(item.level)
            this.closeMenu()
          })
          menu.appendChild(button)
        }
        document.body.appendChild(menu)
        this.menu = menu
        this.positionMenu()

        // 点外部关闭；用捕获阶段，避免被编辑器内部的 stopPropagation 截断
        document.addEventListener('mousedown', this.onDocumentDown, true)
        document.addEventListener('keydown', this.onDocumentKey, true)
      }

      closeMenu(): void {
        if (!this.menu) return
        this.menu.remove()
        this.menu = null
        document.removeEventListener('mousedown', this.onDocumentDown, true)
        document.removeEventListener('keydown', this.onDocumentKey, true)
      }

      onDocumentDown = (event: MouseEvent): void => {
        const target = event.target as HTMLElement | null
        if (target?.closest('.cm-lp-badge-menu, .cm-lp-badge')) return
        this.closeMenu()
      }

      onDocumentKey = (event: KeyboardEvent): void => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        this.closeMenu()
      }

      /* ---------- 改写原文 ---------- */

      /**
       * 把当前行改成目标级别（0 = 正文）。
       *
       * 只替换行首的 `#{1,6}\s+` 前缀，正文一个字都不动：
       *  - 一次 `view.dispatch` 内完成，撤销栈里只有一条记录；
       *  - 选区**手动按前缀长度差映射**（不用 `selection.map(change)`）。CM6 默认把
       *    「落在被替换区间内」的位置映射到插入内容的末尾，实际表现就是「光标跳到
       *    标题末尾」。这里按 delta 平移：正文里的位置原样保留，
       *    只有落在前缀内部的光标被夹到新前缀末尾。
       */
      applyLevel(level: number): void {
        if (this.lineFrom < 0 || this.lineFrom > this.view.state.doc.length) return
        const view = this.view
        const line = view.state.doc.lineAt(this.lineFrom)
        // 允许最多 3 个前导空格（Markdown 的缩进标题）：替换时保留缩进，
        // 只改 `#` 前缀本身，否则缩进会被吃掉、层级关系跟着变
        const prefix = /^([ \t]{0,3})(#{1,6}[ \t]+)/.exec(line.text)
        const indent = prefix?.[1] ?? ''
        const prefixFrom = line.from
        const prefixTo = line.from + (prefix ? prefix[0].length : 0)
        const next = level === 0 ? indent : `${indent}${'#'.repeat(level)} `
        if (prefix ? prefix[0] === next : next === '') return

        const delta = next.length - (prefixTo - prefixFrom)
        const mapPos = (pos: number): number => {
          if (pos <= prefixFrom) return pos
          if (pos >= prefixTo) return pos + delta
          return prefixFrom + next.length
        }
        const ranges = view.state.selection.ranges.map(range => ({
          anchor: mapPos(range.anchor),
          head: mapPos(range.head),
        }))

        view.dispatch({
          changes: { from: prefixFrom, to: prefixTo, insert: next },
          selection: EditorSelection.create(
            ranges.map(range => EditorSelection.range(range.anchor, range.head)),
            view.state.selection.mainIndex,
          ),
        })
        /*
         * 把焦点还给编辑器。
         *
         * 徽标与菜单都在编辑器 DOM 之外（菜单挂在 body 上），点完菜单后浏览器会把
         * 焦点留在那个按钮上；此时用户接着敲字什么都不会发生——看起来像「改完标题
         * 编辑器卡死了」。`focus()` 放在 dispatch 之后，光标位置就是我们映射过的那个。
         */
        view.focus()
        this.level = level
        if (level) this.badge.textContent = `H${level}`
        else this.hideBadge()
      }

      /* ---------- 定位 ---------- */

      placeBadge(): void {
        if (this.lineFrom < 0) return
        const coords = this.view.coordsAtPos(this.lineFrom)
        if (!coords) return
        const host = this.view.dom.getBoundingClientRect()
        const width = this.badge.offsetWidth || 22
        const height = this.badge.offsetHeight || 18
        // left/top 相对 `.cm-editor`（baseTheme 保证它是 position: relative）；
        // 再夹到 2px，极端窄窗口下也不会被裁成半个徽标
        const left = Math.max(2, coords.left - host.left - width - BADGE_GAP)
        const top = coords.top - host.top + (coords.bottom - coords.top - height) / 2
        this.badge.style.left = `${left}px`
        this.badge.style.top = `${top}px`
      }

      positionMenu(): void {
        if (!this.menu) return
        const anchor = this.badge.getBoundingClientRect()
        const width = this.menu.offsetWidth
        const height = this.menu.offsetHeight
        const margin = 8
        let left = anchor.left
        if (left + width > window.innerWidth - margin) {
          left = Math.max(margin, window.innerWidth - margin - width)
        }
        let top = anchor.bottom + BADGE_GAP
        // 下方放不下就翻到徽标上方
        if (top + height > window.innerHeight - margin) {
          top = Math.max(margin, anchor.top - height - BADGE_GAP)
        }
        this.menu.style.left = `${left}px`
        this.menu.style.top = `${top}px`
      }

      hideBadge(): void {
        this.badge.classList.remove('is-visible')
        this.lineFrom = -1
      }
    },
  )
}
