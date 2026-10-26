/**
 * 连线标注避让（FlowDiagram / StateFlow / TableGraph 共用）。
 *
 * 问题（2026-10-19 用户实测）：状态机里「快照 false」标签被目标节点**完全盖住**，
 * 放大到 300% 才看见半个。根因是标签位置只按边本身的中点算，从不检查节点框；
 * 而在「两行节点 + 行间带」布局里，只要 y 落进行内、x 落在节点跨度上，就必然被遮。
 *
 * 本模块的放置规则：
 * 1. **先把 y 夹进行间带**（带 = 相邻两行之间的空白，天然没有任何节点）——
 *    这一条几乎解决了全部遮挡；
 * 2. 若仍与节点相交（行高不齐、节点高度不一致时会出现），再水平挪，
 *    逐步加大位移直到不与任何节点框重叠；
 * 3. 都不行时取重叠面积最小的候选（宁可轻微压角，也不丢标签）。
 */

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface Band {
  /** 带的上边界（含） */
  top: number
  /** 带的下边界（含） */
  bottom: number
}

export function overlaps(a: Rect, b: Rect, pad = 0): boolean {
  return !(
    a.x + a.w + pad <= b.x ||
    b.x + b.w + pad <= a.x ||
    a.y + a.h + pad <= b.y ||
    b.y + b.h + pad <= a.y
  )
}

function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

function totalOverlap(rect: Rect, obstacles: Rect[]): number {
  let sum = 0
  for (const box of obstacles) sum += overlapArea(rect, box)
  return sum
}

/** 把矩形竖直夹进带内；带比矩形还矮时居中溢出（不强行压扁） */
export function clampToBand(rect: Rect, band: Band): Rect {
  const min = band.top + rect.h / 2
  const max = band.bottom - rect.h / 2
  if (min > max) return { ...rect, y: (band.top + band.bottom) / 2 }
  return { ...rect, y: Math.min(Math.max(rect.y, min), max) }
}

export interface PlaceOptions {
  /** 只允许水平挪动（标签在行间带里、竖直位置已由 clampToBand 定死） */
  horizontalOnly?: boolean
  /** 优先竖直挪动：通道标注要落在行间带里，水平挪会跑到别的节点下面 */
  verticalFirst?: boolean
  /** 水平搜索步长，默认 10 */
  step?: number
  /** 水平搜索上限，默认 240 */
  limit?: number
}

/**
 * 让标签（以中心点定位）避开所有节点框。
 * @param cx 期望中心 x
 * @param cy 期望中心 y
 * @param w 标签宽
 * @param h 标签高
 */
export function placeLabel(
  cx: number,
  cy: number,
  w: number,
  h: number,
  obstacles: Rect[],
  options: PlaceOptions = {},
): { x: number; y: number } {
  const { horizontalOnly = false, verticalFirst = false, step = 10, limit = 240 } = options
  const build = (dx: number, dy: number): Rect => ({
    x: cx - w / 2 + dx,
    y: cy - h / 2 + dy,
    w,
    h,
  })
  const hit = (rect: Rect) => obstacles.some(box => overlaps(rect, box, 1))

  const direct = build(0, 0)
  if (!hit(direct)) return { x: cx, y: cy }

  let best: { dx: number; dy: number; score: number } = {
    dx: 0,
    dy: 0,
    score: totalOverlap(direct, obstacles),
  }
  // 由近到远搜索固定的候选序：常规标注先水平（本来就该沿行间带排布），
  // 通道标注反过来先竖直——它的期望位置在通道中段，往往正压在中间行节点上，
  // 水平挪会跑到别的节点底下，竖直挪才能落回行间带。
  for (let distance = step; distance <= limit; distance += step) {
    const horizontalStep: Array<[number, number]> = [
      [distance, 0],
      [-distance, 0],
    ]
    const verticalStep: Array<[number, number]> = [
      [0, distance],
      [0, -distance],
    ]
    const candidates: Array<[number, number]> = horizontalOnly
      ? horizontalStep
      : verticalFirst
        ? [...verticalStep, ...horizontalStep]
        : [...horizontalStep, ...verticalStep]
    for (const [dx, dy] of candidates) {
      const rect = build(dx, dy)
      if (!hit(rect)) return { x: cx + dx, y: cy + dy }
      const score = totalOverlap(rect, obstacles)
      if (score < best.score) best = { dx, dy, score }
    }
  }
  return { x: cx + best.dx, y: cy + best.dy }
}
