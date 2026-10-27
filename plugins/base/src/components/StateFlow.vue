<script setup lang="ts">
/**
 * StateFlow —— 状态机流转图：分层排布的状态节点 + 带标注的转移连线。
 *
 * 状态机的阅读重点是「流转路径」（从某个状态能到哪、经由什么条件），因此本组件
 * 按转移关系自动分层为**纵向**图：每层一行、行内按重心排序降低交叉，
 * 转移从源节点底部流向目标节点顶部并带条件标注；current 高亮当前状态及其出边；
 * 点击节点查看该状态说明。纵向布局与正文阅读列同向，窄屏不横向溢出。
 *
 * 布局管线（2026-10-19 第二轮重做，用户反馈「节点一多就乱、标签被完全遮挡」）：
 * 1. **分层交给共享引擎** `graph/layered.ts`：DFS 断环识别回边 → 最长路径分层 →
 *    重心排序跨行降交叉。旧版用 BFS 最短路径分层，`uploadFail → successConfirm`
 *    这类边两端会被压到同一行，只能画成 y 差 4px 的退化锯齿。
 * 2. **回边走右侧专用通道**：行间空隙出、行间空隙折回，两段水平线都在无节点带内。
 * 3. **标注必须参与节点避让**（`graph/labels.ts`）：先夹进行间带，再水平挪开。
 *    旧版只按边中点算标注位置，「快照 false」被目标节点整块盖住（实测）。
 * 4. 行间带内多条标注按车道分层，行距随车道数增加。
 *
 * 数据协议见 types.ts：
 *   StateNode = { id, label, note?, kind?: 'start'|'state'|'end'|'error' }
 *   StateEdge = { from, to, label? }
 */
import { computed, nextTick, ref, watch } from 'vue'
import { edgeKey, layerGraph } from './graph/layered'
import { placeChannels, portX } from './graph/channels'
import { placeLabel } from './graph/labels'
import { downwardCurve, roundedPath } from './graph/geometry'
import { textWidth, widestLine } from './graph/text'
import type { StateEdge, StateNode } from './types'
import { useFullscreen } from './fullscreen'
import { useZoomPan } from './useZoomPan'
import ZoomBar from './ZoomBar.vue'

const props = withDefaults(
  defineProps<{
    /** 状态列表（按数组顺序渲染） */
    states: StateNode[]
    /** 转移列表（from → to，可带触发条件标签） */
    transitions: StateEdge[]
    /** 当前状态 id（可选：高亮该状态与其出边） */
    current?: string
    /** 标题（可选） */
    title?: string
  }>(),
  { current: '', title: '' },
)

/* ---------- 尺寸与文本估算 ---------- */

const FONT_LABEL = 13
const FONT_ID = 10.5
const FONT_EDGE = 10.5
const NODE_PAD_X = 13
/** 两行文本（中文名 + 状态码）需要 44 高，36 会把两行压在边上 */
const NODE_H = 44
const NODE_MIN_W = 110
const NODE_MAX_W = 320
/** 行间带基础高度（无标注时）；带内每条标注车道再加 LABEL_LANE_H */
const BAND_BASE = 40
/** 单条标注车道高（药丸 17 + 上下留白） */
const LABEL_LANE_H = 20
const LABEL_H = 17
const H_GAP = 26
const PAD = 12
/** 同一行间带内、多条绕行边水平段的错开步距与上限（带高 ≥40，容得下两条） */
const BAND_LANE_STEP = 9
const BAND_LANE_MAX = 9
/** 回边通道与节点区之间的水平间隙 */
const CHANNEL_GAP = 34
/** 多条回边并排时的车道步距 */
const LANE_STEP = 24
/** 回边通道标注与通道线之间的间距 */
const CHANNEL_LABEL_PAD = 6

/** 实例内唯一的 marker id 前缀（同页多个状态图不冲突） */
const uid = Math.random().toString(36).slice(2, 8)
const arrowId = `at-sf-arrow-${uid}`

/* ---------- 分层布局 ---------- */

interface Placed {
  state: StateNode
  x: number
  y: number
  w: number
  index: number
  isCurrent: boolean
}

interface Wire {
  d: string
  label: string
  /** 标注锚点：middle = 以 labelX 居中（带药丸）；start = labelX 为左端（侧标注） */
  labelX: number
  labelY: number
  labelW: number
  anchor: 'middle' | 'start'
  hot: boolean
  fromId: string
  toId: string
  /** 回边（走右侧通道）：虚线与侧标注 */
  back: boolean
}

const layout = computed(() => {
  const states = props.states
  const idList = states.map(state => state.id)
  const byIdIndex = new Map(idList.map((id, i) => [id, i]))
  const validEdges = props.transitions.filter(
    edge => byIdIndex.has(edge.from) && byIdIndex.has(edge.to),
  )

  // 分层：DFS 断环 → 最长路径 → 重心排序。回边单独返回，走外圈通道。
  const layered = layerGraph(
    idList,
    validEdges.filter(edge => edge.from !== edge.to),
    { sweeps: 6 },
  )
  const rows = layered.rows

  // 节点宽度：标签与状态码分两行居中，取较长者定宽。上夹 NODE_MAX_W——
  // 单行超长标签（WAIT_SEMANTIC_ANALYSIS 之类）会把节点撑爆阅读列，
  // 但状态码是等宽标识符不能截断，所以上限按最长状态码放宽到 320。
  const nodeWidths = states.map(state => {
    const labelW = widestLine([state.label], FONT_LABEL)
    const idW = textWidth(state.id, FONT_ID, true)
    return Math.min(
      NODE_MAX_W,
      Math.max(NODE_MIN_W, Math.round(Math.max(labelW, idW) + NODE_PAD_X * 2)),
    )
  })
  const widthOf = (id: string) => nodeWidths[byIdIndex.get(id) ?? 0] ?? NODE_MIN_W

  // 自转移：环画在节点右侧、标签跟在环后，需要额外槽宽
  const selfLabel = new Map<string, string>()
  for (const edge of validEdges) {
    if (edge.from === edge.to && edge.label && !selfLabel.has(edge.from)) {
      selfLabel.set(edge.from, edge.label)
    }
  }
  const slotWidth = (id: string) => {
    const label = selfLabel.get(id)
    return widthOf(id) + (label ? textWidth(label, FONT_EDGE) + 46 : 0)
  }

  const rowWidths = rows.map(
    members =>
      members.reduce((sum, id) => sum + slotWidth(id), 0) + Math.max(0, members.length - 1) * H_GAP,
  )
  const maxRowWidth = Math.max(0, ...rowWidths)

  const rowOfNode = (id: string) => layered.rowOf.get(id) ?? 0

  // 绕行边 = 回边 + 跨 ≥2 行的长边。两类边的进出方向相反：
  // - 回边（目标在上）：源**顶边**出、目标**底边**进，箭头向上——语义就是「返回上游状态」；
  // - 跨行边（目标在下）：源**底边**出、目标**顶边**进，箭头向下。
  // ⚠️ 旧实现两者都从源顶出、绕到目标上方再进顶边：跨行边白绕一个节点高度，
  // 回边还要翻过目标节点再下来。用户实测「重新领取」那条线画了一个大 U 形，
  // 根因就在这里。
  interface Routed {
    edge: StateEdge
    back: boolean
    /** 竖直通道跨越的中间行（不含源/目标所在行） */
    spanRows: number[]
  }
  const routed: Routed[] = []
  for (const edge of validEdges) {
    if (edge.from === edge.to) continue
    const fromRow = rowOfNode(edge.from)
    const toRow = rowOfNode(edge.to)
    const back = layered.backEdges.has(edgeKey(edge))
    // 同层边理论上都会被 DFS 判成回边，留 toRow <= fromRow 兜住异常输入
    if (!back && toRow - fromRow < 2) continue
    const spanRows: number[] = []
    if (back) {
      // 回边：竖直段从源行**上方**的带一路升到目标行**下方**的带，整段高度覆盖
      // 目标行到源行的全部节点行，所以两端行的节点也必须参与缝隙避让
      // （否则通道会从它们框里穿过去——压测实测 4 条回边穿节点）。
      for (let row = toRow; row <= fromRow; row += 1) spanRows.push(row)
    } else {
      // 跨行边：源行下方带 → 目标行上方带，只跨中间行
      for (let row = fromRow + 1; row < toRow; row += 1) spanRows.push(row)
    }
    routed.push({ edge, back, spanRows })
  }
  const routedSet = new Set(routed.map(item => item.edge))

  // 行间带：标注按「源行下方那条带」分配车道。
  // ⚠️ 不能用边自身的 sy/ty 跨度切车道：跨行边（1→3 行）的 1/2 处落在第 1 条带里，
  // 会和那条带自己的标注撞在一起（实测「定时扫描判定超时」与「整任务成功回报被接受」重叠）。
  const bandLabelCount = new Map<number, number>()
  for (const edge of validEdges) {
    if (edge.from === edge.to || !edge.label) continue
    if (routedSet.has(edge)) continue // 绕行边的标注挂在通道旁，不占带
    const fromRow = rowOfNode(edge.from)
    bandLabelCount.set(fromRow, (bandLabelCount.get(fromRow) ?? 0) + 1)
  }
  const maxBandLabels = Math.max(0, ...bandLabelCount.values())
  const bandH = Math.max(BAND_BASE, maxBandLabels * LABEL_LANE_H + 12)

  // 绕行边标注宽度：决定画布右侧留白上限
  let channelLabelW = 0
  for (const item of routed) {
    channelLabelW = Math.max(
      channelLabelW,
      item.edge.label ? textWidth(item.edge.label, FONT_EDGE) + 14 : 0,
    )
  }

  // 回边改成从目标底边进之后，顶部不再需要为「折回目标行上方」预留空间
  const topPad = PAD
  const rowTop = (row: number) => topPad + row * (NODE_H + bandH)
  const totalH = rows.length ? rowTop(rows.length - 1) + NODE_H + PAD : PAD * 2

  // 行内水平居中
  const placed: Placed[] = []
  const byId = new Map<string, Placed>()
  rows.forEach((members, row) => {
    let cursor = PAD + (maxRowWidth - (rowWidths[row] ?? 0)) / 2
    for (const id of members) {
      const index = byIdIndex.get(id) ?? 0
      const state = states[index]
      if (!state) continue
      const entry: Placed = {
        state,
        x: cursor,
        y: rowTop(row),
        w: widthOf(id),
        index,
        isCurrent: Boolean(props.current) && state.id === props.current,
      }
      placed.push(entry)
      byId.set(id, entry)
      cursor += slotWidth(id) + H_GAP
    }
  })

  // 通道分配：在被跨越行的节点缝隙里找水平代价最小的竖直通道，
  // 缝隙都不可用才退到节点区右侧外圈（见 graph/channels.ts）。
  // 这条规则解决「回边一律走最外侧、线比图还宽」的绕远问题。
  const channelObstacles = placed.map(node => ({
    row: rowOfNode(node.state.id),
    x: node.x,
    w: node.w,
  }))
  const channelRequests = routed.map(item => {
    const from = byId.get(item.edge.from)
    const to = byId.get(item.edge.to)
    if (!from || !to) return null
    return {
      fromX: from.x + from.w / 2,
      toX: to.x + to.w / 2,
      fromRange: [from.x, from.x + from.w] as [number, number],
      toRange: [to.x, to.x + to.w] as [number, number],
      spanRows: item.spanRows,
    }
  })
  const channelXs = placeChannels(
    channelRequests.filter((item): item is NonNullable<typeof item> => item !== null),
    channelObstacles,
    {
      gap: CHANNEL_GAP,
      laneStep: LANE_STEP,
      fallbackX: PAD + maxRowWidth + CHANNEL_GAP,
    },
  )

  // 通道落在节点区左侧时（回边两端都偏左），整体右移给它让位
  const minXt = Math.min(
    ...placed.map(node => node.x),
    ...channelXs.map(x => x - CHANNEL_LABEL_PAD - channelLabelW),
  )
  const shiftX = Math.max(0, PAD - minXt)
  if (shiftX > 0) {
    for (const node of placed) node.x += shiftX
    for (let i = 0; i < channelXs.length; i += 1) channelXs[i] = (channelXs[i] ?? 0) + shiftX
  }
  const totalW = Math.max(
    PAD * 2,
    PAD + maxRowWidth + shiftX,
    ...channelXs.map(x => x + CHANNEL_LABEL_PAD + channelLabelW + PAD),
  )

  // 节点框：标注避让的障碍集合
  const obstacles = placed.map(node => ({ x: node.x, y: node.y, w: node.w, h: NODE_H }))

  // 同源多出边 / 同目标多入边：端点错位（同点出发会叠成一条，分不清各自连到哪）
  const outTotal = new Map<string, number>()
  const inTotal = new Map<string, number>()
  for (const edge of validEdges) {
    if (edge.from === edge.to) continue
    outTotal.set(edge.from, (outTotal.get(edge.from) ?? 0) + 1)
    inTotal.set(edge.to, (inTotal.get(edge.to) ?? 0) + 1)
  }
  const outSeen = new Map<string, number>()
  const inSeen = new Map<string, number>()
  const bandUsed = new Map<number, number>()
  /** 行间带已用的绕行车道：同带多条绕行边水平段必须错开，否则共线重叠 */
  const bandLanes = new Map<string, number>()
  /** 已放标注（药丸/侧标注都计入）：相邻通道的侧标注会叠在一起，必须参与避让 */
  const placedLabels: Array<{ x: number; y: number; w: number; h: number }> = []

  const wires: Wire[] = []

  for (const edge of validEdges) {
    const from = byId.get(edge.from)
    const to = byId.get(edge.to)
    if (!from || !to) continue
    const label = edge.label ?? ''
    const labelW = label ? textWidth(label, FONT_EDGE) + 14 : 0
    const hot = Boolean(props.current) && edge.from === props.current

    // 自转移：右侧小环
    if (edge.from === edge.to) {
      wires.push({
        d: `M ${from.x + from.w} ${from.y + 11} C ${from.x + from.w + 30} ${from.y - 8}, ${from.x + from.w + 30} ${from.y + NODE_H + 8}, ${from.x + from.w + 7} ${from.y + NODE_H - 9}`,
        label,
        labelX: from.x + from.w + 34,
        labelY: from.y + NODE_H / 2,
        labelW,
        anchor: 'start',
        hot,
        fromId: edge.from,
        toId: edge.to,
        back: false,
      })
      continue
    }

    // 绕行边（回边 / 跨行边）：折线只跨必要的行距。
    // - 回边：源顶边出 → 源行上方带 → 通道竖直向上 → 目标行下方带 → 目标底边进。
    // - 跨行边：源底边出 → 源行下方带 → 通道竖直向下 → 目标行上方带 → 目标顶边进。
    // 两种都是「进哪条边就从哪侧靠近」，比旧版统一从顶边进出少走约一个节点高度。
    if (routedSet.has(edge)) {
      const item = routed.find(candidate => candidate.edge === edge)
      if (!item) continue
      const channelX = channelXs[routed.indexOf(item)] ?? PAD + maxRowWidth + CHANNEL_GAP
      // 端口朝通道一侧偏移：中心端口会和兄弟边挤在一起，横穿段还跨过兄弟边
      const startX = portX({ x: from.x, w: from.w }, channelX)
      const endX = portX({ x: to.x, w: to.w }, channelX)
      const startRow = rowOfNode(edge.from)
      const endRow = rowOfNode(edge.to)
      // 行间带的竖直中线：bandAbove = 该行上方那条带，bandBelow = 该行下方那条带。
      // 同一条带里有多条绕行边时按车道错开，否则它们的水平段会在同一 y 上共线重叠
      // （实测 16 状态压测图里两条边的水平段完全重合，看着像一条乱线）。
      const bandAbove = (row: number, lane: number) =>
        rowTop(row) - bandH / 2 + Math.min(lane * BAND_LANE_STEP, BAND_LANE_MAX)
      const bandBelow = (row: number, lane: number) =>
        rowTop(row) + NODE_H + bandH / 2 - Math.min(lane * BAND_LANE_STEP, BAND_LANE_MAX)
      const takeLane = (row: number, side: 'above' | 'below') => {
        const key = `${row}:${side}`
        const lane = bandLanes.get(key) ?? 0
        bandLanes.set(key, lane + 1)
        return lane
      }
      let points: Array<[number, number]>
      let labelY: number
      if (item.back) {
        const exitY = bandAbove(startRow, takeLane(startRow, 'above'))
        const enterY = bandBelow(endRow, takeLane(endRow, 'below'))
        points = [
          [startX, from.y],
          [startX, exitY],
          [channelX, exitY],
          [channelX, enterY],
          [endX, enterY],
          [endX, to.y + NODE_H],
        ]
        labelY = (exitY + enterY) / 2
      } else {
        const exitY = bandBelow(startRow, takeLane(startRow, 'below'))
        const enterY = bandAbove(endRow, takeLane(endRow, 'above'))
        points = [
          [startX, from.y + NODE_H],
          [startX, exitY],
          [channelX, exitY],
          [channelX, enterY],
          [endX, enterY],
          [endX, to.y],
        ]
        labelY = (exitY + enterY) / 2
      }
      // 侧标注：默认贴在通道右侧，但必须避开节点框与已放标注
      // （相邻两条通道的标注 y 相同，直接贴右会横向叠在一起——压测实测 1 处）
      const desiredX = channelX + CHANNEL_LABEL_PAD + labelW / 2
      const spot = label
        ? placeLabel(desiredX, labelY, labelW, LABEL_H, [...obstacles, ...placedLabels], {
            verticalFirst: true,
            step: 10,
            limit: 220,
          })
        : { x: desiredX, y: labelY }
      if (label) {
        placedLabels.push({
          x: spot.x - labelW / 2,
          y: spot.y - LABEL_H / 2,
          w: labelW,
          h: LABEL_H,
        })
      }
      wires.push({
        d: roundedPath(points, 8),
        label,
        labelX: spot.x - labelW / 2,
        labelY: spot.y,
        labelW,
        anchor: 'start',
        hot,
        fromId: edge.from,
        toId: edge.to,
        back: item.back,
      })
      continue
    }

    // 普通下行边
    const fanTotal = outTotal.get(edge.from) ?? 1
    const fanSeen = outSeen.get(edge.from) ?? 0
    outSeen.set(edge.from, fanSeen + 1)
    const fan = fanTotal > 1 ? (fanSeen - (fanTotal - 1) / 2) * 16 : 0
    const inCount = inTotal.get(edge.to) ?? 1
    const inIndex = inSeen.get(edge.to) ?? 0
    inSeen.set(edge.to, inIndex + 1)
    const inFan = inCount > 1 ? (inIndex - (inCount - 1) / 2) * 16 : 0

    const sx = from.x + from.w / 2 + fan
    const sy = from.y + NODE_H
    const tx = to.x + to.w / 2 + inFan
    const ty = to.y

    // 标注：先按带内车道分层，再夹进带（药丸不能压行边界），最后水平避让节点
    let labelY = (sy + ty) / 2
    if (label) {
      const band = rowOfNode(edge.from)
      const lanes = bandLabelCount.get(band) ?? 1
      const slot = bandUsed.get(band) ?? 0
      bandUsed.set(band, slot + 1)
      labelY = lanes > 1 ? sy + ((ty - sy) / lanes) * (slot + 0.5) : (sy + ty) / 2
      const half = LABEL_H / 2
      labelY = Math.min(Math.max(labelY, sy + half), ty - half)
    }
    const anchorX = (sx + tx) / 2
    const spot = label
      ? placeLabel(anchorX, labelY, labelW, LABEL_H, [...obstacles, ...placedLabels], {
          horizontalOnly: true,
          limit: 200,
        })
      : { x: anchorX, y: labelY }
    if (label) {
      placedLabels.push({
        x: spot.x - labelW / 2,
        y: spot.y - LABEL_H / 2,
        w: labelW,
        h: LABEL_H,
      })
    }

    wires.push({
      d: downwardCurve([sx, sy], [tx, ty]),
      label,
      labelX: spot.x,
      labelY: spot.y,
      labelW,
      anchor: 'middle',
      hot,
      fromId: edge.from,
      toId: edge.to,
      back: false,
    })
  }

  return { placed, wires, width: totalW, height: totalH }
})
const currentState = computed(() => props.states.find(state => state.id === props.current))

/** 画布高度跟随内容（封顶由 CSS max-height 负责） */
const canvasStyle = computed(() => ({
  height: `${Math.ceil(layout.value.height + 16)}px`,
}))

// ── 全屏：原生 API 优先，失败退化为覆盖层（兜底逻辑与 TableTabs/TableGraph 共用 ./fullscreen） ──
const rootRef = ref<HTMLElement | null>(null)
const viewportRef = ref<HTMLElement | null>(null)
/** 测量对象：包裹层（决定内容自然尺寸） */
const contentRef = ref<HTMLElement | null>(null)
const { isFullscreen, overlay, toggle: toggleFullscreen } = useFullscreen(rootRef)
/** 缩放比例（写回 SVG wrapper 用） */
const {
  percent,
  dragging,
  style,
  fit,
  reset: resetZoom,
  zoomBy,
} = useZoomPan(viewportRef, contentRef, { min: 0.3, max: 3, fitFloor: 0.55 })

watch(isFullscreen, value => {
  void nextTick(() => {
    if (value) fit()
    else resetZoom()
  })
})

/* ---------- 节点说明（点击下钻） ---------- */

const selected = ref<string | null>(null)

/** 悬停状态：高亮相关转移与邻接状态（不点也能看清这条线连到哪） */
const hoveredId = ref<string | null>(null)

function wireState(wire: Wire): string {
  if (wire.hot) return 'is-hot'
  const focus = hoveredId.value
  if (!focus) return ''
  return wire.fromId === focus || wire.toId === focus ? 'is-hot' : 'is-dim'
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

const selectedState = computed(() =>
  props.states.find(state => state.id === selected.value && state.note),
)

function kindClass(kind: StateNode['kind']): string {
  return `is-${kind ?? 'state'}`
}
</script>

<template>
  <section ref="rootRef" class="at-stateflow" :class="{ 'is-overlay': overlay }">
    <header class="at-stateflow__head">
      <span class="at-stateflow__title">{{ title || '状态机' }}</span>
      <span class="at-stateflow__meta"
        >{{ states.length }} 状态 · {{ transitions.length }} 转移</span
      >
      <span v-if="currentState" class="at-stateflow__current">当前：{{ currentState.label }}</span>
      <ZoomBar :percent="percent" @zoom-in="zoomBy(1.2)" @zoom-out="zoomBy(1 / 1.2)" @fit="fit" />
      <button
        type="button"
        class="at-stateflow__fs"
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
      v-if="states.length"
      ref="viewportRef"
      class="at-stateflow__canvas"
      :class="{ 'is-dragging': dragging }"
      :style="canvasStyle"
    >
      <div ref="contentRef" class="at-stateflow__content">
        <svg
          class="at-stateflow__svg"
          :style="style"
          :viewBox="`0 0 ${layout.width} ${layout.height}`"
          :width="layout.width"
          :height="layout.height"
          :aria-label="title || '状态机流转图'"
          role="img"
        >
          <defs>
            <!-- 箭头颜色跟随连线（context-stroke）：悬停高亮时箭头一起变主色 -->
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

          <!-- 转移连线（先画线，节点覆盖其上） -->
          <g>
            <template v-for="(wire, i) in layout.wires" :key="i">
              <path
                class="at-stateflow__wire"
                :class="wireState(wire)"
                :d="wire.d"
                fill="none"
                :marker-end="`url(#${arrowId})`"
              />
              <template v-if="wire.label">
                <template v-if="wire.anchor === 'middle'">
                  <rect
                    class="at-stateflow__wire-pill"
                    :class="wireState(wire)"
                    :x="wire.labelX - wire.labelW / 2"
                    :y="wire.labelY - 8.5"
                    :width="wire.labelW"
                    height="17"
                    rx="8.5"
                  />
                  <text
                    class="at-stateflow__wire-label"
                    :class="wireState(wire)"
                    :x="wire.labelX"
                    :y="wire.labelY + 3.5"
                    text-anchor="middle"
                  >
                    {{ wire.label }}
                  </text>
                </template>
                <text
                  v-else
                  class="at-stateflow__wire-label is-side"
                  :class="wireState(wire)"
                  :x="wire.labelX"
                  :y="wire.labelY + 3.5"
                  text-anchor="start"
                >
                  {{ wire.label }}
                </text>
              </template>
            </template>
          </g>

          <!-- 状态节点 -->
          <g
            v-for="placed in layout.placed"
            :key="placed.state.id"
            class="at-stateflow__node"
            :class="[
              kindClass(placed.state.kind),
              nodeState(placed.state.id),
              { 'is-current': placed.isCurrent, 'is-selected': selected === placed.state.id },
            ]"
            role="button"
            tabindex="0"
            @click="toggle(placed.state.id)"
            @keydown.enter.prevent="toggle(placed.state.id)"
            @keydown.space.prevent="toggle(placed.state.id)"
            @pointerenter="hoveredId = placed.state.id"
            @pointerleave="hoveredId = null"
            @focusin="hoveredId = placed.state.id"
            @focusout="hoveredId = null"
          >
            <title>
              {{ placed.state.label }}（{{ placed.state.id }}）{{
                placed.state.note ? ` — ${placed.state.note}` : ''
              }}
            </title>
            <rect
              v-if="selected === placed.state.id"
              class="at-stateflow__select"
              :x="placed.x - 8"
              :y="placed.y - 8"
              :width="placed.w + 16"
              :height="NODE_H + 16"
              rx="16"
            />
            <rect
              v-if="placed.isCurrent"
              class="at-stateflow__ring"
              :x="placed.x - 4"
              :y="placed.y - 4"
              :width="placed.w + 8"
              :height="NODE_H + 8"
              rx="12"
            />
            <rect
              class="at-stateflow__box"
              :x="placed.x"
              :y="placed.y"
              :width="placed.w"
              :height="NODE_H"
              rx="8"
            />
            <text class="at-stateflow__label" :x="placed.x + NODE_PAD_X" :y="placed.y + 18">
              {{ placed.state.label }}
            </text>
            <text class="at-stateflow__id" :x="placed.x + NODE_PAD_X" :y="placed.y + 33">
              {{ placed.state.id }}
            </text>
          </g>
        </svg>
      </div>
    </div>

    <div v-if="selectedState" class="at-stateflow__detail">
      <span class="at-stateflow__detail-name">{{ selectedState.label }}</span>
      {{ selectedState.note }}
    </div>
  </section>
</template>

<style scoped>
.at-stateflow {
  margin: 1rem 0;
  border: 1px solid var(--at-border);
  border-radius: var(--at-radius-lg);
  background: var(--at-surface);
  overflow: hidden;
}

/* ---- 全屏（原生 API 优先，失败退化为覆盖层；与 TableTabs/TableGraph 同约定） ---- */

.at-stateflow:fullscreen,
.at-stateflow.is-overlay {
  display: flex;
  flex-direction: column;
  /* 覆盖层用 fixed + inset 定高：正文态的 margin: 1rem 0 会再从 inset 里扣掉
     上下各 1rem，容器比视口矮 2rem；原生全屏由 UA 归零，这里统一写死 */
  margin: 0;
  border: none;
  border-radius: 0;
  background: var(--at-bg);
}

.at-stateflow:fullscreen {
  height: 100%;
}

/* 覆盖层：居中模态（四周留白 + 圆角），不铺满整屏贴底。
   顶边额外让出标题栏：窗口按钮画在那条带上（Windows 右上 / macOS 左上）。 */
.at-stateflow.is-overlay {
  position: fixed;
  inset: calc(var(--at-overlay-top, 0px) + 3vh) 4vw 3vh;
  z-index: 1000;
  border: 1px solid var(--at-border);
  border-radius: var(--at-radius-lg);
  box-shadow: var(--at-shadow);
}

/* 全屏 / 覆盖层下画布吃满剩余高度；缩放平移由 useZoomPan 处理，不需要滚动条 */
.at-stateflow:fullscreen .at-stateflow__canvas,
.at-stateflow.is-overlay .at-stateflow__canvas {
  flex: 1 1 auto;
  min-height: 0;
  height: auto;
  /* max-height 不覆盖会把画布封顶在正文态的 78vh：flex:1 撑到 78vh 就停，
     下方留下一整条卡片底色空白（用户实测 1123px 视口网格止于 876px） */
  max-height: none;
}

.at-stateflow__fs {
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

.at-stateflow__fs:hover {
  border-color: var(--at-accent);
  color: var(--at-accent);
}

.at-stateflow__head {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.5rem 0.9rem;
  border-bottom: 1px solid var(--at-border);
}

.at-stateflow__title {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--at-text-muted);
  letter-spacing: 0.02em;
}

.at-stateflow__meta {
  margin-left: auto;
  color: var(--at-text-muted);
  font-size: 0.76rem;
  font-variant-numeric: tabular-nums;
}

.at-stateflow__current {
  padding: 0.1rem 0.5rem;
  border-radius: 999px;
  background: var(--at-accent-soft);
  color: var(--at-accent-strong);
  font-size: 0.76rem;
  font-weight: 600;
}

/* 画布：内容居中；超出时双向滚动。用 flex + margin:auto（而非 text-align:center）：
   空间足够时整图居中，空间不够时贴起始缘——否则超宽内容的左半部分滚不到（居中态裁左侧） */
/* 画布：视口固定高度、内容 transform 缩放平移（滚轮 + 拖拽，见 useZoomPan）。
   旧版 overflow:auto 只能横向挪一屏，看不到全貌（用户反馈）。 */
/* 高度由内容决定（模板绑 canvasStyle），max-height 封顶在 78vh：
   节点一多时旧版固定 52vh 会把整图压到 40~60%，字读不了。 */
.at-stateflow__canvas {
  position: relative;
  height: clamp(260px, 52vh, 560px);
  max-height: 78vh;
  padding: 0.4rem;
  overflow: hidden;
  cursor: grab;
  touch-action: none;
  background: radial-gradient(circle at 1px 1px, var(--at-graph-grid) 1px, transparent 0) 0 0 / 22px
    22px;
  background-color: var(--at-graph-canvas);
}

.at-stateflow__canvas.is-dragging {
  cursor: grabbing;
}

.at-stateflow__content {
  width: max-content;
  /* 不要写 will-change: transform——会把内容提升为合成层并按当前分辨率栅格化，
     放大后变成位图放大（发虚），见 FlowDiagram 同名说明 */
  user-select: none;
}

.at-stateflow__svg {
  display: block;
  font-family: var(--at-font-sans);
}

/* ---- 连线 ---- */

.at-stateflow__wire {
  stroke: var(--at-graph-wire);
  stroke-width: 1.4;
  transition:
    stroke 0.12s ease,
    opacity 0.12s ease;
}

.at-stateflow__wire.is-hot {
  stroke: var(--at-accent);
  stroke-width: 1.9;
}

.at-stateflow__wire.is-dim {
  opacity: 0.28;
}

/* 悬停聚焦：非邻接状态淡出（只高亮连线不够——「这条线连到哪」靠两端一起看） */
.at-stateflow__node.is-dim {
  opacity: 0.45;
  transition: opacity 0.12s ease;
}

.at-stateflow__node.is-focus .at-stateflow__box {
  stroke: var(--at-accent);
  stroke-width: 2;
}

.at-stateflow__wire-pill {
  fill: var(--at-graph-pill);
  stroke: var(--at-graph-line);
  stroke-width: 1;
}

.at-stateflow__wire-pill.is-hot {
  stroke: var(--at-accent);
  fill: var(--at-accent-soft);
}

.at-stateflow__wire-pill.is-dim {
  opacity: 0.28;
}

.at-stateflow__wire-label {
  fill: var(--at-text-2);
  font-size: 10.5px;
}

/* 侧标注（垂直/回边）：文字描边光环，压在线上也可读。光环必须等于画布色，
   否则缩小时会看到一圈比背景亮/暗的描边（2026-10-19 改用图形专用 canvas 色） */
.at-stateflow__wire-label.is-side {
  paint-order: stroke;
  stroke: var(--at-graph-canvas);
  stroke-width: 3px;
  stroke-linejoin: round;
}

/* ---- 节点 ---- */

.at-stateflow__node {
  cursor: pointer;
}

/* 节点底色（2026-10-20 用户反馈「状态机节点也该像流程图那样有背景色」）：
   普通状态用一档中性底把卡片与画布分开，三类语义状态再叠自己的色。
   浓度取 12%：7% 在深色底上差值只有 0.02 亮度，手机上看不出来（实测）。 */
.at-stateflow__box {
  fill: var(--at-surface-2);
  stroke: var(--at-graph-line);
  stroke-width: 1.2;
  transition: stroke 0.12s ease;
}

.at-stateflow__node:hover .at-stateflow__box {
  stroke: var(--at-accent);
}

.at-stateflow__node.is-start .at-stateflow__box {
  stroke: var(--at-ok);
  fill: color-mix(in srgb, var(--at-ok) 12%, var(--at-bg));
}

.at-stateflow__node.is-end .at-stateflow__box {
  stroke: var(--at-accent);
  fill: color-mix(in srgb, var(--at-accent) 12%, var(--at-bg));
}

.at-stateflow__node.is-error .at-stateflow__box {
  stroke: var(--at-danger);
  fill: color-mix(in srgb, var(--at-danger) 12%, var(--at-bg));
}

.at-stateflow__ring {
  fill: none;
  stroke: var(--at-accent-soft);
  stroke-width: 5;
}

/* 选中外环：与 current 光环分层（-7 vs -4），虚线轻量标注「详情对应本节点」。
   （不用 box 自身的 dasharray：会与 current 实线描边叠成三层边框） */
.at-stateflow__select {
  fill: none;
  stroke: var(--at-accent-strong);
  stroke-width: 1.5;
  stroke-dasharray: 4 3;
}

.at-stateflow__node.is-current .at-stateflow__box {
  stroke: var(--at-accent);
  stroke-width: 2;
}

.at-stateflow__label {
  fill: var(--at-text);
  font-size: 13px;
  font-weight: 600;
}

.at-stateflow__id {
  fill: var(--at-text-muted);
  font-family: var(--at-font-mono);
  font-size: 10.5px;
}

/* 鼠标点击聚焦不画 UA 默认焦点框（WebView2/Chromium 对 SVG 焦点元素会画黑框，
   曾与选中虚线叠成视觉噪音）；键盘导航经 :focus-visible 走自己的高亮 */
.at-stateflow__node:focus,
.at-stateflow__node:focus-visible {
  outline: none;
}

.at-stateflow__node:focus-visible .at-stateflow__box {
  stroke: var(--at-accent);
  stroke-width: 2;
}

/* ---- 说明条（点击节点下钻；装饰线侧为直角，符合全库规则） ---- */

.at-stateflow__detail {
  margin: 0 0.9rem 0.9rem;
  padding: 0.55rem 0.8rem;
  border-left: 3px solid var(--at-accent);
  border-radius: 0 var(--at-radius-sm) var(--at-radius-sm) 0;
  background: var(--at-bg);
  color: var(--at-text-2);
  font-size: 0.84rem;
  line-height: 1.55;
}

.at-stateflow__detail-name {
  margin-right: 0.4rem;
  color: var(--at-text);
  font-weight: 600;
}
</style>
