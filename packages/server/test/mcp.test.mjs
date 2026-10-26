/**
 * MCP 协议契约测试（服务层，单一实现）：只测协议行为，不测宿主——
 * 工具面的数据全部由 deps 注入，因此这些用例在容器与桌面两端都成立。
 *
 * 覆盖：
 * - initialize 版本协商（已知版本回显 / 未知版本回最新）、serverName 覆写
 * - 通知 → 202 空体；批量数组 → -32600（400）；解析失败 → -32700（400）
 * - 未知方法 → -32601；缺参 / 未知工具 → -32602；内部异常 → -32603
 * - tools/list 全量六工具；检索依赖缺席时后两个不列出（工具面 = 宿主能力）
 * - tools/call 六个工具的输出形态、limit 钳制与活查询口径
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { handleMcp, toolNames } from '../src/mcp.mjs'

function mockRes() {
  const res = {
    status: 0,
    headers: {},
    body: '',
    headersSent: false,
    writeHead(status, headers = {}) {
      res.status = status
      res.headers = headers
      res.headersSent = true
    },
    end(chunk = '') {
      res.body += chunk
      return res
    },
  }
  return res
}

function makeDeps(overrides = {}) {
  const calls = []
  const deps = {
    serverVersion: '9.9.9-test',
    listPlugins: () => {
      calls.push('listPlugins')
      return [
        {
          name: 'demo',
          displayName: { zh: '示例包', en: 'Demo' },
          version: '1.0.0',
          builtin: false,
        },
      ]
    },
    listComponents: () => {
      calls.push('listComponents')
      return [
        {
          kind: 'flow-diagram',
          title: { zh: '流程图', en: 'Flow' },
          description: { zh: '有序流程', en: 'Ordered flow' },
          plugin: 'demo',
        },
      ]
    },
    componentDocs: kind => (kind === 'flow-diagram' ? '# 用法' : null),
    pluginDocs: name => (name === 'demo' ? '# 包用法' : null),
    searchDocs: (query, limit) => {
      calls.push({ search: query, limit })
      return query === '空'
        ? []
        : [{ workspace: '文档@main', path: 'guides/a.md', title: 'A', snippet: '命中片段' }]
    },
    readDoc: path =>
      path === 'missing.md'
        ? '没有找到文档：missing.md'
        : { workspace: '文档@main', path, title: 'A', text: '# A\n\n正文' },
    ...overrides,
  }
  return { deps, calls }
}

/** 发一条 JSON-RPC 消息，返回响应状态与解析后的响应体 */
async function call(deps, message) {
  const res = mockRes()
  const req = { headersSent: false }
  const chunks = [Buffer.from(JSON.stringify(message), 'utf8')]
  // handleMcp 只用到 req.on 的事件流接口
  req.on = (event, handler) => {
    if (event === 'data') for (const chunk of chunks) handler(chunk)
    if (event === 'end') handler()
    return req
  }
  await handleMcp(req, res, deps)
  return { res, body: res.body ? JSON.parse(res.body) : null }
}

test('initialize：已知协议版本回显，未知回最新；serverInfo 默认 docvi、可覆写', async () => {
  const { deps } = makeDeps()
  const known = await call(deps, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18' },
  })
  assert.equal(known.body.result.protocolVersion, '2025-06-18')
  assert.equal(known.body.result.serverInfo.version, '9.9.9-test')
  assert.deepEqual(known.body.result.serverInfo.name, 'docvi')
  assert.ok(known.body.result.capabilities.tools)

  const unknown = await call(deps, {
    jsonrpc: '2.0',
    id: 2,
    method: 'initialize',
    params: { protocolVersion: '1999-01-01' },
  })
  assert.equal(unknown.body.result.protocolVersion, '2026-07-28')

  const named = await call(makeDeps({ serverName: 'example-mcp' }).deps, {
    jsonrpc: '2.0',
    id: 3,
    method: 'initialize',
  })
  assert.equal(named.body.result.serverInfo.name, 'example-mcp', '宿主可覆盖自报平台名')
})

test('通知：无 id 回 202 且空体', async () => {
  const { deps } = makeDeps()
  const { res } = await call(deps, { jsonrpc: '2.0', method: 'notifications/initialized' })
  assert.equal(res.status, 202)
  assert.equal(res.body, '')
})

test('解析失败与批量数组：-32700 / -32600 且 HTTP 400', async () => {
  const { deps } = makeDeps()
  const res = mockRes()
  const req = {
    on(event, handler) {
      if (event === 'data') handler(Buffer.from('{ 不是 JSON', 'utf8'))
      if (event === 'end') handler()
      return req
    },
  }
  await handleMcp(req, res, deps)
  assert.equal(res.status, 400)
  assert.equal(JSON.parse(res.body).error.code, -32700)

  const batch = await call(deps, [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }])
  assert.equal(batch.res.status, 400)
  assert.equal(batch.body.error.code, -32600)
})

test('未知方法与未知工具：-32601 / -32602', async () => {
  const { deps } = makeDeps()
  const unknownMethod = await call(deps, { jsonrpc: '2.0', id: 3, method: 'nope' })
  assert.equal(unknownMethod.body.error.code, -32601)

  const unknownTool = await call(deps, {
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'nope', arguments: {} },
  })
  assert.equal(unknownTool.body.error.code, -32602)
})

test('tools/list：全量六个工具、都有 inputSchema，处理器不进输出', async () => {
  const { deps } = makeDeps()
  const { body } = await call(deps, { jsonrpc: '2.0', id: 5, method: 'tools/list' })
  assert.deepEqual(
    body.result.tools.map(tool => tool.name),
    [
      'list_plugins',
      'list_components',
      'get_component_docs',
      'get_plugin_docs',
      'search_docs',
      'read_doc',
    ],
  )
  assert.equal(toolNames().length, 6)
  for (const tool of body.result.tools) {
    assert.equal(tool.inputSchema.type, 'object')
    assert.ok(tool.description.length > 10, `${tool.name} 需要可读描述`)
    assert.equal(tool.handler, undefined, '处理器是实现细节，不进 tools/list')
  }
  const search = body.result.tools.find(tool => tool.name === 'search_docs')
  assert.deepEqual(search.inputSchema.required, ['query'])
  const read = body.result.tools.find(tool => tool.name === 'read_doc')
  assert.deepEqual(read.inputSchema.required, ['path'])
})

test('工具面 = 宿主能力：检索依赖缺席时只列四个插件工具', async () => {
  const { deps } = makeDeps()
  delete deps.searchDocs
  delete deps.readDoc
  const { body } = await call(deps, { jsonrpc: '2.0', id: 6, method: 'tools/list' })
  assert.deepEqual(
    body.result.tools.map(tool => tool.name),
    ['list_plugins', 'list_components', 'get_component_docs', 'get_plugin_docs'],
  )

  const init = await call(deps, { jsonrpc: '2.0', id: 7, method: 'initialize' })
  assert.doesNotMatch(init.body.result.instructions, /search_docs/, '无检索能力时不提该工作流')

  const denied = await call(deps, {
    jsonrpc: '2.0',
    id: 8,
    method: 'tools/call',
    params: { name: 'search_docs', arguments: { query: 'a' } },
  })
  assert.equal(denied.body.error.code, -32602, '未声明的工具按未知工具处理')
})

test('tools/call：六个工具返回文本内容且 isError=false', async () => {
  const { deps } = makeDeps()
  const cases = [
    { name: 'list_plugins', arguments: {}, expect: '示例包' },
    { name: 'list_components', arguments: {}, expect: 'flow-diagram' },
    { name: 'get_component_docs', arguments: { kind: 'flow-diagram' }, expect: '# 用法' },
    { name: 'get_plugin_docs', arguments: { name: 'demo' }, expect: '# 包用法' },
    { name: 'search_docs', arguments: { query: '流程' }, expect: 'guides/a.md' },
    { name: 'read_doc', arguments: { path: 'guides/a.md' }, expect: '# A' },
  ]
  for (const item of cases) {
    const { body } = await call(deps, {
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: { name: item.name, arguments: item.arguments },
    })
    assert.equal(body.result.isError, false, item.name)
    assert.equal(body.result.content[0].type, 'text')
    assert.ok(
      body.result.content[0].text.includes(item.expect),
      `${item.name} 应包含 ${item.expect}`,
    )
  }
})

test('search_docs：limit 缺省 10、上限 30；无命中是正常答案', async () => {
  const { deps, calls } = makeDeps()
  const first = await call(deps, {
    jsonrpc: '2.0',
    id: 11,
    method: 'tools/call',
    params: { name: 'search_docs', arguments: { query: '流程' } },
  })
  assert.deepEqual(calls.at(-1), { search: '流程', limit: 10 })

  await call(deps, {
    jsonrpc: '2.0',
    id: 12,
    method: 'tools/call',
    params: { name: 'search_docs', arguments: { query: '流程', limit: 999 } },
  })
  assert.deepEqual(calls.at(-1), { search: '流程', limit: 30 })

  assert.ok(first.body.result.content[0].text.includes('guides/a.md'))
  assert.ok(first.body.result.content[0].text.includes('命中片段'))

  const empty = await call(deps, {
    jsonrpc: '2.0',
    id: 13,
    method: 'tools/call',
    params: { name: 'search_docs', arguments: { query: '空' } },
  })
  assert.equal(empty.body.result.isError, false, '无命中是正常答案')
  assert.ok(empty.body.result.content[0].text.includes('没有匹配'))

  const invalid = await call(deps, {
    jsonrpc: '2.0',
    id: 14,
    method: 'tools/call',
    params: { name: 'search_docs', arguments: { query: 'a', limit: 0 } },
  })
  assert.equal(invalid.body.error.code, -32602)
})

test('read_doc：成功给头部 + 全文；失败说明原样透出且不是协议错误', async () => {
  const { deps } = makeDeps()
  const ok = await call(deps, {
    jsonrpc: '2.0',
    id: 15,
    method: 'tools/call',
    params: { name: 'read_doc', arguments: { path: 'guides/a.md' } },
  })
  const text = ok.body.result.content[0].text
  assert.match(text, /^workspace: 文档@main ｜ path: guides\/a\.md ｜ title: A\n\n# A/)

  const missing = await call(deps, {
    jsonrpc: '2.0',
    id: 16,
    method: 'tools/call',
    params: { name: 'read_doc', arguments: { path: 'missing.md' } },
  })
  assert.equal(missing.body.result.isError, false)
  assert.equal(missing.body.result.content[0].text, '没有找到文档：missing.md')
})

test('活查询：插件停用后 list_plugins 与 list_components 立即反映', async () => {
  let enabled = true
  const { deps } = makeDeps({
    listPlugins: () =>
      enabled ? [{ name: 'demo', displayName: '示例', version: '1.0.0', builtin: false }] : [],
    listComponents: () =>
      enabled ? [{ kind: 'flow-diagram', title: '流程', description: 'x', plugin: 'demo' }] : [],
  })
  const before = await call(deps, {
    jsonrpc: '2.0',
    id: 11,
    method: 'tools/call',
    params: { name: 'list_components', arguments: {} },
  })
  assert.ok(before.body.result.content[0].text.includes('flow-diagram'))

  enabled = false
  const after = await call(deps, {
    jsonrpc: '2.0',
    id: 12,
    method: 'tools/call',
    params: { name: 'list_components', arguments: {} },
  })
  assert.ok(after.body.result.content[0].text.includes('没有活跃组件'))
})

test('kind 永不翻译：请求不存在 kind 时提示先 list_components', async () => {
  const { deps } = makeDeps()
  const { body } = await call(deps, {
    jsonrpc: '2.0',
    id: 13,
    method: 'tools/call',
    params: { name: 'get_component_docs', arguments: { kind: '不存在' } },
  })
  assert.ok(body.result.content[0].text.includes('不存在'))
  assert.ok(body.result.content[0].text.includes('list_components'))
})

test('缺必填参数：-32602', async () => {
  const { deps } = makeDeps()
  const { body } = await call(deps, {
    jsonrpc: '2.0',
    id: 14,
    method: 'tools/call',
    params: { name: 'get_component_docs', arguments: {} },
  })
  assert.equal(body.error.code, -32602)
})

test('内部异常：-32603', async () => {
  const { deps } = makeDeps({
    listComponents: () => {
      throw new Error('炸了')
    },
  })
  const { body } = await call(deps, {
    jsonrpc: '2.0',
    id: 15,
    method: 'tools/call',
    params: { name: 'list_components', arguments: {} },
  })
  assert.equal(body.error.code, -32603)
  assert.ok(body.error.message.includes('炸了'))
})
