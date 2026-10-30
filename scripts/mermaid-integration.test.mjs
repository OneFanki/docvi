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
const { buildMermaidRelation, parseMermaidEdgeId, parseMermaidNodeId } =
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

/* ---------- 联动构建 ---------- */

/** 构造一份结构探针同形态的假 SVG（DOMParser 不可用时的轻量替身） */
function fakeSvg() {
  const root = {
    id: 'docvi-1',
    classList: {
      _set: new Set(),
      add(c) {
        this._set.add(c)
      },
      delete(c) {
        this._set.delete(c)
      },
    },
    children: [],
  }
  const matches = (node, selector) =>
    selector.split(',').some(part => {
      const trimmed = part.trim()
      // 支持 `g.edgeLabels > g.edgeLabel` 这种直接子代选择器（几何配对依赖它）
      const [parentSel, childSel] = trimmed.split('>').map(item => item.trim())
      const test = (target, sel) => {
        const [tag, ...classes] = (sel ?? '').split('.')
        if (tag && tag !== '*' && target.tagName !== tag) return false
        return classes.every(cls => target.classList._set.has(cls))
      }
      if (!childSel) return test(node, parentSel)
      // 子代：node 必须匹配 childSel 且其父（通过 _parent 回溯）匹配 parentSel
      if (!test(node, childSel)) return false
      let parent = node._parent
      while (parent) {
        if (test(parent, parentSel)) return true
        parent = parent._parent
      }
      return false
    })
  root.querySelectorAll = selector => {
    const all = []
    const walk = list => {
      for (const node of list) {
        all.push(node)
        if (node.children) walk(node.children)
      }
    }
    walk(root.children)
    return all.filter(n => matches(n, selector))
  }
  const el = (tagName, id, cls, parent, geometry = {}) => {
    const node = {
      tagName,
      id,
      classList: {
        _set: new Set((cls ?? '').split(/\s+/).filter(Boolean)),
        add(c) {
          this._set.add(c)
        },
        delete(c) {
          this._set.delete(c)
        },
      },
      getAttribute: name => (name === 'class' ? [...node.classList._set].join(' ') : null),
      children: [],
      _parent: parent ?? root,
    }
    // 几何配对依赖这三个：path 中点 + label 的 transform 锚点
    if (geometry.mid) {
      node.getTotalLength = () => 100
      node.getPointAtLength = () => geometry.mid
    }
    if (geometry.translate) {
      node.transform = {
        baseVal: {
          numberOfItems: 1,
          consolidate: () => ({
            matrix: { e: geometry.translate.x, f: geometry.translate.y },
          }),
        },
      }
    } else {
      node.transform = { baseVal: { numberOfItems: 0, consolidate: () => null } }
    }
    ;(parent ?? root).children.push(node)
    return node
  }
  return { root, el }
}

test('buildMermaidRelation：边标签按几何最近邻配对（不用文档序）', () => {
  /*
   * mermaid 的标签序与 path 序不一致（自环边 path 排在最后、标签在中间），
   * 且节点文字也用 edgeLabel 类名。唯一可靠依据是几何：标签锚点
   * translate(x,y) 落在它那条边的中点附近。这里 path A→B 中点 (100,100)，
   * 标签锚点 (102,101) 距离 2px；另一个无关标签锚点在远处，不得被选中。
   */
  const { root, el } = fakeSvg()
  el('g', 'docvi-1-flowchart-A-0', 'node', root)
  el('g', 'docvi-1-flowchart-B-1', 'node', root)
  const pathAB = el('path', 'docvi-1-L_A_B_0', 'flowchart-link', root, {
    mid: { x: 100, y: 100 },
  })
  el('path', 'docvi-1-edge0', 'transition', root)
  // 标签必须挂在 edgeLabels 容器下（节点内文字也带 edgeLabel 类，直接挂根会被排除）
  const labelsContainer = el('g', '', 'edgeLabels', root)
  const near = el('g', '', 'edgeLabel', labelsContainer, { translate: { x: 102, y: 101 } })
  el('g', '', 'edgeLabel', labelsContainer, { translate: { x: 900, y: 900 } })
  const relation = buildMermaidRelation(root)
  assert.ok(relation)
  assert.equal(relation.edges.length, 1)
  assert.deepEqual([relation.edges[0].from, relation.edges[0].to], ['A', 'B'])
  assert.equal(relation.edges[0].label, near, '取最近的标签锚点')
  assert.equal(relation.edges[0].el, pathAB)
})

test('buildMermaidRelation：节点内部同名 edgeLabel 不参与配对', () => {
  const { root, el } = fakeSvg()
  el('g', 'docvi-1-flowchart-A-0', 'node', root)
  el('g', 'docvi-1-flowchart-B-1', 'node', root)
  el('path', 'docvi-1-L_A_B_0', 'flowchart-link', root, { mid: { x: 50, y: 50 } })
  const labelsContainer = el('g', '', 'edgeLabels', root)
  const real = el('g', '', 'edgeLabel', labelsContainer, { translate: { x: 52, y: 50 } })
  // 节点内部文字：位置更近，但不在 edgeLabels 容器里，必须被排除
  const nodesContainer = el('g', '', 'nodes', root)
  el('g', '', 'edgeLabel', nodesContainer, { translate: { x: 50, y: 50 } })
  const relation = buildMermaidRelation(root)
  assert.ok(relation)
  assert.equal(relation.edges[0].label, real)
})

test('buildMermaidRelation：无标签边不参与配对，其他边不受影响', () => {
  const { root, el } = fakeSvg()
  el('g', 'docvi-1-flowchart-A-0', 'node', root)
  el('g', 'docvi-1-flowchart-B-1', 'node', root)
  el('g', 'docvi-1-flowchart-C-2', 'node', root)
  // A→B 有标签，B→C 无标签（mermaid 不给无标签边写 translate）
  el('path', 'docvi-1-L_A_B_0', 'flowchart-link', root, { mid: { x: 100, y: 100 } })
  el('path', 'docvi-1-L_B_C_0', 'flowchart-link', root, { mid: { x: 300, y: 300 } })
  const labelsContainer = el('g', '', 'edgeLabels', root)
  const label = el('g', '', 'edgeLabel', labelsContainer, { translate: { x: 101, y: 100 } })
  const relation = buildMermaidRelation(root)
  assert.ok(relation)
  assert.equal(relation.edges.length, 2)
  const ab = relation.edges.find(edge => edge.el.id === 'docvi-1-L_A_B_0')
  const bc = relation.edges.find(edge => edge.el.id === 'docvi-1-L_B_C_0')
  assert.equal(ab.label, label)
  assert.equal(bc.label, undefined, '无标签边不该抢到别的标签')
})

test('buildMermaidRelation：个别边解析失败不影响其他边的标签（真实图回归）', () => {
  /*
   * 用户真实图（含自环 C→C、平行边 C→D、特殊字符节点名）：一条边 id 解析失败
   * 时，其余边必须照常拿到自己的标签。旧实现按「解析成功子集」配序，会整体错位。
   */
  const { root, el } = fakeSvg()
  el('g', 'docvi-1-flowchart-A-0', 'node', root)
  el('g', 'docvi-1-flowchart-B-1', 'node', root)
  el('g', 'docvi-1-flowchart-C-2', 'node', root)
  el('path', 'docvi-1-L_A_B_0', 'flowchart-link', root, { mid: { x: 100, y: 100 } })
  el('path', 'docvi-1-L_??_??_1', 'flowchart-link', root, { mid: { x: 200, y: 200 } })
  const pathBC = el('path', 'docvi-1-L_B_C_0', 'flowchart-link', root, { mid: { x: 300, y: 300 } })
  const labelsContainer = el('g', '', 'edgeLabels', root)
  const labelAB = el('g', '', 'edgeLabel', labelsContainer, { translate: { x: 101, y: 100 } })
  el('g', '', 'edgeLabel', labelsContainer, { translate: { x: 201, y: 200 } })
  const labelBC = el('g', '', 'edgeLabel', labelsContainer, { translate: { x: 301, y: 300 } })
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
