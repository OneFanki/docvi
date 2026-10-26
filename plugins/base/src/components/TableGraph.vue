<script setup lang="ts">
/**
 * TableGraph —— 表关系图：分层表卡 + 外键连线（替代会绞线的 mermaid erDiagram）。
 *
 * 场景：讲清「多张表怎么连起来」但**不列全量字段**。布局用依赖深度分层解决
 * mermaid 的「乱」：引用方在左、被引用方在右（列 = 依赖深度），连线只从左往右流、
 * 不会来回绞合；每张表只放关键字段（主键 / 外键 / 唯一 / 状态 / 幂等键…）。
 *
 * 连线（本组件的核心）：
 * - 每条关系画成 SVG 贝塞尔线，锚点**连到具体字段行**（引用方外键行右缘 → 被引用字段行左缘），
 *   线头带箭头；线中点标注关系语义；
 * - **标签防遮挡**：放不下时先折行（最多两行，CJK 逐字/拉丁整词平衡断行）；折行也放不下
 *   的长标签随连线改走「绕行走廊」（从列间空隙垂直进出、在上下方空档横穿）——标签永不压到表卡上；
 * - 悬停表卡：与该表相关的连线全部高亮、无关表卡淡出；
 * - 悬停/聚焦连线：只高亮该条，并高亮两端表卡与对应字段行（整条链路同时可见）；
 * - 点击连线：跳到被引用表卡并短暂高亮（长页里不用四处找）；
 * - 右上角全屏（兜底逻辑与 TableTabs 共用 ./fullscreen）。
 *
 * 与邻近组件分工：字段全量、一表一页签用 <TableTabs>（§10），本组件是它的「关系概览版」。
 * 表极少且关系单一时 erDiagram 仍可用；表多/关系密时本组件是确定性的替代。
 *
 * 用法（Markdown）：页面 script setup 里定义 tables / relations，正文写
 *
 * <TableGraph title="订单系统表关系" :tables="tables" :relations="relations" />
 *
 * 数据协议见 types.ts：
 *   GraphTable    = { id, name, cn?, note?, fields?: GraphField[] }
 *   GraphField    = { name, cn?, type?, key? }        // TableField 子集：只列关键字段
 *   GraphRelation = { from, to, fromField?, toField?, label?, kind? }
 *   // from = 引用方（持有外键的表），to = 被引用表；一条关系展示为 from.fromField → to.toField
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useFullscreen } from './fullscreen'
import { useZoomPan } from './useZoomPan'
import ZoomBar from './ZoomBar.vue'
import type { GraphRelation, GraphTable } from './types'

const props = withDefaults(
  defineProps<{
    /** 表卡列表（关键字段，不列全量） */
    tables: GraphTable[]
    /** 表间关系（from = 引用方，to = 被引用表） */
    relations?: GraphRelation[]
    /** 标题（可选） */
    title?: string
  }>(),
  { relations: () => [], title: '' },
)

const tableById = computed(() => {
  const map = new Map<string, GraphTable>()
  for (const table of props.tables) map.set(table.id, table)
  return map
})

/**
 * 依赖深度分层：depth(表) = 它到「不再引用别人的表」的最长引用链长度。
 * 引用方在左（depth 大）、被引用方在右（depth 0）——连线天然只从左往右流。
 * 循环引用在深度计算处断环（布局不卡死；连线照画，走绕行走廊）。
 */
const columns = computed<GraphTable[][]>(() => {
  const ids = props.tables.map(table => table.id)
  const idSet = new Set(ids)
  const outMap = new Map<string, string[]>()
  for (const relation of props.relations) {
    if (!idSet.has(relation.from) || !idSet.has(relation.to) || relation.from === relation.to)
      continue
    const list = outMap.get(relation.from)
    if (list) list.push(relation.to)
    else outMap.set(relation.from, [relation.to])
  }
  const memo = new Map<string, number>()
  const visiting = new Set<string>()
  const depth = (id: string): number => {
    const cached = memo.get(id)
    if (cached !== undefined) return cached
    if (visiting.has(id)) return 0
    visiting.add(id)
    let value = 0
    for (const to of outMap.get(id) ?? []) value = Math.max(value, 1 + depth(to))
    visiting.delete(id)
    memo.set(id, value)
    return value
  }
  const maxDepth = ids.reduce((acc, id) => Math.max(acc, depth(id)), 0)
  const cols: GraphTable[][] = []
  for (let level = maxDepth; level >= 0; level -= 1) {
    const tables = ids
      .filter(id => depth(id) === level)
      .map(id => tableById.value.get(id))
      .filter((table): table is GraphTable => Boolean(table))
    if (tables.length) cols.push(tables)
  }
  return cols
})

// ── 标签折行（估算宽度：CJK/全角按一个字号宽，拉丁约 0.56 字号） ──
const LABEL_FONT_SIZE = 11

function charWidth(ch: string): number {
  const code = ch.codePointAt(0) ?? 0
  const wide =
    (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0x3000 && code <= 0x303f) ||
    (code >= 0x2190 && code <= 0x21ff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xffef)
  return wide ? LABEL_FONT_SIZE : LABEL_FONT_SIZE * 0.56
}

function textWidth(text: string): number {
  let width = 0
  for (const ch of text) width += charWidth(ch)
  return width
}

/** 折行到最多两行（token 化后枚举断点，选最平衡且两行都放得下的解）；放不下返回 null */
function wrapLabel(text: string, maxWidth: number): string[] | null {
  if (textWidth(text) <= maxWidth) return [text]
  const tokens = text.match(/[A-Za-z0-9_./:+-]+|[\s\S]/g) ?? []
  if (tokens.length < 2) return null
  let best: { lines: string[]; imbalance: number; firstLonger: number } | null = null
  for (let cut = 1; cut < tokens.length; cut += 1) {
    const head = tokens.slice(0, cut).join('').trim()
    const tail = tokens.slice(cut).join('').trim()
    if (!head || !tail) continue
    const headWidth = textWidth(head)
    const tailWidth = textWidth(tail)
    if (headWidth > maxWidth || tailWidth > maxWidth) continue
    const candidate = {
      lines: [head, tail],
      imbalance: Math.abs(headWidth - tailWidth),
      firstLonger: headWidth > tailWidth ? 1 : 0,
    }
    if (
      !best ||
      candidate.imbalance < best.imbalance ||
      (candidate.imbalance === best.imbalance && candidate.firstLonger < best.firstLonger)
    ) {
      best = candidate
    }
  }
  return best ? best.lines : null
}

// ── 全屏（兜底逻辑与 TableTabs 共用） ──
const rootRef = ref<HTMLElement | null>(null)
const { isFullscreen, overlay, toggle: toggleFullscreen } = useFullscreen(rootRef)

// ── 缩放与拖拽（表多/关系密时比滚动条好用：先看全貌再拖到局部） ──
const canvasRef = ref<HTMLElement | null>(null)
const stageRef = ref<HTMLElement | null>(null)
const {
  scale,
  percent,
  dragging,
  style,
  fit,
  reset: resetZoom,
  zoomBy,
  panTo,
} = useZoomPan(stageRef, canvasRef, { min: 0.3, max: 2.5, fitFloor: 0.62 })

// ── 测量与连线几何 ──
const cardRefs = new Map<string, HTMLElement>()
const rowRefs = new Map<string, HTMLElement>()

function registerCard(id: string, el: unknown) {
  if (el instanceof HTMLElement) cardRefs.set(id, el)
  else cardRefs.delete(id)
}

function registerRow(id: string, field: string, el: unknown) {
  const key = `${id}:${field}`
  if (el instanceof HTMLElement) rowRefs.set(key, el)
  else rowRefs.delete(key)
}

interface EdgeGeom {
  index: number
  d: string
  arrow: string
  labelX: number
  labelY: number
  labelFirstDy: number
  labelLines: string[]
  title: string
  to: string
}

/**
 * 视口高度跟随内容（封顶由 CSS max-height 负责）：表多时固定高度只会把图压小。
 *
 * ⚠️ 全屏 / 覆盖层下必须**返回空对象**：内联 height 的优先级高于 CSS 类，
 * 会让 `:fullscreen .at-tablegraph__stage { height: auto }` 失效——舞台停在
 * 「正文态内容高度」而不再吃满剩余空间，超出部分被 overflow:hidden 裁掉
 * （用户实测：全屏后底部一排表卡被切）。全屏时高度交给 flex: 1 决定。
 */
const stageStyle = computed(() =>
  isFullscreen.value ? {} : { height: `${Math.ceil(Math.max(320, canvasSize.value.h + 32))}px` },
)

const edgesGeom = ref<EdgeGeom[]>([])
const canvasSize = ref({ w: 0, h: 0 })
let resizeObserver: ResizeObserver | null = null
let measureFrame = 0

function scheduleMeasure() {
  if (typeof window === 'undefined') return
  // 同步测一次（此时布局已可用）：不能只排 rAF 任务——隐藏/后台环境（实测内置
  // 浏览器面板隐藏时、以及嵌入式无合成环境）rAF 可能完全不推进，只依赖 rAF
  // 会让连线永不出现。rAF 的双帧只作后续微调（字体/列宽变化后的重排）。
  measure()
  cancelAnimationFrame(measureFrame)
  measureFrame = requestAnimationFrame(() => {
    measureFrame = requestAnimationFrame(measure)
  })
}

/** 圆角折线：points 为拐点序列，拐角处用二次贝塞尔倒角（半径按相邻段长收缩） */
function roundedPath(points: Array<[number, number]>, radius = 8): string {
  if (points.length < 2) return ''
  const first = points[0]
  const last = points[points.length - 1]
  if (!first || !last) return ''
  let d = `M ${first[0]} ${first[1]}`
  for (let i = 1; i < points.length - 1; i += 1) {
    const prev = points[i - 1]
    const cur = points[i]
    const next = points[i + 1]
    if (!prev || !cur || !next) continue
    const [px, py] = prev
    const [cx, cy] = cur
    const [nx, ny] = next
    const lenIn = Math.hypot(cx - px, cy - py) || 1
    const lenOut = Math.hypot(nx - cx, ny - cy) || 1
    const r = Math.min(radius, lenIn / 2, lenOut / 2)
    const inX = cx - ((cx - px) / lenIn) * r
    const inY = cy - ((cy - py) / lenIn) * r
    const outX = cx + ((nx - cx) / lenOut) * r
    const outY = cy + ((ny - cy) / lenOut) * r
    d += ` L ${inX} ${inY} Q ${cx} ${cy} ${outX} ${outY}`
  }
  d += ` L ${last[0]} ${last[1]}`
  return d
}

/**
 * 关系 → 连线几何。
 * - 相邻列且标签放得下（单行或折两行）→ 列间空隙的 S 形贝塞尔（锚点连到字段行）；
 * - 其余（跨列 / 同列 / 标签太长）→「绕行走廊」：从列间空隙垂直进出、
 *   在上/下方空档横穿（圆角折线），保证与任何表卡不相交；同侧多条按序错开车道。
 */
function measure() {
  const canvas = canvasRef.value
  if (!canvas) return
  // ⚠️ 坐标空间必须统一到**未缩放的布局坐标**：
  // 画布外层带 `transform: scale()`，`getBoundingClientRect()` 返回的是**屏幕坐标**
  // （已被缩放）。旧版直接把屏幕差值当 SVG 坐标用，0.43 倍缩放下所有连线与箭头
  // 都被压缩到 43%，锚点全部错位（2026-10-19 用户截图实测）。
  // 这里统一除以当前 scale，换算回 SVG 使用的布局坐标；SVG 尺寸本身取 offsetWidth。
  const scaleFactor = scale.value || 1
  const toLocal = (value: number) => value / scaleFactor
  canvasSize.value = { w: canvas.offsetWidth, h: canvas.offsetHeight }
  const cRect = canvas.getBoundingClientRect()

  interface CardRect {
    left: number
    right: number
    top: number
    bottom: number
    width: number
  }
  const cardRects = new Map<string, CardRect>()
  let minTop = Number.POSITIVE_INFINITY
  let maxBottom = Number.NEGATIVE_INFINITY
  for (const [id, el] of cardRefs) {
    const r = el.getBoundingClientRect()
    const rect = {
      left: toLocal(r.left - cRect.left),
      right: toLocal(r.right - cRect.left),
      top: toLocal(r.top - cRect.top),
      bottom: toLocal(r.bottom - cRect.top),
      width: toLocal(r.width),
    }
    cardRects.set(id, rect)
    minTop = Math.min(minTop, rect.top)
    maxBottom = Math.max(maxBottom, rect.bottom)
  }
  const centerY = (minTop + maxBottom) / 2
  const lanes = { top: 0, bottom: 0 }
  // 列隙通道：同一列隙里多条走廊线按序错开垂直进出位置——共用同一竖段会
  // 重叠成像一条线，指向变得难辨（用户反馈点）；左下键=引用方卡右缘，右缘键=被引用方卡左缘
  const leftChannels = new Map<number, number>()
  const rightChannels = new Map<number, number>()

  const next: EdgeGeom[] = []
  props.relations.forEach((relation, index) => {
    if (relation.from === relation.to) return
    const fromEl = cardRefs.get(relation.from)
    const toEl = cardRefs.get(relation.to)
    const fromCard = cardRects.get(relation.from)
    const toCard = cardRects.get(relation.to)
    if (!fromEl || !toEl || !fromCard || !toCard) return
    const fromRow = relation.fromField
      ? rowRefs.get(`${relation.from}:${relation.fromField}`)
      : undefined
    const toRow = relation.toField ? rowRefs.get(`${relation.to}:${relation.toField}`) : undefined
    const fromAnchor = (fromRow ?? fromEl).getBoundingClientRect()
    const toAnchor = (toRow ?? toEl).getBoundingClientRect()

    const x1 = fromCard.right
    const y1 = toLocal(fromAnchor.top + fromAnchor.height / 2 - cRect.top)
    const x2 = toCard.left + 1
    const y2 = toLocal(toAnchor.top + toAnchor.height / 2 - cRect.top)

    const pair = `${relation.from}.${relation.fromField ?? '*'} → ${relation.to}.${relation.toField ?? '*'}`
    const label =
      relation.label ??
      `${relation.fromField ?? relation.from} → ${relation.toField ?? relation.to}`
    const title =
      relation.kind === 'logical'
        ? `${pair}（逻辑引用）${relation.label ? ` · ${relation.label}` : ''}`
        : `${pair}${relation.label ? ` · ${relation.label}` : ''}`

    const gap = toCard.left - fromCard.right
    const direct = gap >= 20 && gap <= 120
    const wrapped = direct ? wrapLabel(label, gap - 12) : null

    let d: string
    let labelX: number
    let labelY: number
    let labelLines: string[]
    if (direct && wrapped) {
      const dx = x2 - x1
      const c1x = x1 + dx * 0.45
      const c2x = x1 + dx * 0.55
      d = `M ${x1} ${y1} C ${c1x} ${y1} ${c2x} ${y2} ${x2 - 7} ${y2}`
      labelX = 0.125 * x1 + 0.375 * c1x + 0.375 * c2x + 0.125 * (x2 - 7)
      labelY = (y1 + y2) / 2
      labelLines = wrapped
    } else {
      const side: 'top' | 'bottom' = (y1 + y2) / 2 <= centerY ? 'top' : 'bottom'
      const slot = Math.min(lanes[side], 2)
      lanes[side] += 1
      const laneY = side === 'top' ? minTop - 14 - slot * 17 : maxBottom + 14 + slot * 17
      const corridorSpan = x2 - x1
      if (corridorSpan >= 40) {
        // 走廊垂直进出位置按通道错开，且**贴列隙边缘**（卡缘出来 6+7k px 就转弯）：
        // 直连线的起点/终点段在边缘处近乎水平，竖线与之形成干净的 90° 十字；
        // 若通道落在列隙中部，直连线在那里已开始缓弯，两条线会平行贴行、指向难辨（用户反馈点）
        const half = corridorSpan / 2
        const leftKey = Math.round(x1)
        const rightKey = Math.round(x2)
        const lc = leftChannels.get(leftKey) ?? 0
        leftChannels.set(leftKey, lc + 1)
        const rc = rightChannels.get(rightKey) ?? 0
        rightChannels.set(rightKey, rc + 1)
        const mx = Math.min(x1 + 6 + lc * 7, x1 + half - 5)
        const nx = Math.max(x2 - 13 - rc * 7, x1 + half + 5)
        d = roundedPath([
          [x1, y1],
          [mx, y1],
          [mx, laneY],
          [nx, laneY],
          [nx, y2],
          [x2 - 7, y2],
        ])
        labelX = (mx + nx) / 2
        labelY = side === 'top' ? laneY - 5 : laneY + 13
      } else {
        // 同列 / 回边（罕见）：下方贝塞尔兜底
        const dipY = Math.max(y1, y2) + 52 + slot * 17
        d = `M ${x1} ${y1} C ${x1 + 70} ${dipY} ${x2 - 70} ${dipY} ${x2 - 7} ${y2}`
        labelX = (x1 + x2) / 2
        labelY = dipY + 4
      }
      labelLines = [label]
    }
    labelLines = labelLines.filter(line => line.trim() !== '')
    next.push({
      index,
      d,
      arrow: `${x2},${y2} ${x2 - 8},${y2 - 4.5} ${x2 - 8},${y2 + 4.5}`,
      labelX,
      labelY,
      labelFirstDy: labelLines.length > 1 ? -6.5 : 0,
      labelLines,
      title,
      to: relation.to,
    })
  })
  edgesGeom.value = next
}

// ── 悬停 / 聚焦状态：卡片、连线、字段行联动高亮 ──
const hoveredTable = ref('')
const hoveredEdge = ref(-1)

const activeEdgeIndexes = computed(() => {
  const set = new Set<number>()
  props.relations.forEach((relation, index) => {
    if (hoveredEdge.value >= 0) {
      if (index === hoveredEdge.value) set.add(index)
      return
    }
    if (
      hoveredTable.value &&
      (relation.from === hoveredTable.value || relation.to === hoveredTable.value)
    ) {
      set.add(index)
    }
  })
  return set
})

const anyActive = computed(() => activeEdgeIndexes.value.size > 0)

const linkedTables = computed(() => {
  const set = new Set<string>()
  for (const index of activeEdgeIndexes.value) {
    const relation = props.relations[index]
    if (relation) {
      set.add(relation.from)
      set.add(relation.to)
    }
  }
  return set
})

const linkedRows = computed(() => {
  const set = new Set<string>()
  for (const index of activeEdgeIndexes.value) {
    const relation = props.relations[index]
    if (!relation) continue
    if (relation.fromField) set.add(`${relation.from}:${relation.fromField}`)
    if (relation.toField) set.add(`${relation.to}:${relation.toField}`)
  }
  return set
})

/**
 * 字段名按 `_` 切段，模板里在段间插 `<wbr>`：只给下划线处的断行机会，
 * 避免 `overflow-wrap: anywhere` 把 local_preprocessing_enabled 断成
 * `local_preprocessing_enabl / ed`（2026-10-19 用户实测）。段尾保留下划线，
 * join 后与原字段名逐字符一致。
 */
function nameParts(name: string): string[] {
  return String(name).match(/[^_]+_*|_+/g) ?? [String(name)]
}

function edgeClass(index: number) {
  if (hoveredEdge.value === index) return 'is-active'
  if (anyActive.value) return activeEdgeIndexes.value.has(index) ? 'is-active' : 'is-dim'
  return ''
}

/** 点击连线：跳到被引用表卡并短暂高亮 */
const flashId = ref('')
let flashTimer: number | undefined

function focusTable(id: string) {
  const el = cardRefs.get(id)
  if (!el) return
  // 缩放平移后 scrollIntoView 无意义：把目标卡片的中心拖到视口中心
  const stage = stageRef.value
  const canvas = canvasRef.value
  if (stage && canvas) {
    const card = el.getBoundingClientRect()
    const view = stage.getBoundingClientRect()
    // 先在缩放坐标系里算出卡片中心相对于内容原点的位置
    const cx = (card.left + card.width / 2 - view.left) / scale.value
    const cy = (card.top + card.height / 2 - view.top) / scale.value
    panTo(view.width / 2 - cx * scale.value, view.height / 2 - cy * scale.value)
  }
  flashId.value = id
  window.clearTimeout(flashTimer)
  flashTimer = window.setTimeout(() => {
    flashId.value = ''
  }, 1400)
}

onMounted(async () => {
  await nextTick()
  scheduleMeasure()
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => scheduleMeasure())
    if (canvasRef.value) resizeObserver.observe(canvasRef.value)
  }
  window.addEventListener('resize', scheduleMeasure)
  if (typeof document !== 'undefined' && 'fonts' in document) {
    void document.fonts.ready.then(() => scheduleMeasure()).catch(() => {})
  }
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  window.removeEventListener('resize', scheduleMeasure)
  cancelAnimationFrame(measureFrame)
  window.clearTimeout(flashTimer)
})

watch(
  () => [props.tables, props.relations],
  () => {
    void nextTick(scheduleMeasure)
  },
  { deep: true },
)

// 全屏 / 覆盖层切换后画布可用空间变化：重测连线并重新适配
watch(isFullscreen, value => {
  void nextTick(() => {
    scheduleMeasure()
    if (value) fit()
    else resetZoom()
  })
})
</script>

<template>
  <section
    ref="rootRef"
    class="at-tablegraph"
    :class="{ 'is-overlay': overlay }"
    :aria-label="title || '表关系图'"
  >
    <header class="at-tablegraph__head">
      <span class="at-tablegraph__title">{{ title || '表关系图' }}</span>
      <span class="at-tablegraph__meta">{{ tables.length }} 表 · {{ relations.length }} 关系</span>
      <ZoomBar :percent="percent" @zoom-in="zoomBy(1.2)" @zoom-out="zoomBy(1 / 1.2)" @fit="fit" />
      <button
        type="button"
        class="at-tablegraph__fs"
        :aria-pressed="isFullscreen"
        :aria-label="isFullscreen ? '退出全屏' : '全屏查看'"
        @click="toggleFullscreen"
      >
        <svg
          viewBox="0 0 24 24"
          width="13"
          height="13"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <template v-if="!isFullscreen">
            <path d="M8 3H5a2 2 0 0 0-2 2v3" />
            <path d="M16 3h3a2 2 0 0 1 2 2v3" />
            <path d="M8 21H5a2 2 0 0 1-2-2v-3" />
            <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
          </template>
          <template v-else>
            <path d="M8 3v3a2 2 0 0 1-2 2H3" />
            <path d="M16 3v3a2 2 0 0 0 2 2h3" />
            <path d="M8 21v-3a2 2 0 0 0-2-2H3" />
            <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
          </template>
        </svg>
        {{ isFullscreen ? '退出全屏' : '全屏' }}
      </button>
    </header>

    <div
      v-if="tables.length"
      ref="stageRef"
      class="at-tablegraph__stage"
      :class="{ 'is-dragging': dragging }"
      :style="stageStyle"
    >
      <div ref="canvasRef" class="at-tablegraph__canvas" :style="style">
        <div class="at-tablegraph__cols">
          <div
            v-for="(column, columnIndex) in columns"
            :key="columnIndex"
            class="at-tablegraph__col"
          >
            <article
              v-for="table in column"
              :key="table.id"
              :ref="el => registerCard(table.id, el)"
              class="at-tablegraph__card"
              :class="{
                'is-dim': anyActive && !linkedTables.has(table.id),
                'is-linked': anyActive && linkedTables.has(table.id),
                'is-flash': flashId === table.id,
              }"
              @mouseenter="hoveredTable = table.id"
              @mouseleave="hoveredTable = ''"
            >
              <div class="at-tablegraph__cardhead">
                <code class="at-tablegraph__name">{{ table.name }}</code>
                <span v-if="table.cn" class="at-tablegraph__cn">{{ table.cn }}</span>
              </div>
              <p v-if="table.note" class="at-tablegraph__note">{{ table.note }}</p>

              <ul v-if="table.fields?.length" class="at-tablegraph__fields">
                <li
                  v-for="(field, fieldIndex) in table.fields"
                  :key="fieldIndex"
                  :ref="el => registerRow(table.id, field.name, el)"
                  :data-field="field.name"
                  class="at-tablegraph__field"
                  :class="{ 'is-linked': linkedRows.has(`${table.id}:${field.name}`) }"
                >
                  <code class="at-tablegraph__fname"
                    ><template v-for="(part, partIndex) in nameParts(field.name)" :key="partIndex"
                      >{{ part
                      }}<wbr v-if="partIndex < nameParts(field.name).length - 1" /></template
                  ></code>
                  <span v-if="field.cn" class="at-tablegraph__fcn">{{ field.cn }}</span>
                  <span v-if="field.type" class="at-tablegraph__ftype">{{ field.type }}</span>
                  <span v-if="field.key" class="at-tablegraph__fkey">{{ field.key }}</span>
                </li>
              </ul>
            </article>
          </div>
        </div>

        <svg
          v-if="edgesGeom.length"
          class="at-tablegraph__edges"
          :width="canvasSize.w"
          :height="canvasSize.h"
          :viewBox="`0 0 ${canvasSize.w} ${canvasSize.h}`"
          :aria-label="`${relations.length} 条表间关系`"
        >
          <g
            v-for="edge in edgesGeom"
            :key="edge.index"
            class="at-tablegraph__edge"
            :class="edgeClass(edge.index)"
            tabindex="0"
            role="img"
            :aria-label="edge.title"
            @mouseenter="hoveredEdge = edge.index"
            @mouseleave="hoveredEdge = -1"
            @focus="hoveredEdge = edge.index"
            @blur="hoveredEdge = -1"
            @click="focusTable(edge.to)"
          >
            <title>{{ edge.title }}</title>
            <path class="at-tablegraph__hit" :d="edge.d" />
            <path class="at-tablegraph__line" :d="edge.d" />
            <polygon class="at-tablegraph__arrow" :points="edge.arrow" />
            <text
              v-if="edge.labelLines.length"
              class="at-tablegraph__elabel"
              :x="edge.labelX"
              :y="edge.labelY"
              text-anchor="middle"
            >
              <tspan
                v-for="(line, lineIndex) in edge.labelLines"
                :key="lineIndex"
                :x="edge.labelX"
                :dy="lineIndex === 0 ? edge.labelFirstDy : 13"
              >
                {{ line }}
              </tspan>
            </text>
          </g>
        </svg>
      </div>
    </div>
    <p v-else class="at-tablegraph__empty">（未提供 tables 数据）</p>
  </section>
</template>

<style scoped>
.at-tablegraph {
  margin: 1rem 0;
  border: 1px solid var(--at-border);
  border-radius: var(--at-radius-lg);
  background: var(--at-surface);
  overflow: hidden;
}

.at-tablegraph:fullscreen,
.at-tablegraph.is-overlay {
  display: flex;
  flex-direction: column;
  /* 覆盖层用 fixed + inset 定高：正文态的 margin: 1rem 0 会再从 inset 里扣掉
     上下各 1rem，容器比视口矮 2rem；原生全屏由 UA 归零，这里统一写死 */
  margin: 0;
  border: none;
  border-radius: 0;
}

.at-tablegraph:fullscreen {
  height: 100%;
}

.at-tablegraph.is-overlay {
  position: fixed;
  inset: 3vh 4vw;
  z-index: 1000;
  border: 1px solid var(--at-border);
  border-radius: var(--at-radius-lg);
  box-shadow: var(--at-shadow);
}

.at-tablegraph:fullscreen .at-tablegraph__stage,
.at-tablegraph.is-overlay .at-tablegraph__stage {
  flex: 1 1 auto;
  min-height: 0;
  height: auto;
  /* max-height 不覆盖会把舞台封顶在正文态的 78vh：flex:1 只撑到上限为止，
     下方留出一条纯底色空白，和后移走网格之前是同一个症状 */
  max-height: none;
  overflow: hidden;
}

.at-tablegraph__head {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.5rem 0.9rem;
  border-bottom: 1px solid var(--at-border);
}

.at-tablegraph__title {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--at-text-muted);
  letter-spacing: 0.02em;
}

.at-tablegraph__meta {
  margin-left: auto;
  color: var(--at-text-muted);
  font-size: 0.76rem;
  font-variant-numeric: tabular-nums;
}

.at-tablegraph__fs {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.2rem 0.55rem;
  border: 1px solid var(--at-border);
  border-radius: var(--at-radius-sm);
  background: var(--at-bg);
  color: var(--at-text-2);
  font-size: 0.78rem;
  cursor: pointer;
  transition:
    border-color 0.12s ease,
    color 0.12s ease;
}

.at-tablegraph__fs:hover {
  border-color: var(--at-accent);
  color: var(--at-accent);
}

/* 舞台：固定视口高度，内容 transform 缩放平移（滚轮 + 拖拽，见 useZoomPan）。
   旧版 overflow-x:auto 只能左右挪一屏；表多关系密时「先看全貌」做不到（用户反馈）。 */
/* 高度由内容决定（模板绑 stageStyle），max-height 封顶在 78vh——
   固定高度的视口会让表一多就整体缩到 40%，字读不了（2026-10-19 用户反馈）。 */
.at-tablegraph__stage {
  position: relative;
  height: clamp(320px, 62vh, 700px);
  max-height: 78vh;
  overflow: hidden;
  cursor: grab;
  touch-action: none;
  /* 网格不画在舞台上：全屏时舞台吃满剩余高度，比画布高出来的部分会铺满网格
     却没有任何卡片，看着像「底部有一块区域没渲染」。网格属于图纸——画在画布上
     随缩放一起走，舞台只留纯底色。 */
  background: var(--at-graph-canvas);
}

.at-tablegraph__stage.is-dragging {
  cursor: grabbing;
}

.at-tablegraph__canvas {
  position: relative;
  /* 图纸网格：随 transform 一起缩放，格子跟着图走 */
  background: radial-gradient(circle at 1px 1px, var(--at-graph-grid) 1px, transparent 0) 0 0 / 22px
    22px;
  background-color: var(--at-graph-canvas);
  /* width 必须给 100%：写 max-content 时块级子元素 .at-tablegraph__cols 会收缩到
     内容宽（19rem×2 + 间距），flex-grow 没有剩余空间可分，列宽永远停在 19rem、
     右侧留一段空白（2026-10-19 实测）。
     min-width 只锁 100%：窄视口优先让两列收缩到各自 min-width，而不是整图横向
     滚动把第二列藏到视口外（只有两列都到下限时才出滚动条）。 */
  width: 100%;
  min-width: 100%;
  /* 拖拽画布时不要选中卡片文字 */
  user-select: none;
  /* 上下留出绕行走廊（跨列/长标签连线的车道走在这里），左右 0.95rem 与表卡内边距对齐 */
  padding: 3.9rem 0.95rem;
}

/* 分层列：引用方在左、被引用方在右；列间留足连线与标签的走线空间 */
.at-tablegraph__cols {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 3rem;
}

.at-tablegraph__col {
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
  /* 弹性列宽：组件已破列到 900px 内容区，固定 19rem 会让两列挤在左侧、
     右侧空出 200px（2026-10-19 实测）。两列平分可用宽度并留上下限：
     最宽 24rem 防止超宽屏把一列拉得过长；最窄 16rem（256px）让窄视口
     优先收缩而不是整图横向滚动，届时长字段名会按 `<wbr>` 断成两行。 */
  flex: 1 1 19rem;
  min-width: 16rem;
  max-width: 24rem;
}

.at-tablegraph__card {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  padding: 0.6rem 0.7rem;
  border: 1px solid var(--at-graph-line);
  border-radius: var(--at-radius-md);
  background: var(--at-bg);
  scroll-margin-top: 4.5rem;
  transition:
    border-color 0.15s ease,
    box-shadow 0.15s ease,
    opacity 0.15s ease;
}

.at-tablegraph__card.is-linked,
.at-tablegraph__card.is-flash {
  border-color: var(--at-accent);
  box-shadow: 0 0 0 3px var(--at-accent-soft);
}

.at-tablegraph__card.is-dim {
  opacity: 0.45;
}

.at-tablegraph__cardhead {
  display: flex;
  align-items: baseline;
  gap: 0.45rem;
  flex-wrap: wrap;
}

.at-tablegraph__name {
  font-family: var(--at-font-mono);
  font-size: 0.84rem;
  font-weight: 600;
  color: var(--at-accent-strong);
}

.at-tablegraph__cn {
  color: var(--at-text);
  font-size: 0.84rem;
  font-weight: 600;
}

.at-tablegraph__note {
  margin: 0 !important;
  color: var(--at-text-muted);
  font-size: 0.76rem;
  line-height: 1.45;
}

.at-tablegraph__fields {
  display: flex;
  flex-direction: column;
  gap: 0.12rem;
  margin: 0.15rem 0 0 !important;
  padding: 0.3rem 0 0;
  border-top: 1px dashed var(--at-border);
  list-style: none;
}

/* 字段行：名称 + 类型一行，中文名与键换到第二行。
   旧版四段挤在同一 flex 行里、键用 margin-left:auto 顶到最右——列宽只有 15rem 时
   每个子项被压到 1～2 字宽，中文名逐字竖排、类型折行，整卡 390px 还读不出内容
   （2026-10-19 实测）。改为 grid：名称列吃 1fr、类型紧随其后、键靠右。 */
.at-tablegraph__field {
  display: grid;
  grid-template-columns: 1fr auto auto;
  grid-template-areas:
    'name type key'
    'cn cn cn';
  align-items: baseline;
  gap: 0.1rem 0.4rem;
  margin: 0 -0.25rem;
  padding: 0.16rem 0.25rem;
  border-radius: var(--at-radius-sm);
  transition: background 0.12s ease;
}

.at-tablegraph__field.is-linked {
  background: color-mix(in srgb, var(--at-accent) 14%, transparent);
}

.at-tablegraph__fname {
  grid-area: name;
  font-family: var(--at-font-mono);
  font-size: 0.78rem;
  color: var(--at-text);
  /* 只在模板插入的 <wbr>（下划线处）断行；不用 overflow-wrap: anywhere——
     那会把标识符从中间硬切开。仍放不下时整名换到下一行，靠 grid 的 1fr 列 */
  overflow-wrap: normal;
}

.at-tablegraph__field.is-linked .at-tablegraph__fname {
  color: var(--at-accent-strong);
}

.at-tablegraph__fcn {
  grid-area: cn;
  color: var(--at-text-2);
  font-size: 0.74rem;
  line-height: 1.4;
}

.at-tablegraph__ftype {
  grid-area: type;
  justify-self: start;
  font-family: var(--at-font-mono);
  font-size: 0.7rem;
  color: var(--at-text-muted);
  white-space: nowrap;
}

.at-tablegraph__fkey {
  grid-area: key;
  justify-self: end;
  padding: 0.02rem 0.35rem;
  border-radius: var(--at-radius-sm);
  background: color-mix(in srgb, var(--at-accent) 12%, transparent);
  color: var(--at-accent-strong);
  font-family: var(--at-font-mono);
  font-size: 0.68rem;
  font-weight: 600;
  white-space: nowrap;
}

/* 连线层：铺在表卡之下（表卡 z-index 1），走线只出现在列间空隙与上下走廊 */
.at-tablegraph__edges {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.at-tablegraph__hit {
  fill: none;
  stroke: transparent;
  stroke-width: 14;
  pointer-events: stroke;
  cursor: pointer;
}

.at-tablegraph__line {
  fill: none;
  stroke: var(--at-graph-wire);
  stroke-width: 1.4;
  transition:
    stroke 0.12s ease,
    stroke-width 0.12s ease;
}

.at-tablegraph__edge.is-active .at-tablegraph__line {
  stroke: var(--at-accent);
  stroke-width: 2;
}

.at-tablegraph__edge.is-dim .at-tablegraph__line {
  opacity: 0.3;
}

.at-tablegraph__arrow {
  fill: var(--at-graph-wire);
  transition: fill 0.12s ease;
}

.at-tablegraph__edge.is-active .at-tablegraph__arrow {
  fill: var(--at-accent);
}

.at-tablegraph__edge.is-dim .at-tablegraph__arrow {
  opacity: 0.3;
}

.at-tablegraph__elabel {
  font-size: 11px;
  fill: var(--at-text-2);
  paint-order: stroke;
  stroke: var(--at-graph-canvas);
  stroke-width: 5px;
  stroke-linejoin: round;
  pointer-events: none;
}

.at-tablegraph__edge.is-active .at-tablegraph__elabel {
  fill: var(--at-accent-strong);
  font-weight: 600;
}

.at-tablegraph__edge.is-dim .at-tablegraph__elabel {
  opacity: 0.3;
}

.at-tablegraph__edge:focus {
  outline: none;
}

.at-tablegraph__edge:focus-visible .at-tablegraph__line {
  stroke: var(--at-accent);
  stroke-width: 2;
}

.at-tablegraph__empty {
  margin: 0 !important;
  padding: 2rem 0;
  text-align: center;
  color: var(--at-text-muted);
  font-size: 0.85rem;
}
</style>
