/**
 * mermaid SVG 的 hover 增强：悬停节点 → 高亮它的出入边与相邻节点，无关元素淡出。
 *
 * 适配 mermaid **11.17** 的 id 约定（结构探针 `scripts/dev/probe-mermaid-shape.mjs`
 * 是它的回归依据，升级 mermaid 后先跑探针再核对本文件）：
 *  - flowchart 节点 `g.node`  id = `{prefix}-flowchart-{NAME}-{n}`
 *  - erDiagram 实体 `g.node`  id = `{prefix}-entity-{NAME}-{n}`
 *  - flowchart 边 `path`      id = `{prefix}-L_{FROM}_{TO}_{k}`
 *  - erDiagram 关系 `path`    id = `{prefix}-id_entity-{FROM}-{n}_entity-{TO}-{m}_{k}`
 *
 * stateDiagram 的边 id 只有序号、sequenceDiagram 的边没有可解析端点——这两类
 * 拿不到「边↔节点」的关联，安全降级为不挂联动（保留容器与图自身的默认观感）。
 * 淡出/高亮全部走 `is-focus` / `is-hot` class + CSS（doc.css），纯 class 驱动
 * 让样式状态随 outerHTML 快照进入灯箱。
 */

export interface MermaidRelation {
  /** 节点名 → g.node 元素 */
  nodes: Map<string, SVGGElement>
  /** 能解析出两端节点的边（label 是该边的文字标签，容器序对齐时才有） */
  edges: Array<{ el: SVGPathElement; from: string; to: string; label?: SVGGElement }>
}

/** 节点 g.node 的 id → 节点名；非节点形态返回 null */
export function parseMermaidNodeId(id: string): string | null {
  const match = /-(?:flowchart|entity|state)-(.+)-\d+$/.exec(id)
  return match ? (match[1] ?? null) : null
}

/**
 * 边 path 的 id → 两端节点名。
 *
 * 节点名本身可能含下划线（`my_node` 会被 mermaid 原样写进 id），`L_{A}_{B}`
 * 按分隔符切分就有歧义——所以拿全图已知节点名集合做最长前缀匹配，匹配不上
 * （未适配的图类型）返回 null，调用方按「无联动」处理。
 */
export function parseMermaidEdgeId(id: string, names: Set<string>): [string, string] | null {
  const flow = /-L_(.+)_(\d+)$/.exec(id)
  if (flow) {
    const body = flow[1] ?? ''
    const ordered = [...names].sort((a, b) => b.length - a.length)
    for (const from of ordered) {
      if (!body.startsWith(`${from}_`)) continue
      const to = body.slice(from.length + 1)
      if (names.has(to)) return [from, to]
    }
    return null
  }
  const er = /-id_entity-(.+)-\d+_entity-(.+)-\d+_\d+$/.exec(id)
  if (er) {
    const from = er[1] ?? ''
    const to = er[2] ?? ''
    if (names.has(from) && names.has(to)) return [from, to]
  }
  return null
}

/**
 * 边 path → 它的文字标签。
 *
 * 为什么不能用文档序配对（两个独立原因，都必须绕开）：
 *  1. mermaid 给**节点内部文字**也挂了 `edgeLabel` 类名，`g.edgeLabel` 总数会多于
 *     边数（实测 9 条边对应 11 个 edgeLabel，多出的两个父容器是 `.nodes`）；
 *  2. 标签序与 path 序并不一致——自环边 `C-->C` 在 path 序里排在最后，它的标签
 *     却按声明序出现在中间，按序配对会把标签挂到别人的边上。
 *
 * 可靠依据是**几何**：mermaid 给每个 edgeLabel 写了 `transform="translate(x,y)"`，
 * 那是标签的锚点，与 path 的坐标同属 SVG 用户坐标系；标签就画在它那条边的中点
 * 附近。因此取「path 中点 ↔ label 锚点」的最近邻贪心配对——两张真实图（含自环、
 * 平行边、无标签边）实测全部配对正确，最近距离 2~78px，次优候选都在 140px 以上。
 * 无标签的边没有 translate（锚点取不到），自然不参与配对。
 *
 * `getBBox()` / `getBoundingClientRect()` 不能用：前者在未挂载文档的 SVG 上返回
 * 全 0，后者在 `g` 上直接抛错。`getPointAtLength` 与 `transform.baseVal` 都可靠。
 */
function pairEdgeLabels(
  svg: SVGSVGElement,
  paths: SVGPathElement[],
): Map<SVGPathElement, SVGGElement> {
  const labelOfPath = new Map<SVGPathElement, SVGGElement>()
  // 只认 edgeLabels 容器内的标签：节点文字同样带 edgeLabel 类，混进来必然错配
  const labels = [...svg.querySelectorAll<SVGGElement>('g.edgeLabels > g.edgeLabel')]
  if (!labels.length) return labelOfPath

  const anchors = labels
    .map(label => {
      const list = label.transform?.baseVal
      const consolidated = list && list.numberOfItems > 0 ? list.consolidate() : null
      if (!consolidated) return null
      return { label, x: consolidated.matrix.e, y: consolidated.matrix.f }
    })
    .filter((item): item is { label: SVGGElement; x: number; y: number } => item !== null)
  if (!anchors.length) return labelOfPath

  const midpoints = paths.map(path => {
    try {
      const point = path.getPointAtLength(path.getTotalLength() / 2)
      return { x: point.x, y: point.y }
    } catch {
      return null
    }
  })

  const candidates: Array<{ pathIndex: number; anchorIndex: number; distance: number }> = []
  for (const [pathIndex, mid] of midpoints.entries()) {
    if (!mid) continue
    for (const [anchorIndex, anchor] of anchors.entries()) {
      const distance = Math.hypot(mid.x - anchor.x, mid.y - anchor.y)
      candidates.push({ pathIndex, anchorIndex, distance })
    }
  }
  candidates.sort((a, b) => a.distance - b.distance)
  const usedPath = new Set<number>()
  const usedAnchor = new Set<number>()
  for (const pair of candidates) {
    if (usedPath.has(pair.pathIndex) || usedAnchor.has(pair.anchorIndex)) continue
    const path = paths[pair.pathIndex]
    const anchor = anchors[pair.anchorIndex]
    if (!path || !anchor) continue
    usedPath.add(pair.pathIndex)
    usedAnchor.add(pair.anchorIndex)
    labelOfPath.set(path, anchor.label)
  }
  return labelOfPath
}

/** 收集可联动的节点与边；结构对不上（未适配图类型）返回 null */
export function buildMermaidRelation(svg: SVGSVGElement): MermaidRelation | null {
  const nodes = new Map<string, SVGGElement>()
  for (const g of svg.querySelectorAll<SVGGElement>('g.node')) {
    const name = parseMermaidNodeId(g.id)
    if (name) nodes.set(name, g)
  }
  if (nodes.size < 2) return null
  const allPaths = [
    ...svg.querySelectorAll<SVGPathElement>('path.flowchart-link, path.relationshipLine'),
  ]
  const labelOfPath = pairEdgeLabels(svg, allPaths)
  const edges: MermaidRelation['edges'] = []
  for (const path of allPaths) {
    const endpoints = parseMermaidEdgeId(path.id, new Set(nodes.keys()))
    if (!endpoints) continue
    edges.push({
      el: path,
      from: endpoints[0],
      to: endpoints[1],
      label: labelOfPath.get(path),
    })
  }
  if (!edges.length) return null
  return { nodes, edges }
}

/**
 * 给一份 mermaid SVG 挂 hover 联动，返回清理函数。
 *
 * 结构对不上的图类型直接返回 noop——增强必须是无副作用的：解析不了就
 * 保持 mermaid 原样，绝不半途挂一套错误的联动。
 */
export function enhanceMermaidSvg(svg: SVGSVGElement): () => void {
  const relation = buildMermaidRelation(svg)
  if (!relation) return () => {}

  /** 节点名 → 它的相邻边 */
  const adjacent = new Map<string, MermaidRelation['edges']>()
  for (const edge of relation.edges) {
    for (const name of [edge.from, edge.to]) {
      const list = adjacent.get(name) ?? []
      list.push(edge)
      adjacent.set(name, list)
    }
  }

  const hot = new Set<Element>()
  const mark = (el: Element, on: boolean): void => {
    if (on) {
      el.classList.add('is-hot')
      hot.add(el)
    } else {
      el.classList.remove('is-hot')
      hot.delete(el)
    }
  }
  /**
   * 高亮的边标签挪到自己容器的末尾：SVG 没有 z-index，绘制顺序即文档顺序，
   * 标签密集互相覆盖时，命中的那条要盖在别的标签上面才看得清。
   * 移动只发生在高亮瞬间，静默状态下顺序不变。
   */
  const raise = (label: SVGGElement | undefined): void => {
    label?.parentElement?.appendChild(label)
  }
  const clear = (): void => {
    svg.classList.remove('is-focus')
    for (const el of hot) el.classList.remove('is-hot')
    hot.clear()
  }
  const focusNode = (name: string): void => {
    clear()
    svg.classList.add('is-focus')
    const node = relation.nodes.get(name)
    if (node) mark(node, true)
    for (const edge of adjacent.get(name) ?? []) {
      mark(edge.el, true)
      raise(edge.label)
      if (edge.label) mark(edge.label, true)
      const otherEl = relation.nodes.get(edge.from === name ? edge.to : edge.from)
      if (otherEl) mark(otherEl, true)
    }
  }
  const focusEdge = (edge: MermaidRelation['edges'][number]): void => {
    clear()
    svg.classList.add('is-focus')
    mark(edge.el, true)
    raise(edge.label)
    if (edge.label) mark(edge.label, true)
    for (const name of [edge.from, edge.to]) {
      const el = relation.nodes.get(name)
      if (el) mark(el, true)
    }
  }
  const onOver = (event: PointerEvent): void => {
    const target = event.target as Element | null
    if (!target?.closest) return
    const node = target.closest('g.node')
    if (node) {
      const name = parseMermaidNodeId(node.id)
      if (name && relation.nodes.has(name)) {
        focusNode(name)
        return
      }
    }
    const path = target.closest('path.flowchart-link, path.relationshipLine')
    if (path) {
      const edge = relation.edges.find(item => item.el === path)
      if (edge) {
        focusEdge(edge)
        return
      }
    }
    // 边的文字标签：反查它所属的边，整条联动（文字挪到空白处不该丢掉高亮）
    const label = target.closest('g.edgeLabel')
    if (label) {
      const edge = relation.edges.find(item => item.label === label)
      if (edge) {
        focusEdge(edge)
        return
      }
    }
    // 既不在节点也不在边（空白 / 边标签 / cluster 底图）：立即清除——
    // pointerleave 只在离开整个 SVG 时触发，从节点挪到空白区必须在这里清，
    // 否则上一处的高亮一直挂着，看起来像「hover 范围非常大」
    clear()
  }
  svg.addEventListener('pointerover', onOver)
  svg.addEventListener('pointerleave', clear)
  return () => {
    clear()
    svg.removeEventListener('pointerover', onOver)
    svg.removeEventListener('pointerleave', clear)
  }
}
