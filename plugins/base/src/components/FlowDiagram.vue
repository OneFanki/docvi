<script setup lang="ts">
/**
 * FlowDiagram —— 有序业务流程（分层流程图）。
 *
 * 与旧版的区别（2026-10-19 重做）：旧版按数组顺序渲染成「带箭头的列表」，
 * 跨层分支只能写成「→ 目标节点」文字备注，分支关系读不出来——用户反馈
 * 「还不如 mermaid」。现在改为**真正的分层图**：
 * - 层号 = 从入口出发的最长路径（流程图是 DAG；带环时断环保护）；
 * - 同一层的节点横向并排，连线自上而下，分支天然分叉、汇聚天然合流；
 * - 节点标签自动折行（长标识符按 _ / - / . 断行），不再被裁切；
 * - 同层边与回边走右侧通道，不压节点；连线标签带底色药丸，压在线上也可读；
 * - 点击节点在下方展开该步说明（与正文有序步骤互相印证）。
 *
 * 数据协议见 types.ts：
 *   FlowNode = { id, label, kind?: 'start'|'step'|'decision'|'end', note? }
 *   FlowEdge = { from, to, label? }
 */
import { computed, nextTick, ref, watch } from 'vue'
import { edgeKey, layerGraph } from './graph/layered'
import { placeChannels, portX } from './graph/channels'
import { placeLabel as placeLabelAvoid } from './graph/labels'
import { cubicAt, roundedPath } from './graph/geometry'
import { textWidth, widestLine, wrapText } from './graph/text'
import { useFullscreen } from './fullscreen'
import { useZoomPan } from './useZoomPan'
import ZoomBar from './ZoomBar.vue'
import type { FlowEdge, FlowNode } from './types'

const props = defineProps<{
  nodes: FlowNode[]
  edges: FlowEdge[]
  title?: string
  /** 当前步骤 id（可选：高亮该步及其出边） */
  current?: string
}>()

/* ---------- 尺寸常量 ---------- */

const FONT_LABEL = 12.5
const LINE_H = 17
const NODE_PAD_X = 12
const NODE_PAD_Y = 9
const BADGE_W = 30
const NODE_MIN_W = 150
const NODE_MAX_W = 232
/** 同层节点水平间距 */
const H_GAP = 30
/** 层间垂直间距（容纳连线标签药丸） */
const V_GAP = 58
const CANVAS_PAD = 14
/** 绕行线车道步距（要容得下 17px 高的标注药丸） */
const LANE_STEP = 24
/** 同一行间带内、多条绕行边水平段的错开步距（带高 58，容得下 3 条） */
const BAND_LANE_STEP = 11

/** 实例内唯一 marker 前缀（同页多个流程图不冲突） */
const uid = Math.random().toString(36).slice(2, 8)
const arrowId = `at-flow-arrow-${uid}`

/* ---------- 分层布局 ---------- */

interface NodeBox {
  node: FlowNode
  index: number
  x: number
  y: number
  w: number
  h: number
  lines: string[]
}

interface Wire {
  d: string
  label: string
  labelX: number
  labelY: number
  /** 标签药丸宽度（0 = 无标签） */
  labelW: number
  hot: boolean
  /** 绕行边（同层 / 回边 / 跨多层的长边）：虚线不一定，靠 CSS 类区分 */
  back: boolean
  /** 端点 id：悬停节点时高亮相关连线 */
  fromId: string
  toId: string
}

const layout = computed(() => {
  const nodes = props.nodes
  const validEdges = props.edges.filter(
    edge => nodes.some(n => n.id === edge.from) && nodes.some(n => n.id === edge.to),
  )
  const nodeIndex = new Map(nodes.map((node, i) => [node.id, i]))

  // 分层：共享引擎（DFS 断环 → 最长路径 → 重心排序降交叉）。
  // 旧版本地实现只有「最长路径」，同行节点按声明顺序排——节点一多连线大面积交叉。
  const layered = layerGraph(
    nodes.map(node => node.id),
    validEdges.filter(edge => edge.from !== edge.to),
    { sweeps: 6 },
  )
  /** rows 存的是节点 id，这里换回 props.nodes 的下标 */
  const rows: number[][] = layered.rows.map(members => members.map(id => nodeIndex.get(id) ?? 0))
  const rowOf = (index: number) => layered.rowOf.get(nodes[index]?.id ?? '') ?? 0
  const backEdges = layered.backEdges

  // 节点尺寸（标签折行后取最长行）
  const measured = nodes.map(node => {
    const lines = wrapText(node.label, NODE_MAX_W - NODE_PAD_X * 2 - BADGE_W, {
      fontSize: FONT_LABEL,
    })
    const textW = widestLine(lines, FONT_LABEL)
    const w = Math.min(
      NODE_MAX_W,
      Math.max(NODE_MIN_W, Math.ceil(textW + NODE_PAD_X * 2 + BADGE_W)),
    )
    const h = lines.length * LINE_H + NODE_PAD_Y * 2
    return { lines, w, h }
  })

  const rowWidths = rows.map(
    members =>
      members.reduce((sum, i) => sum + (measured[i]?.w ?? 0), 0) +
      Math.max(0, members.length - 1) * H_GAP,
  )
  const rowHeights = rows.map(members =>
    members.length ? Math.max(...members.map(i => measured[i]?.h ?? 0)) : 0,
  )
  const contentW = Math.max(...rowWidths)

  // 绕行边：回边（引擎识别）与跨 ≥2 行的长边。
  // 两者都记下**竖直通道跨越的中间行**——通道位置只能落在这些行的节点缝隙里，
  // 由 graph/channels.ts 就近选点（旧版一律推到最外侧，用户实测「绕远路」）。
  interface Routed {
    edge: FlowEdge
    back: boolean
    spanRows: number[]
  }
  const routed: Routed[] = []
  for (const edge of validEdges) {
    if (edge.from === edge.to) continue
    const fromRow = rowOf(nodeIndex.get(edge.from) ?? 0)
    const toRow = rowOf(nodeIndex.get(edge.to) ?? 0)
    const back = backEdges.has(edgeKey(edge))
    if (!back && toRow - fromRow < 2) continue
    const spanRows: number[] = []
    if (back) {
      // 回边的竖直段从源行上方升到目标行下方，高度覆盖两端行自身的节点
      for (let row = toRow; row <= fromRow; row += 1) spanRows.push(row)
    } else {
      for (let row = fromRow + 1; row < toRow; row += 1) spanRows.push(row)
    }
    routed.push({ edge, back, spanRows })
  }

  // 绕行线的出/入点落在行间空隙。第一行上方没有空隙，所以有绕行边时顶部额外预留。
  const ROUTE_GAP = Math.round(V_GAP / 2)
  const topPad = CANVAS_PAD + (routed.length ? ROUTE_GAP : 0)

  // 行内水平居中；垂直按各层最大高度累计
  const placed: NodeBox[] = []
  const byId = new Map<string, NodeBox>()
  let cursorY = topPad
  rows.forEach((members, row) => {
    let cursorX = CANVAS_PAD + (contentW - (rowWidths[row] ?? 0)) / 2
    for (const i of members) {
      const node = nodes[i]
      const size = measured[i]
      if (!node || !size) continue
      const box: NodeBox = {
        node,
        index: i,
        x: cursorX,
        y: cursorY,
        w: size.w,
        h: size.h,
        lines: size.lines,
      }
      placed.push(box)
      byId.set(box.node.id, box)
      cursorX += box.w + H_GAP
    }
    cursorY += (rowHeights[row] ?? 0) + V_GAP
  })
  const totalH = cursorY - V_GAP + CANVAS_PAD + (routed.length ? ROUTE_GAP : 0)

  // 通道分配：在被跨越行的节点缝隙里找水平代价最小的竖直通道
  const channelObstacles = placed.map(box => ({
    row: rowOf(box.index),
    x: box.x,
    w: box.w,
  }))
  const channelXs = placeChannels(
    routed.map(item => {
      const from = byId.get(item.edge.from)!
      const to = byId.get(item.edge.to)!
      return {
        fromX: from.x + from.w / 2,
        toX: to.x + to.w / 2,
        fromRange: [from.x, from.x + from.w] as [number, number],
        toRange: [to.x, to.x + to.w] as [number, number],
        spanRows: item.spanRows,
      }
    }),
    channelObstacles,
    {
      gap: 24,
      laneStep: LANE_STEP,
      fallbackX: CANVAS_PAD + contentW + 16,
    },
  )

  // 通道落在节点区左侧时整体右移给它让位（回边两端都偏左时会发生）
  const channelLabelPad = 6
  let channelLabelW = 0
  for (const item of routed) {
    channelLabelW = Math.max(
      channelLabelW,
      item.edge.label ? textWidth(item.edge.label, 10.5) + 16 : 0,
    )
  }
  const minXt = Math.min(
    ...placed.map(box => box.x),
    ...channelXs.map(x => x - channelLabelPad - channelLabelW),
  )
  const shiftX = Math.max(0, CANVAS_PAD - minXt)
  if (shiftX > 0) {
    for (const box of placed) box.x += shiftX
    for (let i = 0; i < channelXs.length; i += 1) channelXs[i] = (channelXs[i] ?? 0) + shiftX
  }
  const totalW = Math.max(
    CANVAS_PAD * 2 + contentW,
    ...channelXs.map(x => x + channelLabelPad + channelLabelW + CANVAS_PAD),
  )

  // 同源多出边：扇出水平错位，避免同点出发叠成一条
  const outTotal = new Map<string, number>()
  for (const edge of validEdges) outTotal.set(edge.from, (outTotal.get(edge.from) ?? 0) + 1)
  const outSeen = new Map<string, number>()
  // 同目标多入边：入点错位，避免多条线挤进节点顶边同一处（用户反馈「看不清连到哪」）
  const inTotal = new Map<string, number>()
  for (const edge of validEdges) inTotal.set(edge.to, (inTotal.get(edge.to) ?? 0) + 1)
  const inSeen = new Map<string, number>()
  /** 行间带已用的水平车道数：同带多条绕行边必须错开，否则水平段共线叠在一起 */
  const bandLanes = new Map<string, number>()
  // 标签避让：共享实现（先水平让开节点框，再让开已放的标签）
  const placedLabels: Array<{ x: number; y: number; w: number; h: number }> = []
  const nodeObstacles = placed.map(box => ({ x: box.x, y: box.y, w: box.w, h: box.h }))

  function placeLabel(x: number, y: number, width: number): number {
    const spot = placeLabelAvoid(x, y, width || 1, 17, [...nodeObstacles, ...placedLabels], {
      horizontalOnly: true,
      step: 12,
      limit: 260,
    })
    placedLabels.push({ x: spot.x - width / 2, y: spot.y - 8.5, w: width, h: 17 })
    return spot.x
  }

  const wires: Wire[] = []

  /**
   * 取一条行间带的水平车道中心 y。
   *
   * 同一行的多条绕行边若都从「带正中」横穿，水平段会共线叠在一起——
   * 实测 18 步压测图里 4 条边全挤在 y=572，其中两条直接重合，看起来
   * 像一条乱线。这里按该带已用车道数依次外推，每条边占一条。
   *
   * @param row 行号
   * @param side -1 = 该行上方的带，+1 = 下方的带
   */
  function takeBandLane(row: number, side: 1 | -1): number {
    const key = `${row}:${side}`
    const lane = bandLanes.get(key) ?? 0
    bandLanes.set(key, lane + 1)
    const rowBox = placed.find(box => rowOf(box.index) === row)
    if (!rowBox) return 0
    // 带边 = 行框边缘外 ROUTE_GAP；车道向内收，最多收到带中线附近
    const edgeY = side < 0 ? rowBox.y - ROUTE_GAP : rowBox.y + rowBox.h + ROUTE_GAP
    const shift = Math.min(lane * BAND_LANE_STEP, ROUTE_GAP - 6)
    return side < 0 ? edgeY + shift : edgeY - shift
  }
  for (const edge of validEdges) {
    const from = byId.get(edge.from)
    const to = byId.get(edge.to)
    if (!from || !to) continue
    const total = outTotal.get(edge.from) ?? 1
    const seen = outSeen.get(edge.from) ?? 0
    outSeen.set(edge.from, seen + 1)
    const fanX = total > 1 ? (seen - (total - 1) / 2) * 16 : 0

    const inCount = inTotal.get(edge.to) ?? 1
    const inIndex = inSeen.get(edge.to) ?? 0
    inSeen.set(edge.to, inIndex + 1)
    const inFan = inCount > 1 ? (inIndex - (inCount - 1) / 2) * 16 : 0

    const label = edge.label ?? ''
    const labelW = label ? textWidth(label, 10.5) + 16 : 0
    const sx = from.x + from.w / 2 + fanX
    const sy = from.y + from.h
    const tx = to.x + to.w / 2 + inFan
    const ty = to.y
    const hot = Boolean(props.current) && edge.from === props.current
    const fromRow = rowOf(nodeIndex.get(edge.from) ?? 0)
    const toRow = rowOf(nodeIndex.get(edge.to) ?? 0)
    // 回边与跨 2 层以上的长边：直连会横穿中间层节点，改走右侧通道
    const longJump = toRow - fromRow >= 2
    const isBack = backEdges.has(edgeKey(edge))

    if (ty > sy && !longJump && !isBack) {
      const c1y = sy + (ty - sy) * 0.42
      const c2y = ty - (ty - sy) * 0.42
      const c1: [number, number] = [sx, c1y]
      const c2: [number, number] = [tx, c2y]
      // 曲线上 50% 的点（不是两端点的中点：大跨度的贝塞尔中点会偏离连线）
      const [mx, my] = cubicAt([sx, sy], c1, c2, [tx, ty], 0.5)
      const labelX = label ? placeLabel(mx, my, labelW) : mx
      wires.push({
        d: `M ${sx} ${sy} C ${sx} ${c1y}, ${tx} ${c2y}, ${tx} ${ty}`,
        label,
        labelX,
        labelY: my,
        labelW,
        hot,
        back: false,
        fromId: edge.from,
        toId: edge.to,
      })
      continue
    }

    // 回边 / 跨多层的长边：竖直通道 + 折线，进出方向跟着语义走：
    // - 回边（目标在上）：源顶出 → 源行上方带 → 通道向上 → 目标行下方带 → 目标底进，
    //   箭头朝上，读起来就是「回到上游」；
    // - 跨行边（目标在下）：源底出 → 源行下方带 → 通道向下 → 目标行上方带 → 目标顶进。
    // ⚠️ 旧版两者都从源顶出、绕到目标上方再进顶边：跨行边白绕一个节点高度，
    // 回边还要翻过目标节点再下来（用户实测「绕远路」的大 U 形）。
    const routedIndex = routed.findIndex(item => item.edge === edge)
    const channelX = channelXs[routedIndex] ?? CANVAS_PAD
    // 端口朝通道一侧偏移（不用中心）：中心端口要和兄弟边挤在一起，
    // 横穿到侧面通道的那一段还会跨过兄弟边的竖直段，多出无谓交叉
    const startX = portX({ x: from.x, w: from.w }, channelX)
    const endX = portX({ x: to.x, w: to.w }, channelX)

    let points: Array<[number, number]>
    let exitY: number
    let enterY: number
    if (isBack) {
      exitY = takeBandLane(fromRow, -1)
      enterY = takeBandLane(toRow, +1)
      points = [
        [startX, from.y],
        [startX, exitY],
        [channelX, exitY],
        [channelX, enterY],
        [endX, enterY],
        [endX, to.y + to.h],
      ]
    } else {
      exitY = takeBandLane(fromRow, +1)
      // 入点落在目标行**上方**的带里（不是源行下方——那样竖直段会从中间行穿过去）
      enterY = takeBandLane(toRow, -1)
      points = [
        [startX, from.y + from.h],
        [startX, exitY],
        [channelX, exitY],
        [channelX, enterY],
        [endX, enterY],
        [endX, to.y],
      ]
    }
    const d = roundedPath(points, 8)
    // 通道标注：与已放标注避让（多条绕行线的标注原本叠成一团）。
    // verticalFirst：期望位置在通道中段、常压在中间行节点上，先竖直挪回行间带。
    const channelLabelCenter = channelX + channelLabelPad + labelW / 2
    const channelSpot = label
      ? placeLabelAvoid(
          channelLabelCenter,
          (exitY + enterY) / 2,
          labelW,
          17,
          [...nodeObstacles, ...placedLabels],
          { verticalFirst: true, step: 12, limit: 200 },
        )
      : { x: channelLabelCenter, y: (exitY + enterY) / 2 }
    if (label) {
      placedLabels.push({
        x: channelSpot.x - labelW / 2,
        y: channelSpot.y - 8.5,
        w: labelW,
        h: 17,
      })
    }
    wires.push({
      d,
      label,
      labelX: channelSpot.x - labelW / 2,
      labelY: channelSpot.y,
      labelW,
      hot,
      back: isBack,
      fromId: edge.from,
      toId: edge.to,
    })
  }

  return { placed, wires, width: totalW, height: totalH }
})

/* ---------- 交互 ---------- */

const selected = ref<string | null>(null)
const selectedNode = computed(() => props.nodes.find(node => node.id === selected.value) ?? null)

/** 悬停节点：高亮它的连线与其邻接节点（不靠点击就能读清「这条线连到哪」） */
const hoveredId = ref<string | null>(null)

function wireState(wire: Wire): string {
  if (wire.hot) return 'is-hot'
  const focus = hoveredId.value
  if (!focus) return ''
  if (wire.fromId === focus || wire.toId === focus) return 'is-hot'
  return 'is-dim'
}

function nodeState(id: string): string {
  const focus = hoveredId.value
  if (!focus) return ''
  if (focus === id) return 'is-focus'
  const linked = layout.value.wires.some(
    wire =>
      (wire.fromId === focus && wire.toId === id) || (wire.toId === focus && wire.fromId === id),
  )
  return linked ? '' : 'is-dim'
}

function toggle(id: string) {
  selected.value = selected.value === id ? null : id
}

function kindClass(kind: FlowNode['kind']): string {
  return `is-${kind ?? 'step'}`
}

const rootRef = ref<HTMLElement | null>(null)
const viewportRef = ref<HTMLElement | null>(null)
const contentRef = ref<HTMLElement | null>(null)
const { isFullscreen, overlay, toggle: toggleFullscreen } = useFullscreen(rootRef)

/** 画布高度跟随内容（封顶由 CSS max-height 负责） */
const canvasStyle = computed(() => ({
  height: `${Math.ceil(layout.value.height + 16)}px`,
}))
const {
  percent,
  dragging,
  style,
  fit,
  reset: resetZoom,
  zoomBy,
} = useZoomPan(viewportRef, contentRef, { min: 0.3, max: 3, fitFloor: 0.55 })

// 进入全屏/覆盖层后按新视口尺寸自动适配；退出后回到 100% 居中
watch(isFullscreen, value => {
  void nextTick(() => {
    if (value) fit()
    else resetZoom()
  })
})
</script>

<template>
  <section
    ref="rootRef"
    class="at-flow"
    :class="{ 'is-overlay': overlay }"
    :aria-label="title || '流程图'"
  >
    <header class="at-flow__head">
      <span class="at-flow__title">{{ title || '流程图' }}</span>
      <span class="at-flow__meta">{{ nodes.length }} 步 · {{ edges.length }} 连线</span>
      <ZoomBar :percent="percent" @zoom-in="zoomBy(1.2)" @zoom-out="zoomBy(1 / 1.2)" @fit="fit" />
      <button
        type="button"
        class="at-flow__fs"
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
      ref="viewportRef"
      class="at-flow__canvas"
      :class="{ 'is-dragging': dragging }"
      :style="canvasStyle"
    >
      <div ref="contentRef" class="at-flow__content">
        <svg
          class="at-flow__svg"
          :style="style"
          :width="layout.width"
          :height="layout.height"
          :viewBox="`0 0 ${layout.width} ${layout.height}`"
          role="img"
          :aria-label="title || '流程图'"
        >
          <defs>
            <!-- 箭头颜色跟随连线：marker 用 context-stroke，悬停高亮时自动变主色 -->
            <marker
              :id="arrowId"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" />
            </marker>
          </defs>

          <!-- 连线（先画，节点覆盖其上） -->
          <g>
            <template v-for="(wire, i) in layout.wires" :key="`w${i}`">
              <path
                class="at-flow__wire"
                :class="[wireState(wire), { 'is-back': wire.back }]"
                :d="wire.d"
                fill="none"
                :marker-end="`url(#${arrowId})`"
              />
              <template v-if="wire.label">
                <rect
                  class="at-flow__pill"
                  :class="wireState(wire)"
                  :x="wire.labelX - wire.labelW / 2"
                  :y="wire.labelY - 8.5"
                  :width="wire.labelW"
                  height="17"
                  rx="8.5"
                />
                <text
                  class="at-flow__wire-label"
                  :class="wireState(wire)"
                  :x="wire.labelX"
                  :y="wire.labelY + 3.5"
                  text-anchor="middle"
                >
                  {{ wire.label }}
                </text>
              </template>
            </template>
          </g>

          <!-- 节点 -->
          <g
            v-for="box in layout.placed"
            :key="box.node.id"
            class="at-flow__node"
            :class="[
              kindClass(box.node.kind),
              nodeState(box.node.id),
              { 'is-selected': selected === box.node.id },
            ]"
            role="button"
            tabindex="0"
            :aria-label="`第 ${box.index + 1} 步：${box.node.label}`"
            :aria-expanded="selected === box.node.id"
            @click="toggle(box.node.id)"
            @keydown.enter.prevent="toggle(box.node.id)"
            @keydown.space.prevent="toggle(box.node.id)"
            @pointerenter="hoveredId = box.node.id"
            @pointerleave="hoveredId = null"
            @focusin="hoveredId = box.node.id"
            @focusout="hoveredId = null"
          >
            <title>{{ box.node.label }}{{ box.node.note ? ` — ${box.node.note}` : '' }}</title>
            <rect
              class="at-flow__box"
              :x="box.x"
              :y="box.y"
              :width="box.w"
              :height="box.h"
              rx="9"
            />
            <circle class="at-flow__badge" :cx="box.x + 15" :cy="box.y + box.h / 2" r="8.5" />
            <text
              class="at-flow__badge-text"
              :x="box.x + 15"
              :y="box.y + box.h / 2 + 3.2"
              text-anchor="middle"
            >
              {{ box.index + 1 }}
            </text>
            <text
              v-for="(line, lineIndex) in box.lines"
              :key="lineIndex"
              class="at-flow__label"
              :x="box.x + BADGE_W + NODE_PAD_X - 6"
              :y="
                box.y +
                (box.h - box.lines.length * LINE_H) / 2 +
                LINE_H / 2 +
                4.3 +
                lineIndex * LINE_H
              "
            >
              {{ line }}
            </text>
          </g>
        </svg>
      </div>
    </div>

    <div v-if="selectedNode?.note" class="at-flow__detail">
      <span class="at-flow__detail-name">{{ selectedNode.label }}</span>
      {{ selectedNode.note }}
    </div>
  </section>
</template>

<style scoped>
.at-flow {
  margin: 1rem 0;
  border: 1px solid var(--at-border);
  border-radius: var(--at-radius-lg);
  background: var(--at-surface);
  overflow: hidden;
}

.at-flow:fullscreen,
.at-flow.is-overlay {
  display: flex;
  flex-direction: column;
  /* 覆盖层用 fixed + inset 定高：正文态的 margin: 1rem 0 会再从 inset 里扣掉
     上下各 1rem，容器比视口矮 2rem；原生全屏由 UA 归零，这里统一写死 */
  margin: 0;
  border: none;
  border-radius: 0;
  background: var(--at-bg);
}

.at-flow:fullscreen {
  height: 100%;
}

/* 覆盖层：居中模态（上下留白、圆角），不再铺满整屏贴底——
   大屏上铺满会把内容顶到最上、控制条沉到最下，反而难读（2026-10-19 用户反馈）。 */
.at-flow.is-overlay {
  position: fixed;
  inset: 3vh 4vw;
  z-index: 1000;
  border: 1px solid var(--at-border);
  border-radius: var(--at-radius-lg);
  box-shadow: var(--at-shadow);
}

.at-flow:fullscreen .at-flow__canvas,
.at-flow.is-overlay .at-flow__canvas {
  flex: 1 1 auto;
  min-height: 0;
  height: auto;
  /* max-height 不覆盖会把画布封顶在正文态的 78vh：flex:1 撑到 78vh 就停，
     下方留下一整条卡片底色空白（同 StateFlow 的全屏裁切问题） */
  max-height: none;
}

.at-flow__head {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.5rem 0.9rem;
  border-bottom: 1px solid var(--at-border);
}

.at-flow__title {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--at-text-muted);
  letter-spacing: 0.02em;
}

.at-flow__meta {
  margin-left: auto;
  color: var(--at-text-muted);
  font-size: 0.76rem;
  font-variant-numeric: tabular-nums;
}

.at-flow__fs {
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

.at-flow__fs:hover {
  border-color: var(--at-accent);
  color: var(--at-accent);
}

/* 画布：视口固定高度、内容用 transform 缩放平移（滚轮缩放 + 拖拽，见 useZoomPan）。
   旧版是 overflow:auto 滚动条——宽图只能左右挪一屏，看不到全貌（用户反馈）。 */
/* 高度由内容决定（模板绑 canvasStyle），max-height 封顶在 78vh——
   固定高度的画布会让节点一多就整体缩到不可读（2026-10-19 用户反馈）。 */
.at-flow__canvas {
  position: relative;
  height: clamp(320px, 62vh, 680px);
  max-height: 78vh;
  padding: 0.4rem;
  overflow: hidden;
  cursor: grab;
  touch-action: none;
  background: radial-gradient(circle at 1px 1px, var(--at-graph-grid) 1px, transparent 0) 0 0 / 22px
    22px;
  background-color: var(--at-graph-canvas);
}

.at-flow__canvas.is-dragging {
  cursor: grabbing;
}

.at-flow__content {
  width: max-content;
  /* ⚠️ 不要写 will-change: transform（2026-10-19 用户反馈放大发虚）：
     它会把内容提升为合成层，浏览器按当前分辨率**栅格化一次**再贴图缩放，
     放大后就是位图放大效果。去掉后每次缩放变化都按新倍率重新光栅化，
     SVG 作为矢量才能保持锐利。 */
  user-select: none;
}

.at-flow__svg {
  display: block;
  font-family: var(--at-font-sans);
}

/* ---- 连线 ---- */

.at-flow__wire {
  stroke: var(--at-graph-wire);
  stroke-width: 1.5;
  transition:
    stroke 0.12s ease,
    opacity 0.12s ease;
}

.at-flow__wire.is-back {
  stroke-dasharray: 5 4;
}

.at-flow__wire.is-hot {
  stroke: var(--at-accent);
  stroke-width: 2;
}

.at-flow__wire.is-dim {
  opacity: 0.3;
}

.at-flow__pill {
  fill: var(--at-graph-pill);
  stroke: var(--at-graph-line);
  stroke-width: 1;
}

.at-flow__pill.is-hot {
  stroke: var(--at-accent);
  fill: var(--at-accent-soft);
}

.at-flow__pill.is-dim {
  opacity: 0.3;
}

.at-flow__wire-label {
  fill: var(--at-text-2);
  font-size: 10.5px;
}

.at-flow__wire-label.is-hot {
  fill: var(--at-accent-strong);
  font-weight: 600;
}

.at-flow__wire-label.is-dim {
  opacity: 0.35;
}

/* ---- 节点 ---- */

.at-flow__node {
  cursor: pointer;
}

.at-flow__box {
  fill: var(--at-bg);
  stroke: var(--at-graph-line);
  stroke-width: 1.2;
  transition:
    stroke 0.12s ease,
    fill 0.12s ease;
}

.at-flow__node:hover .at-flow__box {
  stroke: var(--at-accent);
}

/* 悬停聚焦：邻接节点保持原样，其余淡出——比只高亮连线更能看清「这条线连到哪」 */
.at-flow__node.is-dim {
  opacity: 0.45;
  transition: opacity 0.12s ease;
}

.at-flow__node.is-focus .at-flow__box {
  stroke: var(--at-accent);
  stroke-width: 2;
}

.at-flow__node.is-start .at-flow__box {
  stroke: var(--at-ok);
  fill: color-mix(in srgb, var(--at-ok) 7%, var(--at-bg));
}

.at-flow__node.is-decision .at-flow__box {
  stroke: var(--at-warn);
  fill: color-mix(in srgb, var(--at-warn) 7%, var(--at-bg));
}

.at-flow__node.is-end .at-flow__box {
  stroke: var(--at-accent);
  fill: color-mix(in srgb, var(--at-accent) 7%, var(--at-bg));
}

.at-flow__node.is-selected .at-flow__box {
  stroke: var(--at-accent);
  stroke-width: 2;
}

.at-flow__badge {
  fill: var(--at-graph-badge);
}

.at-flow__node.is-start .at-flow__badge {
  fill: color-mix(in srgb, var(--at-ok) 24%, transparent);
}

.at-flow__node.is-decision .at-flow__badge {
  fill: color-mix(in srgb, var(--at-warn) 24%, transparent);
}

.at-flow__node.is-end .at-flow__badge {
  fill: color-mix(in srgb, var(--at-accent) 22%, transparent);
}

.at-flow__badge-text {
  fill: var(--at-text-2);
  font-size: 9.5px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.at-flow__label {
  fill: var(--at-text);
  font-size: 12.5px;
  font-weight: 500;
}

.at-flow__node:focus,
.at-flow__node:focus-visible {
  outline: none;
}

.at-flow__node:focus-visible .at-flow__box {
  stroke: var(--at-accent);
  stroke-width: 2;
}

/* ---- 说明条（点击节点展开） ---- */

.at-flow__detail {
  margin: 0 0.9rem 0.9rem;
  padding: 0.55rem 0.8rem;
  border-left: 3px solid var(--at-accent);
  border-radius: 0 var(--at-radius-sm) var(--at-radius-sm) 0;
  background: var(--at-bg);
  color: var(--at-text-2);
  font-size: 0.84rem;
  line-height: 1.6;
}

.at-flow__detail-name {
  margin-right: 0.4rem;
  color: var(--at-text);
  font-weight: 600;
}
</style>
