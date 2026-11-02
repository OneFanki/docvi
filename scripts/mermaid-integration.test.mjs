/**
 * mermaid 主题映射与 hover 联动解析的回归测试。
 *
 * 三块契约：
 *  1. themeVariables 映射——theme.css 的 --dv-mermaid-* 派生变量（mermaid-theme.ts）
 *     写进 mermaid base 主题的变量名；mermaid 内部要做颜色运算，任何 var() 泄漏
 *     都是 bug。
 *  2. SVG id 解析——mermaid 11.17 的节点/边 id 约定（结构探针
 *     scripts/dev/probe-mermaid-shape.mjs dump 的形态），节点名含下划线时
 *     边端点的最长匹配不能歧义。
 *  3. 联动构建——可解析的图类型给节点/边建邻接，解析不了的安全降级。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const { MERMAID_TOKENS, mermaidThemeVariables } =
  await import('../packages/renderer-core/src/mermaid-theme.ts')
const { buildMermaidRelation, parseMermaidEdgeId, parseMarkerRef, parseMermaidNodeId } =
  await import('../packages/renderer-core/src/mermaid-hover.ts')

/* ---------- 主题映射 ---------- */

test('themeVariables：token → mermaid 变量名映射齐全，无 var() 泄漏', () => {
  const fixed = token => {
    const palette = {
      '--dv-mermaid-bg': '#171a1f',
      '--dv-mermaid-node-bg': '#1d2127',
      '--dv-mermaid-node-border': '#3a414a',
      '--dv-mermaid-text': '#e8e5de',
      '--dv-mermaid-text-2': '#9a978f',
      '--dv-mermaid-line': '#46505c',
      '--dv-mermaid-accent': '#d9a05b',
      '--dv-mermaid-note-bg': '#1d2127',
      '--dv-mermaid-cluster-bg': '#171a1f',
      '--dv-mermaid-cat-1': '#6cae8f',
      '--dv-mermaid-cat-2': '#a396ff',
      '--dv-mermaid-cat-3': '#e88a9d',
      '--dv-mermaid-cat-4': '#85a8f0',
      '--dv-mermaid-cat-5': '#d9a05b',
      '--dv-mermaid-cat-6': '#98a2b0',
    }
    return palette[token] ?? ''
  }
  const vars = mermaidThemeVariables(fixed)
  assert.equal(vars.background, '#171a1f')
  assert.equal(vars.primaryColor, '#1d2127')
  assert.equal(vars.lineColor, '#46505c')
  assert.equal(vars.noteBkgColor, '#1d2127')
  assert.equal(vars.clusterBkg, '#171a1f')
  assert.equal(vars.cScale0, '#6cae8f')
  // 十二档轮换：cat-1 铺满 0 与 6
  assert.equal(vars.cScale6, '#6cae8f')
  assert.equal(vars.cScale11, '#98a2b0')
  for (const [key, value] of Object.entries(vars)) {
    assert.ok(!String(value).includes('var('), `themeVariables.${key} 泄漏了 var()：${value}`)
    assert.match(String(value), /^#[0-9a-f]+$/i, `themeVariables.${key} 不是具体色值：${value}`)
  }
})

test('themeVariables：取不到的 token（空串）跳过而不是写 undefined', () => {
  const vars = mermaidThemeVariables(() => '')
  assert.deepEqual(vars, {})
})

test('MERMAID_TOKENS 与映射表用的 token 完全一致', () => {
  // 收集 mermaidThemeVariables 实际读取的 token 名，必须都声明在 MERMAID_TOKENS 里
  const read = []
  mermaidThemeVariables(token => {
    read.push(token)
    return ''
  })
  for (const token of read) {
    assert.ok(MERMAID_TOKENS.includes(token), `映射读取了未声明的 token：${token}`)
  }
})

/* ---------- SVG id 解析 ---------- */

test('parseMermaidNodeId：flowchart / entity / state 三种节点形态', () => {
  assert.equal(parseMermaidNodeId('docvi-1-flowchart-A-0'), 'A')
  assert.equal(parseMermaidNodeId('docvi-1-entity-user-0'), 'user')
  assert.equal(parseMermaidNodeId('docvi-1-state-空闲-2'), '空闲')
  // 名字本身含连字符与下划线
  assert.equal(parseMermaidNodeId('docvi-1-flowchart-my_node-x-3'), 'my_node-x')
  assert.equal(parseMermaidNodeId('docvi-1-L_A_B_0'), null, '边 id 不是节点')
  assert.equal(parseMermaidNodeId(''), null)
})

test('parseMermaidEdgeId：flowchart 边带端点，节点名含下划线用最长匹配消歧', () => {
  const names = new Set(['my_node', 'B', 'A'])
  assert.deepEqual(parseMermaidEdgeId('docvi-1-L_A_B_0', names), ['A', 'B'])
  assert.deepEqual(parseMermaidEdgeId('docvi-1-L_my_node_B_1', names), ['my_node', 'B'])
  // 反向边（C --> B 之类）同样成立
  assert.deepEqual(parseMermaidEdgeId('docvi-1-L_B_my_node_0', names), ['B', 'my_node'])
  // 两端都不在已知集合：未适配图类型
  assert.equal(parseMermaidEdgeId('docvi-1-L_X_Y_0', names), null)
})

test('parseMermaidEdgeId：erDiagram 关系边解析两端实体', () => {
  const names = new Set(['user', 'order'])
  assert.deepEqual(parseMermaidEdgeId('docvi-1-id_entity-user-0_entity-order-1_0', names), [
    'user',
    'order',
  ])
  // 实体名带连字符
  const dashed = new Set(['order-item', 'product'])
  assert.deepEqual(
    parseMermaidEdgeId('docvi-1-id_entity-order-item-2_entity-product-3_1', dashed),
    ['order-item', 'product'],
  )
  // stateDiagram 的序号边：解析不了 → null
  assert.equal(parseMermaidEdgeId('docvi-1-edge0', new Set(['空闲', '运行'])), null)
})

test('parseMarkerRef：相对与绝对 URL 两种 marker 引用都能取出 id', () => {
  // mermaid 默认写 url(#id)
  assert.equal(parseMarkerRef('url(#docvi_flowchart-v2-pointEnd)'), 'docvi_flowchart-v2-pointEnd')
  // arrowMarkerAbsolute 打开时写完整 URL，仍是同一个 marker id
  assert.equal(
    parseMarkerRef('url(http://localhost:5173/doc#docvi_flowchart-v2-pointEnd)'),
    'docvi_flowchart-v2-pointEnd',
  )
  // 带引号的合法写法
  assert.equal(parseMarkerRef("url('#abc-1')"), 'abc-1')
  // 没有 url() / 没有 # 的值不是 marker 引用
  assert.equal(parseMarkerRef('none'), null)
  assert.equal(parseMarkerRef('url(foo)'), null)
  assert.equal(parseMarkerRef(''), null)
})

/* ---------- 联动构建 ---------- */

/**
 * 构造一份结构探针同形态的假 SVG（Node 里没有 DOM，测试只依赖
 * querySelectorAll / querySelector / getAttribute / classList 这几个契约）。
 */
function fakeSvg() {
  const matches = (node, selector) => {
    const [tag, ...classes] = selector.trim().split('.')
    if (tag && tag !== '*' && node.tagName !== tag) return false
    return classes.every(cls => node.classList.has(cls))
  }
  const descendants = node => {
    const all = []
    const walk = list => {
      for (const child of list) {
        all.push(child)
        walk(child.children)
      }
    }
    walk(node.children)
    return all
  }
  const root = {
    tagName: 'svg',
    id: 'docvi-1',
    classList: new Set(),
    children: [],
    querySelectorAll(selector) {
      const all = descendants(root)
      return selector.split(',').flatMap(part => {
        const [parentSel, childSel] = part
          .trim()
          .split('>')
          .map(item => item.trim())
        if (!childSel) return all.filter(node => matches(node, parentSel))
        // 直接子代：父节点必须匹配 parentSel
        return all.filter(
          node => matches(node, childSel) && node._parent && matches(node._parent, parentSel),
        )
      })
    },
  }
  const el = (tagName, id, cls, parent = root, attrs = {}) => {
    const node = {
      tagName,
      id,
      classList: new Set((cls ?? '').split(/\s+/).filter(Boolean)),
      attrs,
      children: [],
      _parent: parent,
      getAttribute(name) {
        if (name === 'class') return [...node.classList].join(' ')
        return attrs[name] ?? null
      },
      querySelector(selector) {
        return descendants(node).find(child => matches(child, selector)) ?? null
      },
    }
    parent.children.push(node)
    return node
  }
  return { root, el }
}

test('buildMermaidRelation：边标签按 data-id 精确配对（自环/平行边不乱序）', () => {
  /*
   * 标签序与 path 序不一致（自环边 path 排在最后、标签在中间），几何位置
   * 也可能互相靠近——唯一可靠的依据是 mermaid 写在 path 与标签上的同一个
   * edge.id。这里故意让标签顺序与 path 顺序相反，配对仍必须正确。
   */
  const { root, el } = fakeSvg()
  el('g', 'docvi-1-flowchart-A-0', 'node')
  el('g', 'docvi-1-flowchart-B-1', 'node')
  el('g', 'docvi-1-flowchart-C-2', 'node')
  const pathAB = el('path', 'docvi-1-L_A_B_0', 'flowchart-link', root, { 'data-id': 'L_A_B_0' })
  const pathCC = el('path', 'docvi-1-L_C_C_0', 'flowchart-link', root, { 'data-id': 'L_C_C_0' })
  const labels = el('g', '', 'edgeLabels')
  const labelCC = el('g', '', 'edgeLabel', labels)
  el('g', '', 'label', labelCC, { 'data-id': 'L_C_C_0' })
  // 平行边：同一对端点、不同标签，各自有独立 edge.id
  const pathAB2 = el('path', 'docvi-1-L_A_B_2', 'flowchart-link', root, { 'data-id': 'L_A_B_2' })
  const labelAB = el('g', '', 'edgeLabel', labels)
  el('g', '', 'label', labelAB, { 'data-id': 'L_A_B_0' })
  const labelAB2 = el('g', '', 'edgeLabel', labels)
  el('g', '', 'label', labelAB2, { 'data-id': 'L_A_B_2' })

  const relation = buildMermaidRelation(root)
  assert.ok(relation)
  const labelOf = pathId => relation.edges.find(edge => edge.el.id === pathId)?.label
  assert.equal(labelOf(pathAB.id), labelAB)
  assert.equal(labelOf(pathAB2.id), labelAB2)
  assert.equal(labelOf(pathCC.id), labelCC)
})

test('buildMermaidRelation：空文字边也有一致的 data-id，不抢别人的标签', () => {
  const { root, el } = fakeSvg()
  el('g', 'docvi-1-flowchart-A-0', 'node')
  el('g', 'docvi-1-flowchart-B-1', 'node')
  el('g', 'docvi-1-flowchart-C-2', 'node')
  const pathBC = el('path', 'docvi-1-L_B_C_0', 'flowchart-link', root, { 'data-id': 'L_B_C_0' })
  const pathAB = el('path', 'docvi-1-L_A_B_0', 'flowchart-link', root, { 'data-id': 'L_A_B_0' })
  const labels = el('g', '', 'edgeLabels')
  const emptyLabel = el('g', '', 'edgeLabel', labels)
  el('g', '', 'label', emptyLabel, { 'data-id': 'L_B_C_0' })
  const realLabel = el('g', '', 'edgeLabel', labels)
  el('g', '', 'label', realLabel, { 'data-id': 'L_A_B_0' })
  const relation = buildMermaidRelation(root)
  assert.ok(relation)
  const labelOf = pathId => relation.edges.find(edge => edge.el.id === pathId)?.label
  assert.equal(labelOf(pathBC.id), emptyLabel)
  assert.equal(labelOf(pathAB.id), realLabel)
})

test('buildMermaidRelation：节点内部同名 edgeLabel 不参与配对', () => {
  const { root, el } = fakeSvg()
  el('g', 'docvi-1-flowchart-A-0', 'node')
  el('g', 'docvi-1-flowchart-B-1', 'node')
  el('path', 'docvi-1-L_A_B_0', 'flowchart-link', root, { 'data-id': 'L_A_B_0' })
  const labels = el('g', '', 'edgeLabels')
  const real = el('g', '', 'edgeLabel', labels)
  el('g', '', 'label', real, { 'data-id': 'L_A_B_0' })
  // 节点内部文字：同一个类名、同一个 data-id，但不在 edgeLabels 容器里，必须排除
  const nodes = el('g', '', 'nodes')
  const decoy = el('g', '', 'edgeLabel', nodes)
  el('g', '', 'label', decoy, { 'data-id': 'L_A_B_0' })
  const relation = buildMermaidRelation(root)
  assert.ok(relation)
  assert.equal(relation.edges[0].label, real)
})

test('buildMermaidRelation：标签缺 data-id 不配对，其他边不受影响', () => {
  const { root, el } = fakeSvg()
  el('g', 'docvi-1-flowchart-A-0', 'node')
  el('g', 'docvi-1-flowchart-B-1', 'node')
  el('g', 'docvi-1-flowchart-C-2', 'node')
  const pathAB = el('path', 'docvi-1-L_A_B_0', 'flowchart-link', root, { 'data-id': 'L_A_B_0' })
  const pathBC = el('path', 'docvi-1-L_B_C_0', 'flowchart-link', root, { 'data-id': 'L_B_C_0' })
  const labels = el('g', '', 'edgeLabels')
  const labelAB = el('g', '', 'edgeLabel', labels)
  el('g', '', 'label', labelAB, { 'data-id': 'L_A_B_0' })
  const labelBC = el('g', '', 'edgeLabel', labels)
  el('g', '', 'label', labelBC) // 老版本/未预期形态：拿不到 edge.id
  const relation = buildMermaidRelation(root)
  assert.ok(relation)
  assert.equal(relation.edges.length, 2)
  assert.equal(relation.edges.find(edge => edge.el === pathAB)?.label, labelAB)
  assert.equal(relation.edges.find(edge => edge.el === pathBC)?.label, undefined)
})

test('buildMermaidRelation：个别边解析失败不影响其他边的标签（真实图回归）', () => {
  /*
   * 用户真实图（含自环 C→C、平行边 C→D、特殊字符节点名）：一条边 id 解析失败
   * 时，其余边必须照常拿到自己的标签。
   */
  const { root, el } = fakeSvg()
  el('g', 'docvi-1-flowchart-A-0', 'node')
  el('g', 'docvi-1-flowchart-B-1', 'node')
  el('g', 'docvi-1-flowchart-C-2', 'node')
  el('path', 'docvi-1-L_A_B_0', 'flowchart-link', root, { 'data-id': 'L_A_B_0' })
  el('path', 'docvi-1-L_??_??_1', 'flowchart-link', root, { 'data-id': 'L_??_??_1' })
  const pathBC = el('path', 'docvi-1-L_B_C_0', 'flowchart-link', root, { 'data-id': 'L_B_C_0' })
  const labels = el('g', '', 'edgeLabels')
  const labelAB = el('g', '', 'edgeLabel', labels)
  el('g', '', 'label', labelAB, { 'data-id': 'L_A_B_0' })
  const failedLabel = el('g', '', 'edgeLabel', labels)
  el('g', '', 'label', failedLabel, { 'data-id': 'L_??_??_1' })
  const labelBC = el('g', '', 'edgeLabel', labels)
  el('g', '', 'label', labelBC, { 'data-id': 'L_B_C_0' })
  const relation = buildMermaidRelation(root)
  assert.ok(relation)
  assert.equal(relation.edges.length, 2)
  assert.equal(relation.edges[0].label, labelAB)
  assert.equal(relation.edges[1].el, pathBC)
  assert.equal(relation.edges[1].label, labelBC, '失败边之后的边仍拿到自己的标签')
})

test('buildMermaidRelation：边全解析不了（stateDiagram）→ 安全降级 null', () => {
  const { root, el } = fakeSvg()
  el('g', 'docvi-1-state-空闲-0', 'node', root)
  el('g', 'docvi-1-state-运行-1', 'node', root)
  el('path', 'docvi-1-edge0', 'transition', root)
  el('path', 'docvi-1-edge1', 'transition', root)
  assert.equal(buildMermaidRelation(root), null)
})

test('buildMermaidRelation：节点不足两个 → null（enhance 保持 mermaid 原样）', () => {
  const { root, el } = fakeSvg()
  el('g', 'docvi-1-flowchart-A-0', 'node', root)
  el('path', 'docvi-1-L_A_B_0', 'flowchart-link', root)
  assert.equal(buildMermaidRelation(root), null)
})
