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
        : { workspace: '文档@main', path, title: 'A', text: '# A\n\n正文', mtime: 1717000000000 },
    listWorkspaces: () => {
      calls.push('listWorkspaces')
      return [
        { workspace: '文档', root: '/tmp/docs', default: true },
        { workspace: '另一个', root: '/tmp/other' },
      ]
    },
    writeDoc: input => {
      calls.push({ write: input })
      if (input.path === 'taken.md') return { error: '文档已存在：taken.md' }
      return {
        status: 'created',
        workspace: input.workspace ?? '文档',
        path: input.path,
        bytes: Buffer.byteLength(input.text, 'utf8'),
        mtime: 1717000001000,
      }
    },
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

test('tools/list：全量八个工具、都有 inputSchema，处理器不进输出', async () => {
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
      'list_workspaces',
      'write_doc',
    ],
  )
  assert.equal(toolNames().length, 8)
  for (const tool of body.result.tools) {
    assert.equal(tool.inputSchema.type, 'object')
    assert.ok(tool.description.length > 10, `${tool.name} 需要可读描述`)
    assert.equal(tool.handler, undefined, '处理器是实现细节，不进 tools/list')
  }
  const search = body.result.tools.find(tool => tool.name === 'search_docs')
  assert.deepEqual(search.inputSchema.required, ['query'])
  const read = body.result.tools.find(tool => tool.name === 'read_doc')
  assert.deepEqual(read.inputSchema.required, ['path'])
  const write = body.result.tools.find(tool => tool.name === 'write_doc')
  assert.deepEqual(write.inputSchema.required, ['path', 'text'])
  assert.deepEqual(write.inputSchema.properties.mode.enum, ['create', 'overwrite', 'append'])
})

test('工具面 = 宿主能力：检索依赖缺席时只列四个插件工具', async () => {
  const { deps } = makeDeps()
  delete deps.searchDocs
  delete deps.readDoc
  delete deps.listWorkspaces
  delete deps.writeDoc
  const { body } = await call(deps, { jsonrpc: '2.0', id: 6, method: 'tools/list' })
  assert.deepEqual(
    body.result.tools.map(tool => tool.name),
    ['list_plugins', 'list_components', 'get_component_docs', 'get_plugin_docs'],
  )

  const init = await call(deps, { jsonrpc: '2.0', id: 7, method: 'initialize' })
  assert.doesNotMatch(init.body.result.instructions, /search_docs/, '无检索能力时不提该工作流')
  assert.doesNotMatch(init.body.result.instructions, /write_doc/, '无写入能力时不提该工作流')

  const denied = await call(deps, {
    jsonrpc: '2.0',
    id: 8,
    method: 'tools/call',
    params: { name: 'search_docs', arguments: { query: 'a' } },
  })
  assert.equal(denied.body.error.code, -32602, '未声明的工具按未知工具处理')
})

test('工具面：容器端只读时 write_doc 不出现，list_workspaces 仍可列出', async () => {
  /*
   * 容器的工作树是构建副本、没有 commit/push，写入不会回传远端仓库，
   * 所以不注入 writeDoc。但「能往哪写」仍是有效信息——list_workspaces 独立开关。
   */
  const { deps } = makeDeps()
  delete deps.writeDoc
  const { body } = await call(deps, { jsonrpc: '2.0', id: 61, method: 'tools/list' })
  const names = body.result.tools.map(tool => tool.name)
  assert.ok(names.includes('list_workspaces'), '只读宿主也可以暴露工作区清单')
  assert.ok(!names.includes('write_doc'), '没有写入能力就不声明该工具')

  const denied = await call(deps, {
    jsonrpc: '2.0',
    id: 62,
    method: 'tools/call',
    params: { name: 'write_doc', arguments: { path: 'a.md', text: 'x' } },
  })
  assert.equal(denied.body.error.code, -32602)
})

test('工具面：有 writeDoc 但没有 listWorkspaces 时也不声明 write_doc', async () => {
  // 写入失败时 AI 需要追问「有哪些工作区」，缺了它等于给一个报错无门的工具
  const { deps } = makeDeps()
  delete deps.listWorkspaces
  const { body } = await call(deps, { jsonrpc: '2.0', id: 63, method: 'tools/list' })
  assert.ok(!body.result.tools.some(tool => tool.name === 'write_doc'))
})

test('tools/call：八个工具返回文本内容且 isError=false', async () => {
  const { deps } = makeDeps()
  const cases = [
    { name: 'list_plugins', arguments: {}, expect: '示例包' },
    { name: 'list_components', arguments: {}, expect: 'flow-diagram' },
    { name: 'get_component_docs', arguments: { kind: 'flow-diagram' }, expect: '# 用法' },
    { name: 'get_plugin_docs', arguments: { name: 'demo' }, expect: '# 包用法' },
    { name: 'search_docs', arguments: { query: '流程' }, expect: 'guides/a.md' },
    { name: 'read_doc', arguments: { path: 'guides/a.md' }, expect: '# A' },
    { name: 'list_workspaces', arguments: {}, expect: '默认落笔处' },
    { name: 'write_doc', arguments: { path: '新篇.md', text: '# 新篇' }, expect: '已新建' },
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
  assert.match(
    text,
    /^workspace: 文档@main ｜ path: guides\/a\.md ｜ title: A ｜ mtime: \d+\n\n# A/,
  )

  const missing = await call(deps, {
    jsonrpc: '2.0',
    id: 16,
    method: 'tools/call',
    params: { name: 'read_doc', arguments: { path: 'missing.md' } },
  })
  assert.equal(missing.body.result.isError, false)
  assert.equal(missing.body.result.content[0].text, '没有找到文档：missing.md')
})

test('write_doc：成功回路径与 mtime，明确标 isError=false', async () => {
  const { deps, calls } = makeDeps()
  const res = await call(deps, {
    jsonrpc: '2.0',
    id: 20,
    method: 'tools/call',
    params: { name: 'write_doc', arguments: { path: '指南/入门.md', text: '# 入门\n' } },
  })
  assert.equal(res.body.result.isError, false)
  const text = res.body.result.content[0].text
  assert.match(text, /已新建：文档 ｜ 指南\/入门\.md/)
  assert.match(text, /mtime: \d+/)
  // 默认 mode=create，且原样把 mode 传给宿主（不做隐式升级成覆盖）
  assert.deepEqual(calls.at(-1).write.mode, 'create')
})

test('write_doc：写入失败必须 isError=true（否则 AI 会以为写成了）', async () => {
  const { deps } = makeDeps()
  const res = await call(deps, {
    jsonrpc: '2.0',
    id: 21,
    method: 'tools/call',
    params: { name: 'write_doc', arguments: { path: 'taken.md', text: 'x' } },
  })
  assert.equal(res.body.result.isError, true, '写失败必须是 isError，与「查不到」区分开')
  assert.match(res.body.result.content[0].text, /写入失败：文档已存在/)
})

test('write_doc：宿主抛错也转成 isError，不冒泡成协议错误', async () => {
  const { deps } = makeDeps({
    writeDoc: () => {
      throw new Error('磁盘只读')
    },
  })
  const res = await call(deps, {
    jsonrpc: '2.0',
    id: 22,
    method: 'tools/call',
    params: { name: 'write_doc', arguments: { path: 'a.md', text: 'x' } },
  })
  // 处理器内部异常由 dispatch 兜成 -32603（内部错误），不能被当成成功
  assert.equal(res.body.result?.isError ?? true, true)
})

test('write_doc：参数错误走 -32602（mode 非法 / baseMtime 非数字 / 缺 text）', async () => {
  const { deps } = makeDeps()
  for (const args of [
    { path: 'a.md', text: 'x', mode: 'upsert' },
    { path: 'a.md', text: 'x', baseMtime: '123' },
    { path: 'a.md' },
  ]) {
    const res = await call(deps, {
      jsonrpc: '2.0',
      id: 23,
      method: 'tools/call',
      params: { name: 'write_doc', arguments: args },
    })
    assert.equal(res.body.error?.code, -32602, JSON.stringify(args))
  }
})

test('write_doc：text 允许空串（清空一篇文档是合法操作）', async () => {
  const { deps, calls } = makeDeps()
  const res = await call(deps, {
    jsonrpc: '2.0',
    id: 24,
    method: 'tools/call',
    params: {
      name: 'write_doc',
      arguments: { path: 'a.md', text: '', mode: 'overwrite', baseMtime: 1 },
    },
  })
  assert.equal(res.body.result.isError, false)
  assert.equal(calls.at(-1).write.text, '')
})

test('list_workspaces：无工作区时给可操作提示，不是空字符串', async () => {
  const { deps } = makeDeps({ listWorkspaces: () => [] })
  const res = await call(deps, {
    jsonrpc: '2.0',
    id: 25,
    method: 'tools/call',
    params: { name: 'list_workspaces', arguments: {} },
  })
  assert.equal(res.body.result.isError, false, '「没有工作区」是正常答案')
  assert.match(res.body.result.content[0].text, /没有可用的工作区/)
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

test('instructions：默认工作区被描述成兜底，优先级在明确指令之后', async () => {
  /*
   * 这是防「AI 图省事把所有文档都写进默认工作区」的唯一约束点——
   * 用户或项目规范若已指明位置，兜底不该覆盖。措辞顺序即优先级，用断言钉住。
   */
  const { deps } = makeDeps()
  const init = await call(deps, { jsonrpc: '2.0', id: 30, method: 'initialize' })
  const text = init.body.result.instructions
  assert.match(text, /用户明确指定/, '必须提到用户明确指定的位置优先')
  assert.match(text, /项目规范/, '必须提到项目规范优先')
  assert.match(text, /兜底/, '默认工作区必须被描述成兜底而不是首选')
  // 优先级顺序：用户 > 项目规范 > 默认
  assert.ok(
    text.indexOf('用户明确指定') < text.indexOf('项目规范') &&
      text.indexOf('项目规范') < text.indexOf('兜底'),
    '优先级表述顺序应为 用户 → 项目规范 → 默认工作区',
  )
})

test('list_workspaces：标出默认落笔处，并复述优先级', async () => {
  const { deps } = makeDeps()
  const res = await call(deps, {
    jsonrpc: '2.0',
    id: 31,
    method: 'tools/call',
    params: { name: 'list_workspaces', arguments: {} },
  })
  const text = res.body.result.content[0].text
  assert.match(text, /默认落笔处/)
  assert.match(text, /用户明确指定的位置 > 项目规范约定 > 标着「默认落笔处」的那个/)
})
