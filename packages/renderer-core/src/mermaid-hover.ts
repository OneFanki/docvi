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
 * `marker-end` 属性的值 → marker 的 id。
 *
 * mermaid 写的是 `url(#xxx)` 或 `url(http://host/path#xxx)`（后者在
 * `flowchart.arrowMarkerAbsolute` 打开时出现，用于导出后仍能工作），
 * 两种都要能取出 `#` 后面那段——只认 `#` 前缀会漏掉绝对 URL 形态。
 */
export function parseMarkerRef(value: string): string | null {
  const match = /url\(\s*['"]?[^'")]*#([^'")]+)['"]?\s*\)/.exec(value)
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
 * 可靠依据是 mermaid 生成的 `data-id`：边 path 上是 `data-id="L_A_B_0"`，
 * 标签里那层 `g.label` 上写的是同一个 edge.id（见 mermaid 的 insertEdgeLabel）。
 * 按它配对与文档序、几何位置都无关，自环/平行边/密集标签也不会错位——
 * `g.edgeLabel` 与边一一对应，没写文字的边同样有一个空的标签组。
 *
 * 不能用文档序：mermaid 给**节点内部文字**也挂了 `edgeLabel` 类名，
 * `g.edgeLabel` 总数会多于边数；标签序与 path 序也不一致（自环边 path
 * 排在最后、标签却在中间）。
 *
 * 也不能用几何最近邻：标签的 `transform=translate(x,y)` 锚点与 path 中点
 * 只是大致接近，平行边或标签密集时会整体错位——hover 时表现为标签
 * 整片高亮或整片淡出，正是这条路径不可靠的地方。
 */
function pairEdgeLabels(
  svg: SVGSVGElement,
  paths: SVGPathElement[],
): Map<SVGPathElement, SVGGElement> {
  const labelOfPath = new Map<SVGPathElement, SVGGElement>()
  // 只认 edgeLabels 容器内的标签：节点文字同样带 edgeLabel 类，混进来必然错配
  const labels = [...svg.querySelectorAll<SVGGElement>('g.edgeLabels > g.edgeLabel')]
  if (!labels.length) return labelOfPath

  const labelByEdgeId = new Map<string, SVGGElement>()
  for (const label of labels) {
    const edgeId = label.querySelector('g.label')?.getAttribute('data-id')
    if (edgeId) labelByEdgeId.set(edgeId, label)
  }
  for (const path of paths) {
    const edgeId = path.getAttribute('data-id')
    const label = edgeId ? labelByEdgeId.get(edgeId) : undefined
    if (label) labelOfPath.set(path, label)
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

  /** 标签原始 transform：错位后 clear 时必须逐个还原 */
  const displaced = new Map<SVGGElement, string>()
  const restoreLabels = (): void => {
    for (const [label, transform] of displaced) {
      if (transform) label.setAttribute('transform', transform)
      else label.removeAttribute('transform')
    }
    displaced.clear()
  }

  /** 元素在根用户坐标系里的锚点（mermaid 用 transform=translate 定位） */
  const anchorOf = (el: Element): { x: number; y: number } | null => {
    const matrix = (el as SVGGElement).transform?.baseVal?.consolidate?.()
    return matrix ? { x: matrix.matrix.e, y: matrix.matrix.f } : null
  }
  interface Box {
    x: number
    y: number
    width: number
    height: number
  }
  const boxAt = (anchor: { x: number; y: number }, local: DOMRect): Box => ({
    x: anchor.x + local.x,
    y: anchor.y + local.y,
    width: local.width,
    height: local.height,
  })
  /** 两个框的相交面积（膨胀 gap 后比较，留出视觉间距） */
  const overlapArea = (a: Box, b: Box, gap: number): number => {
    const width =
      Math.min(a.x + a.width + gap, b.x + b.width + gap) - Math.max(a.x - gap, b.x - gap)
    const height =
      Math.min(a.y + a.height + gap, b.y + b.height + gap) - Math.max(a.y - gap, b.y - gap)
    return width > 0 && height > 0 ? width * height : 0
  }

  /**
   * 高亮标签互相压字时，沿各自的边路径找空位。
   *
   * 为什么必须处理：mermaid 把同一节点的多条出边标签都放在各自路径的中点，
   * 这些路径在节点附近本就重叠——用户那张图里 `C-->C` 自环与 `C-->E` 的标签
   * 圆心只差 14px、而标签高 24px，叠成一团读不出字。挪动只发生在高亮瞬间，
   * 且**只沿自己的边**移动（标签仍在它那条线上，不是凭空飘走）。
   *
   * 处理顺序按路径长度**升序**：自环、短边的可动范围最小（路径短，取到的
   * 候选点都挤在一起），让它们先挑；长边后挑、可动范围大。反过来做就会出现
   * 「长边占了短边唯一能去的位置」，短边无处可去只能留在原地继续压字。
   *
   * 候选点密集排布（不只取中点），并避开其他高亮标签与所有节点框；
   * 全都有冲突时退化为冲突面积最小的那个。
   */
  const placeLabels = (): void => {
    const hotEdges = relation.edges
      .filter(edge => edge.label && edge.label.classList.contains('is-hot'))
      .map(edge => {
        let length = 0
        try {
          length = edge.el.getTotalLength()
        } catch {
          length = 0
        }
        return { edge, length }
      })
      .sort((a, b) => a.length - b.length)
    if (hotEdges.length < 2) return

    // 节点框作为障碍：标签错位时不能压到节点文字上
    const nodeBoxes = [...relation.nodes.values()].flatMap(node => {
      const anchor = anchorOf(node)
      if (!anchor) return []
      try {
        return [boxAt(anchor, node.getBBox())]
      } catch {
        return []
      }
    })

    const placed: Box[] = []
    const scoreOf = (candidate: Box): number => {
      let score = 0
      for (const other of placed) score += overlapArea(candidate, other, 4)
      for (const node of nodeBoxes) score += overlapArea(candidate, node, 2) * 2
      return score
    }
    // 沿路径向两端逐渐扩散：越远的位置越可能离开重叠区
    const ratios = [0.6, 0.7, 0.8, 0.9, 0.5, 0.4, 0.3, 0.65, 0.75, 0.85, 0.95, 0.45, 0.35, 0.25]
    /**
     * 局部平移兜底：沿路径找不到位置时（自环整条都挤在同一片区域，又被上下
     * 的节点框夹住），在锚点周围做小范围平移。位移刻意压得很小（横向 ±48、
     * 纵向两行以内）——标签离自己的边太远，读者就认不出它属于哪条线，
     * 那种「不重叠但看不懂」比轻微重叠更糟。
     */
    const shiftsFor = (height: number): Array<{ x: number; y: number }> => {
      const step = height + 8
      const xs = [0, 24, -24, 48, -48]
      const ys = [0, step, -step, step * 2, -step * 2]
      return xs
        .flatMap(x => ys.map(y => ({ x, y })))
        .sort((a, b) => Math.abs(a.x) + Math.abs(a.y) - (Math.abs(b.x) + Math.abs(b.y)))
    }
    for (const { edge } of hotEdges) {
      const label = edge.label
      if (!label) continue
      const local = (() => {
        try {
          return label.getBBox()
        } catch {
          return null
        }
      })()
      const start = anchorOf(label)
      if (!local || !start) continue
      const path = edge.el
      const original = boxAt(start, local)
      let best = { anchor: start, box: original, score: scoreOf(original) }
      if (best.score === 0) {
        placed.push(best.box)
        continue
      }
      let totalLength = 0
      try {
        totalLength = path.getTotalLength()
      } catch {
        totalLength = 0
      }
      for (const ratio of ratios) {
        if (!totalLength) break
        let anchor: { x: number; y: number }
        try {
          const point = path.getPointAtLength(totalLength * ratio)
          anchor = { x: point.x, y: point.y }
        } catch {
          continue
        }
        const candidate = boxAt(anchor, local)
        const score = scoreOf(candidate)
        if (score === 0) {
          best = { anchor, box: candidate, score: 0 }
          break
        }
        if (score < best.score) best = { anchor, box: candidate, score }
      }
      /*
       * 路径候选点全是冲突时（自环、短边整条都挤在同一片区域，还可能被
       * 上下两个节点框夹住），在锚点周围做小范围平移兜底。
       */
      if (best.score > 0) {
        for (const shift of shiftsFor(local.height)) {
          const anchor = { x: start.x + shift.x, y: start.y + shift.y }
          const candidate = boxAt(anchor, local)
          const score = scoreOf(candidate)
          if (score === 0) {
            best = { anchor, box: candidate, score: 0 }
            break
          }
          if (score < best.score) best = { anchor, box: candidate, score }
        }
      }
      if (best.anchor) {
        const current = anchorOf(label)
        if (
          !current ||
          Math.abs(current.x - best.anchor.x) > 0.5 ||
          Math.abs(current.y - best.anchor.y) > 0.5
        ) {
          if (!displaced.has(label)) displaced.set(label, label.getAttribute('transform') ?? '')
          label.setAttribute('transform', `translate(${best.anchor.x}, ${best.anchor.y})`)
        }
      }
      placed.push(best.box)
    }
  }
  /**
   * 箭头标记（`<marker>`）不能按边高亮——mermaid 按「图 + 箭头类型」只定义一份，
   * 同图里所有实线箭头共用同一个 marker，改它的颜色会连带点亮所有边，这正是
   * 早先「要么全亮要么全不亮」的另一半来源。这里给高亮的边克隆一份专属 marker，
   * 把它的 `marker-start/end` 指过去；clear 时还原原引用。
   *
   * 克隆体的颜色交给 CSS（`.is-hot-marker`），主题一换自动跟随；哪些子元素
   * 原本就填了色/描了边用 data 属性标出来，避免给空心标记（cross、圆点）硬填。
   */
  const hotMarkerIds = new Map<string, string>()
  const markerBackup = new Map<SVGPathElement, { start: string | null; end: string | null }>()

  const isPainted = (value: string | null | undefined): boolean =>
    Boolean(value) && value !== 'none' && value !== 'transparent' && value !== 'rgba(0, 0, 0, 0)'

  const cloneMarkerFor = (path: SVGPathElement, position: 'start' | 'end'): void => {
    const attribute = `marker-${position}`
    const value = path.getAttribute(attribute)
    const markerId = value ? parseMarkerRef(value) : null
    if (!value || !markerId) return

    let hotId = hotMarkerIds.get(markerId)
    if (!hotId) {
      const original = [...svg.querySelectorAll<SVGMarkerElement>('marker')].find(
        marker => marker.id === markerId,
      )
      const host = original?.parentElement
      if (!original || !host) return
      hotId = `${markerId}--hot`
      const clone = original.cloneNode(true) as SVGMarkerElement
      clone.id = hotId
      clone.classList.add('is-hot-marker')
      // 必须先挂进文档再读计算样式：detached 元素上 getComputedStyle 全空
      host.appendChild(clone)
      // 空心标记只描边、实心标记才填色：按原渲染结果判断，不猜箭头类型
      for (const shape of clone.querySelectorAll('path, circle, polygon, line')) {
        const style = getComputedStyle(shape)
        if (isPainted(style.stroke)) shape.setAttribute('data-hot-stroke', '')
        if (isPainted(style.fill)) shape.setAttribute('data-hot-fill', '')
      }
      hotMarkerIds.set(markerId, hotId)
    }

    if (!markerBackup.has(path)) {
      markerBackup.set(path, {
        start: path.getAttribute('marker-start'),
        end: path.getAttribute('marker-end'),
      })
    }
    path.setAttribute(attribute, value.replace(`#${markerId}`, `#${hotId}`))
  }
  const restoreMarkers = (): void => {
    for (const [path, backup] of markerBackup) {
      for (const position of ['start', 'end'] as const) {
        const value = backup[position]
        if (value) path.setAttribute(`marker-${position}`, value)
        else path.removeAttribute(`marker-${position}`)
      }
    }
    markerBackup.clear()
  }

  const clear = (): void => {
    svg.classList.remove('is-focus')
    restoreLabels()
    restoreMarkers()
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
      cloneMarkerFor(edge.el, 'start')
      cloneMarkerFor(edge.el, 'end')
      raise(edge.label)
      if (edge.label) mark(edge.label, true)
      const otherEl = relation.nodes.get(edge.from === name ? edge.to : edge.from)
      if (otherEl) mark(otherEl, true)
    }
    // 一个节点常有 2~4 条出边，它们的标签是唯一会同时高亮、且可能互相压住的一组
    try {
      placeLabels()
    } catch {
      // 取不到几何（未布局/异常形态）就保持原位，宁可挤一点也不报错
    }
  }
  const focusEdge = (edge: MermaidRelation['edges'][number]): void => {
    clear()
    svg.classList.add('is-focus')
    mark(edge.el, true)
    cloneMarkerFor(edge.el, 'start')
    cloneMarkerFor(edge.el, 'end')
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
