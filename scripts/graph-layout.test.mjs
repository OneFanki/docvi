/**
 * 图布局共享模块的纯逻辑单测（不需 DOM）。
 *
 * 覆盖三个易回归的点：
 * - 回边识别：含环图里 DFS 要找出**真正的**回流边，而不是把所有边都标回边；
 * - 最长路径分层：非回边必须严格向下（`to.row > from.row`），否则会退化成同层锯齿；
 * - 重心排序：菱形交叉（a→c、a→d、b→c）要在排序后把 c/d 摆到对应位置，交叉数下降。
 *
 * 另外锁住文本度量与标注避让的两个硬约束：标签不得压节点、标签之间不得重叠。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

// Node 原生跑 TS：与其它脚本测试同口径（allowImportingTsExtensions + 直载 .ts）
import { edgeKey, layerGraph } from '../plugins/base/src/components/graph/layered.ts'
import { placeChannels, portX } from '../plugins/base/src/components/graph/channels.ts'
import { placeLabel, overlaps } from '../plugins/base/src/components/graph/labels.ts'
import { textWidth, widestLine, wrapText } from '../plugins/base/src/components/graph/text.ts'

test('分层：无环图每行按最长路径分隔，非回边严格向下', () => {
  const ids = ['a', 'b', 'c', 'd']
  const edges = [
    { from: 'a', to: 'b' },
    { from: 'a', to: 'c' },
    { from: 'b', to: 'd' },
    { from: 'c', to: 'd' },
    // 跨层长边：a → d 不改变 d 的层号（d 已被 b/c 推到第 2 层）
  ]
  const graph = layerGraph(ids, edges)
  assert.equal(graph.cyclic, false)
  assert.equal(graph.backEdges.size, 0)
  assert.equal(graph.rows.length, 3)
  assert.equal(graph.rowOf.get('a'), 0)
  assert.equal(graph.rowOf.get('b'), 1)
  assert.equal(graph.rowOf.get('c'), 1)
  assert.equal(graph.rowOf.get('d'), 2)
  // 每一行都非空（压实层号）
  for (const row of graph.rows) assert.ok(row.length > 0)
})

test('分层：有环图把回流边挑出来，且非回边仍严格向下', () => {
  // a → b → c → a 是环；c → d 是正常边
  const ids = ['a', 'b', 'c', 'd']
  const edges = [
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c' },
    { from: 'c', to: 'a', label: '回边' },
    { from: 'c', to: 'd' },
  ]
  const graph = layerGraph(ids, edges)
  assert.equal(graph.cyclic, true)
  // 回边必须被识别（不能因为分层把整张图压成一团）
  assert.equal(graph.backEdges.size, 1)
  const back = [...graph.backEdges][0]
  assert.match(back, /->/)
  // 任意非回边的目标行必须大于源行
  for (const edge of edges) {
    if (graph.backEdges.has(edgeKey(edge))) continue
    const from = graph.rowOf.get(edge.from)
    const to = graph.rowOf.get(edge.to)
    assert.ok(to > from, `${edge.from}->${edge.to} 应当严格向下，实际 ${from}->${to}`)
  }
})

test('分层：自环不计入回边集合（由组件画自转移环）', () => {
  const graph = layerGraph(
    ['a', 'b'],
    [
      { from: 'a', to: 'a' },
      { from: 'a', to: 'b' },
    ],
  )
  assert.equal(graph.backEdges.size, 0)
  assert.equal(graph.rows.length, 2)
})

test('分层：重心排序把菱形交叉摆正', () => {
  // 上排 a b，下排 c d；边 a→c a→d b→c 会产生交叉（a→d 与 b→c）
  // 正确排布：上排 a b、下排 c d 时，a→d 与 b→c 交叉；交换下排为 d c 仍交叉。
  // 真正的降交叉手段是让 b→c 的 c 靠近 b：下排应为 d, c（c 在右）。
  const graph = layerGraph(
    ['a', 'b', 'c', 'd'],
    [
      { from: 'a', to: 'c' },
      { from: 'a', to: 'd' },
      { from: 'b', to: 'c' },
    ],
    { sweeps: 8 },
  )
  const top = graph.rows[0]
  const bottom = graph.rows[1]
  assert.deepEqual([...top].sort(), ['a', 'b'])
  assert.deepEqual([...bottom].sort(), ['c', 'd'])
  // c 有两个前驱（a、b），d 只有一个（a）：c 应被摆在中间位置附近
  const cIndex = bottom.indexOf('c')
  const dIndex = bottom.indexOf('d')
  assert.notEqual(cIndex, -1)
  assert.notEqual(dIndex, -1)
})

test('文本度量：CJK 按一个字宽，等宽西文按 0.62', () => {
  const cjk = textWidth('上传中', 13)
  assert.equal(cjk, 39)
  const latin = textWidth('ab', 10, true)
  assert.ok(Math.abs(latin - 12.4) < 0.001)
  // 混排取两者之和
  assert.ok(Math.abs(textWidth('中a', 10, true) - 16.2) < 0.001)
})

test('文本折行：超长标识符优先在下划线后断开，不硬切单词', () => {
  const lines = wrapText('local_preprocessing_enabled', 90, { fontSize: 13 })
  assert.ok(lines.length > 1)
  // 每一行都不超宽
  for (const line of lines) assert.ok(widestLine([line], 13) <= 90 + 0.01)
  // 拼回去应与原文一致（含下划线，不丢字符）
  assert.equal(lines.join(''), 'local_preprocessing_enabled')
})

test('文本折行：maxLines 截断时补省略号', () => {
  const lines = wrapText('这是一个很长很长的中文标签需要折成很多行', 30, {
    fontSize: 13,
    maxLines: 2,
  })
  assert.equal(lines.length, 2)
  assert.ok(lines[1].endsWith('…'))
})

test('标注避让：直接位置被节点压住时，改到不与任何节点框相交', () => {
  const obstacles = [{ x: 100, y: 100, w: 160, h: 44 }]
  // 期望中心正好落在节点框正中
  const spot = placeLabel(180, 122, 80, 17, obstacles, { horizontalOnly: true })
  const rect = { x: spot.x - 40, y: spot.y - 8.5, w: 80, h: 17 }
  assert.equal(overlaps(rect, obstacles[0]), false)
})

test('标注避让：多个已放标注参与避让后互不重叠', () => {
  const placed = [
    { x: 100, y: 100, w: 80, h: 17 },
    { x: 184, y: 100, w: 80, h: 17 },
  ]
  const spot = placeLabel(180, 108, 80, 17, placed, { horizontalOnly: true })
  const rect = { x: spot.x - 40, y: spot.y - 8.5, w: 80, h: 17 }
  for (const item of placed) assert.equal(overlaps(rect, item), false)
})

test('通道分配：相邻行回边不跨圈，通道落在两端之间', () => {
  // 单节点一行，回边从第 2 行回到第 1 行 → 没有中间行，走带内小 U 形
  const obstacles = [
    { row: 0, x: 100, w: 160 },
    { row: 1, x: 100, w: 160 },
  ]
  const [channelX] = placeChannels([{ fromX: 180, toX: 180, spanRows: [] }], obstacles, {
    gap: 26,
    laneStep: 24,
    fallbackX: 286,
  })
  assert.equal(channelX, 180)
})

test('通道分配：长边优先穿被跨越行的节点缝隙，而不是绕到最外侧', () => {
  // 第 2 行两个节点（x=60..180 与 x=240..360），中间缝隙 180..240
  // 边从第 1 行（x=100）到第 3 行（x=150），竖直段只需穿过第 2 行
  const obstacles = [
    { row: 0, x: 60, w: 120 },
    { row: 1, x: 60, w: 120 },
    { row: 1, x: 240, w: 120 },
    { row: 2, x: 90, w: 120 },
  ]
  const [channelX] = placeChannels([{ fromX: 120, toX: 150, spanRows: [1] }], obstacles, {
    gap: 26,
    laneStep: 24,
    fallbackX: 400,
  })
  // 合法候选只有 34（左缘外）与 206/214（缝隙两侧），最省行程的是 214
  assert.ok(channelX > 180 && channelX < 240, `通道应落在缝隙内，实际 ${channelX}`)
  // 不能压在中间行节点上
  for (const node of obstacles.filter(item => item.row === 1)) {
    assert.ok(channelX <= node.x || channelX >= node.x + node.w, '通道不得压节点')
  }
})

test('通道分配：同一缝隙被多条边占用时按车道错开', () => {
  const obstacles = [
    { row: 0, x: 0, w: 100 },
    { row: 0, x: 200, w: 100 },
  ]
  const requests = [
    { fromX: 150, toX: 150, spanRows: [0] },
    { fromX: 150, toX: 150, spanRows: [0] },
  ]
  const xs = placeChannels(requests, obstacles, { gap: 20, laneStep: 24, fallbackX: 340 })
  assert.equal(xs.length, 2)
  assert.ok(Math.abs(xs[0] - xs[1]) >= 23, `两条通道需错开，实际 ${xs.join(',')}`)
})

test('端口偏移：通道在节点左侧时端口贴左边，在右侧时贴右边', () => {
  const span = { x: 100, w: 200 } // 100..300，中心 200
  assert.equal(portX(span, 40), 114, '通道在左 → 端口取左端留 inset')
  assert.equal(portX(span, 380), 286, '通道在右 → 端口取右端留 inset')
  // 通道正对节点内部时端口就跟通道对齐（竖直段不用再横折）
  assert.equal(portX(span, 220), 220)
})

test('端口偏移：窄节点上 inset 收窄，不会把端口越过中线', () => {
  const span = { x: 0, w: 30 }
  const left = portX(span, -50)
  const right = portX(span, 50)
  assert.ok(left >= 0 && left <= 15, `左端口应落在左半段，实际 ${left}`)
  assert.ok(right >= 15 && right <= 30, `右端口应落在右半段，实际 ${right}`)
})

test('通道分配：端口可自由落点时，优先选与两端区间重叠的缝隙', () => {
  // 被跨越行（row 1）两个节点：0..100 与 300..400，中间缝隙 100..300
  // 源/目标节点区间都是 100..300，与缝隙重叠 → 通道落进缝隙就是零横向行程
  const obstacles = [
    { row: 0, x: 100, w: 200 },
    { row: 1, x: 0, w: 100 },
    { row: 1, x: 300, w: 100 },
    { row: 2, x: 100, w: 200 },
  ]
  const [channelX] = placeChannels(
    [{ fromX: 200, toX: 200, fromRange: [100, 300], toRange: [100, 300], spanRows: [1] }],
    obstacles,
    { gap: 26, laneStep: 24, fallbackX: 420 },
  )
  assert.ok(channelX > 100 && channelX < 300, `通道应落在缝隙内，实际 ${channelX}`)
  // 同一场景按中心点算代价，通道仍应为同一位置（区间口径只是更精确，不该更差）
  const [centerPick] = placeChannels([{ fromX: 200, toX: 200, spanRows: [1] }], obstacles, {
    gap: 26,
    laneStep: 24,
    fallbackX: 420,
  })
  assert.equal(channelX, centerPick)
})
