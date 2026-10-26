/**
 * 分层图布局引擎（FlowDiagram / StateFlow 共用）。
 *
 * 这一层只做「谁在第几行、行内什么顺序、谁是回边」，不做像素定位——
 * 节点尺寸与通道宽度由各组件按自己的卡片样式决定。
 *
 * 分层策略（2026-10-19 重做，用户反馈「节点一多就乱」）：
 * 1. **先断环**：DFS 找出指向递归栈内节点的边（回边），从分层用的 DAG 里剔除。
 * 2. **再按最长路径分层**：保证任意非回边都严格向下（`to.row > from.row`）。
 *    旧版 StateFlow 用 BFS（最短路径）分层，副作用是 `uploadFail → successConfirm`
 *    这种边两端被压到同一行，只能走「同层绕行」，而绕行端点 y 几乎相同，
 *    画出来是一条退化的锯齿线；改用最长路径后它变成正常的下行边。
 * 3. **重心排序降交叉（barycenter）**：上下各扫几趟，按相邻行邻居的平均位置重排。
 *    这是「看着乱」的主因——同一行节点按声明顺序排，连线会大面积交叉。
 *
 * 回边集合单独返回：回边不参与分层，需要走外圈通道单独路由。
 */

export interface LayerEdge {
  from: string
  to: string
}

export interface LayerOptions {
  /** 重心排序扫描趟数（上下各一次为一趟），默认 4；节点多时交叉消减收益递减 */
  sweeps?: number
}

export interface LayeredGraph {
  /** 压实后的行号（0 起，无空洞） */
  rowOf: Map<string, number>
  /** 每行的节点 id，已按重心排序 */
  rows: string[][]
  /** 回边（向上或同层，不能按普通下行边画）的 `from->to` 键集合 */
  backEdges: Set<string>
  /** 原图是否有环 */
  cyclic: boolean
}

export function edgeKey(edge: LayerEdge): string {
  return `${edge.from}->${edge.to}`
}

/**
 * DFS 找回首边：同一次 DFS 递归栈里再次遇到的节点 = 回边。
 * 自环（from === to）也计入回边（不参与分层），由组件画自转移环。
 */
function findBackEdges(ids: string[], edges: LayerEdge[]): Set<string> {
  const outgoing = new Map<string, LayerEdge[]>()
  for (const id of ids) outgoing.set(id, [])
  for (const edge of edges) {
    if (edge.from === edge.to) continue
    outgoing.get(edge.from)?.push(edge)
  }
  const back = new Set<string>()
  const state = new Map<string, 0 | 1 | 2>() // 0=未访问 1=栈内 2=完成
  for (const id of ids) state.set(id, 0)

  // 显式栈避免深图递归爆栈（教学图不会很深，但出错时更难查）
  interface Frame {
    id: string
    index: number
  }
  for (const root of ids) {
    if (state.get(root) !== 0) continue
    const stack: Frame[] = [{ id: root, index: 0 }]
    state.set(root, 1)
    while (stack.length) {
      const frame = stack[stack.length - 1]
      if (!frame) break
      const list = outgoing.get(frame.id) ?? []
      const edge = list[frame.index]
      if (!edge) {
        state.set(frame.id, 2)
        stack.pop()
        continue
      }
      frame.index += 1
      const next = state.get(edge.to)
      if (next === 1) {
        // 目标还在栈里 → 这条边构成环
        back.add(edgeKey(edge))
      } else if (next === 0) {
        state.set(edge.to, 1)
        stack.push({ id: edge.to, index: 0 })
      }
    }
  }
  return back
}

/** Kahn 拓扑序（只用于最长路径 DP；有环时残留节点按声明顺序补到末尾） */
function topoOrder(ids: string[], edges: LayerEdge[]): string[] {
  const indegree = new Map<string, number>()
  const outgoing = new Map<string, string[]>()
  for (const id of ids) {
    indegree.set(id, 0)
    outgoing.set(id, [])
  }
  for (const edge of edges) {
    if (edge.from === edge.to) continue
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1)
    outgoing.get(edge.from)?.push(edge.to)
  }
  const queue = ids.filter(id => (indegree.get(id) ?? 0) === 0)
  const order: string[] = []
  const placed = new Set<string>()
  while (queue.length) {
    const id = queue.shift()!
    order.push(id)
    placed.add(id)
    for (const next of outgoing.get(id) ?? []) {
      const left = (indegree.get(next) ?? 0) - 1
      indegree.set(next, left)
      if (left === 0) queue.push(next)
    }
  }
  // 有环时残留节点补到末尾（断环后理论上不该发生，留作兜底）
  for (const id of ids) if (!placed.has(id)) order.push(id)
  return order
}

/**
 * 重心排序：把每行节点按「相邻行邻居的平均列号」升序重排，上下各扫一趟为一轮。
 * 邻居不存在时保持原位（用当前列号当兜底，等价于不动）。
 */
function reduceCrossings(rows: string[][], edges: LayerEdge[], sweeps: number): string[][] {
  if (rows.length < 2 || !edges.length) return rows
  const preds = new Map<string, string[]>()
  const succs = new Map<string, string[]>()
  for (const edge of edges) {
    if (edge.from === edge.to) continue
    preds.set(edge.to, [...(preds.get(edge.to) ?? []), edge.from])
    succs.set(edge.from, [...(succs.get(edge.from) ?? []), edge.to])
  }
  const current = rows.map(row => [...row])

  const position = () => {
    const pos = new Map<string, number>()
    current.forEach(row => row.forEach((id, index) => pos.set(id, index)))
    return pos
  }

  const sortBy = (row: string[], neighbours: Map<string, string[]>, pos: Map<string, number>) => {
    const keyed = row.map((id, index) => {
      const list = neighbours.get(id) ?? []
      const values = list.map(n => pos.get(n)).filter((v): v is number => v !== undefined)
      const bary = values.length ? values.reduce((a, b) => a + b, 0) / values.length : index
      return { id, bary, index }
    })
    keyed.sort((a, b) => (a.bary === b.bary ? a.index - b.index : a.bary - b.bary))
    return keyed.map(item => item.id)
  }

  for (let sweep = 0; sweep < sweeps; sweep += 1) {
    // 向下：按前驱重心
    for (let r = 1; r < current.length; r += 1) {
      const row = current[r]
      if (row) current[r] = sortBy(row, preds, position())
    }
    // 向上：按后继重心
    for (let r = current.length - 2; r >= 0; r -= 1) {
      const row = current[r]
      if (row) current[r] = sortBy(row, succs, position())
    }
  }
  return current
}

export function layerGraph(
  ids: string[],
  edges: LayerEdge[],
  options: LayerOptions = {},
): LayeredGraph {
  const { sweeps = 4 } = options
  const idSet = new Set(ids)
  const valid = edges.filter(
    edge => idSet.has(edge.from) && idSet.has(edge.to) && edge.from !== edge.to,
  )
  const backEdges = findBackEdges(ids, valid)
  const dagEdges = valid.filter(edge => !backEdges.has(edgeKey(edge)))

  // 最长路径分层：拓扑序上 DP，depth(to) = max(depth(from) + 1)
  const depth = new Map<string, number>()
  for (const id of ids) depth.set(id, 0)
  const outgoingDag = new Map<string, string[]>()
  for (const edge of dagEdges) {
    outgoingDag.set(edge.from, [...(outgoingDag.get(edge.from) ?? []), edge.to])
  }
  for (const id of topoOrder(ids, dagEdges)) {
    for (const to of outgoingDag.get(id) ?? []) {
      depth.set(to, Math.max(depth.get(to) ?? 0, (depth.get(id) ?? 0) + 1))
    }
  }

  // 压实层号：稀疏层号会让下游 Math.max(...widths) 得 NaN，节点全叠到左边缘
  const used = [...new Set(depth.values())].sort((a, b) => a - b)
  const compact = new Map(used.map((layer, index) => [layer, index]))
  const rows: string[][] = used.map(() => [])
  for (const id of ids) rows[compact.get(depth.get(id) ?? 0) ?? 0]?.push(id)

  const ordered = reduceCrossings(rows, dagEdges, sweeps)
  const rowOf = new Map<string, number>()
  ordered.forEach((row, index) => row.forEach(id => rowOf.set(id, index)))

  return { rowOf, rows: ordered, backEdges, cyclic: backEdges.size > 0 }
}
