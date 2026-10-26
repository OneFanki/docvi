/**
 * 绕行通道分配（StateFlow / FlowDiagram 共用）。
 *
 * 问题（2026-10-20 用户反馈「回边绕远路」）：旧实现把所有绕行边（回边 +
 * 跨多行的长边）一律推到节点区**最外侧**的右侧。一条从最左节点回到中间
 * 节点的回边，因此要横跨整个图宽两次——线比节点本身还长，看着就是硬绕。
 *
 * 真实约束只有一条：**通道的竖直段不能穿过它跨越的那些行的节点**。
 * 被跨越的行之外、以及被跨越行内的空白处，都是合法通道位置。所以正确做法
 * 是从「被跨越行的节点缝隙」里选水平代价最小的位置；最外侧只是兜底。
 *
 * 代价按**端口可自由落在节点边上**计算（见 `portX`）：横向行程 = 通道到
 * 源节点 x 区间的最短距离 + 到目标节点区间的最短距离。用中心点算会高估
 * 半个节点宽，把通道推得更远。
 *
 * 相邻行之间的回边没有中间行（spanRows 为空），此时通道可落在任意 x，
 * 取两端区间的最近点——线退化成带内的一个小 U 形，不再出圈。
 */

export interface ChannelObstacle {
  /** 所在行号 */
  row: number
  x: number
  w: number
}

export interface ChannelRequest {
  /** 源节点中心 x（无障碍且未给 fromRange 时的兜底） */
  fromX: number
  /** 目标节点中心 x */
  toX: number
  /** 源节点 x 跨度 [left, right]：端口可在边上任意位置，代价按到区间的最短距离算 */
  fromRange?: [number, number]
  /** 目标节点 x 跨度 [left, right] */
  toRange?: [number, number]
  /** 竖直段跨越的中间行（不含源/目标所在行：那两行由行间带隔开） */
  spanRows: number[]
}

export interface ChannelOptions {
  /** 通道与节点框的最小水平间距 */
  gap?: number
  /** 相邻通道的最小间距（多条边并排时错开） */
  laneStep?: number
  /** 兜底起点：所有合法缝隙都冲突时，从这里向外侧延伸 */
  fallbackX: number
  /** 兜底延伸方向：1 = 向右，-1 = 向左 */
  fallbackDir?: 1 | -1
}

/** 通道 x 是否落在某个障碍节点（含 gap）内 */
function blocked(x: number, blockers: ChannelObstacle[], gap: number): boolean {
  return blockers.some(node => x > node.x - gap && x < node.x + node.w + gap)
}

/** x 到区间的最短距离（落在区间内为 0）——端口可自由落点时就是这个代价 */
function distanceTo(x: number, range: [number, number] | undefined, center: number): number {
  if (!range) return Math.abs(center - x)
  return Math.max(0, range[0] - x, x - range[1])
}

/** 两个区间的「代价最优点」：重叠时取重叠段中点，不相交时取间隙中点（代价恒等于间隙宽） */
function bestFreeX(a: [number, number], b: [number, number]): number {
  const lo = Math.max(a[0], b[0])
  const hi = Math.min(a[1], b[1])
  if (lo <= hi) return (lo + hi) / 2
  return a[1] < b[0] ? (a[1] + b[0]) / 2 : (b[1] + a[0]) / 2
}

/**
 * 绕行边在节点边上的端口 x：**朝通道一侧偏移**，不用节点中心。
 *
 * 固定中心有两个后果（2026-10-20 用户实测「绕了个大框、还和不合理的线交叉」）：
 * ① 通道在左侧时横向行程是「中心 → 左通道」，接近半个节点宽甚至半个图宽；
 * ② 端口正好和中心锚点的兄弟边叠在一起，几条线在节点下方挤成一团，
 *    而横穿的那一段又必然跨过兄弟边的竖直段——多出没有必要的交叉。
 */
export function portX(span: { x: number; w: number }, channelX: number, inset = 14): number {
  const pad = Math.min(inset, span.w / 3)
  const lo = span.x + pad
  const hi = span.x + span.w - pad
  if (channelX < lo) return lo
  if (channelX > hi) return hi
  return channelX
}

/**
 * 为一批绕行边分配通道 x（顺序与 requests 一致）。
 * 返回的 x 可能落在节点区内部，调用方需据此重算总宽并整体平移。
 */
export function placeChannels(
  requests: ChannelRequest[],
  obstacles: ChannelObstacle[],
  options: ChannelOptions,
): number[] {
  const { gap = 26, laneStep = 24, fallbackX, fallbackDir = 1 } = options
  const used: Array<{ x: number; rows: Set<number> }> = []
  const result: number[] = []

  for (const request of requests) {
    const blockers = obstacles.filter(node => request.spanRows.includes(node.row))
    // 候选：障碍节点的左右边缘外扩 gap。spanRows 为空时没有障碍，
    // 直接取两端中点（带内小 U 形）——这是相邻行回边的最短走法。
    const candidates = new Set<number>()
    if (blockers.length === 0) {
      // 无障碍：任取一个能在两区间内（或夹在两区间之间）的点，横向代价都最小
      const a = request.fromRange ?? [request.fromX, request.fromX]
      const b = request.toRange ?? [request.toX, request.toX]
      candidates.add(bestFreeX(a, b))
    } else {
      for (const node of blockers) {
        candidates.add(node.x - gap)
        candidates.add(node.x + node.w + gap)
      }
    }
    const ranked = [...candidates]
      .filter(x => !blocked(x, blockers, gap))
      .map(x => ({
        x,
        cost:
          distanceTo(x, request.fromRange, request.fromX) +
          distanceTo(x, request.toRange, request.toX),
      }))
      .sort((a, b) => a.cost - b.cost || a.x - b.x)

    const clashes = (x: number): boolean =>
      used.some(
        slot =>
          Math.abs(slot.x - x) < laneStep - 0.5 && request.spanRows.some(row => slot.rows.has(row)),
      )

    let picked = ranked.find(candidate => !clashes(candidate.x))?.x
    if (picked === undefined) {
      // 兜底：从给定起点沿指定方向出圈，直到与已用通道拉开
      let x = fallbackX
      let guard = 0
      while (clashes(x) && guard < 40) {
        x += laneStep * fallbackDir
        guard += 1
      }
      picked = x
    }
    used.push({ x: picked, rows: new Set(request.spanRows) })
    result.push(picked)
  }
  return result
}
