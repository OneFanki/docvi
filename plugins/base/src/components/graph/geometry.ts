/**
 * 图组件的路径几何（FlowDiagram / StateFlow / TableGraph 共用）。
 */

export type Point = [number, number]

/** 三次贝塞尔上 t 处的点（标签沿曲线定位，避免多条线标签堆在两端中点） */
export function cubicAt(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const mt = 1 - t
  const a = mt * mt * mt
  const b = 3 * mt * mt * t
  const c = 3 * mt * t * t
  const d = t * t * t
  return [
    a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
    a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1],
  ]
}

/** 两点连线在 t 处的点（折线的水平/竖直段取中点） */
export function lerpAt(a: Point, b: Point, t = 0.5): Point {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
}

/**
 * 圆角折线：points 为拐点序列，每个拐角用二次贝塞尔倒角。
 * 倒角半径按相邻段长收缩（短段不会把圆角吃穿）。
 */
export function roundedPath(points: Point[], radius = 8): string {
  if (points.length < 2) return ''
  const first = points[0]
  const last = points[points.length - 1]
  if (!first || !last) return ''
  let d = `M ${round(first[0])} ${round(first[1])}`
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
    // 共线拐点（长度 0 的段）直接跳过，否则会画出退化圆弧
    if (lenIn < 1 || lenOut < 1) {
      d += ` L ${round(cx)} ${round(cy)}`
      continue
    }
    const r = Math.min(radius, lenIn / 2, lenOut / 2)
    const inX = cx - ((cx - px) / lenIn) * r
    const inY = cy - ((cy - py) / lenIn) * r
    const outX = cx + ((nx - cx) / lenOut) * r
    const outY = cy + ((ny - cy) / lenOut) * r
    d += ` L ${round(inX)} ${round(inY)} Q ${round(cx)} ${round(cy)} ${round(outX)} ${round(outY)}`
  }
  d += ` L ${round(last[0])} ${round(last[1])}`
  return d
}

/** 竖向 S 形贝塞尔（源底 → 目标顶，控制柄竖直） */
export function downwardCurve(from: Point, to: Point, bend = 0.42): string {
  const c1y = from[1] + (to[1] - from[1]) * bend
  const c2y = to[1] - (to[1] - from[1]) * bend
  return `M ${round(from[0])} ${round(from[1])} C ${round(from[0])} ${round(c1y)}, ${round(to[0])} ${round(c2y)}, ${round(to[0])} ${round(to[1])}`
}

/** 横向 S 形贝塞尔（左缘 → 右缘，控制柄水平） */
export function sidewaysCurve(from: Point, to: Point, bend = 0.45): string {
  const dx = to[0] - from[0]
  const c1x = from[0] + dx * bend
  const c2x = from[0] + dx * (1 - bend)
  return `M ${round(from[0])} ${round(from[1])} C ${round(c1x)} ${round(from[1])}, ${round(c2x)} ${round(to[1])}, ${round(to[0])} ${round(to[1])}`
}

/** SVG 坐标保留一位小数：整页几十条路径时能明显减小 DOM 体积 */
function round(value: number): number {
  return Math.round(value * 10) / 10
}
