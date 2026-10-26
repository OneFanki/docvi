/**
 * 桌面服务进程的 MCP 依赖适配测试。
 *
 * MCP 协议与语料检索只有一份实现（`packages/server/src/mcp.mjs` / `corpus.mjs`），
 * 桌面侧新增的只有「ServicePlugin 形状 → MCP 归一化契约」的适配层
 * （`apps/desktop/src/service/plugin-deps.ts`）。因此这里测的是适配层 + 共享分发
 * 的组合行为：组件去重口径、插件文档取数、检索参数透传与协议错误码。
 *
 * 不启动 HTTP 服务、不 spawn 进程；工厂 / 归一化 / 分发都是纯逻辑。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { dispatch, toolNames } from '../../packages/server/src/mcp.mjs'
import { createServiceMcpDeps } from '../../apps/desktop/src/service/plugin-deps.ts'

/** 两个插件、一套组件、一篇文档：覆盖同名 kind 冲突与文档取数两条路径 */
const PLUGINS = [
  {
    name: 'base',
    displayName: { zh: '通用组件包' },
    version: '1.0.0',
    trust: 'presentation',
    dir: '/plugins/base',
    contributes: {
      components: [
        {
          kind: 'flow-diagram',
          title: { zh: '流程图' },
          description: { zh: '有序流程：节点 + 连边' },
        },
        {
          kind: 'timeline',
          title: { zh: '时间轴' },
          description: { zh: '竖向时间轴' },
        },
      ],
    },
  },
  {
    name: 'extra',
    displayName: { zh: '扩展包' },
    version: '0.2.0',
    trust: 'presentation',
    dir: '/plugins/extra',
    contributes: {
      components: [
        // 与 base 同名：后到者不出现（与宿主注册表「先到先得」同口径）
        {
          kind: 'flow-diagram',
          title: { zh: '冲突实现' },
          description: { zh: '不应出现' },
        },
        {
          kind: 'merged-table',
          title: { zh: '合并表格' },
          description: { zh: '带合并单元格的表格' },
        },
      ],
    },
  },
]

/** 假语料：记录检索参数；`空` 返回无命中 */
function fakeCorpus() {
  const calls = []
  return {
    calls,
    search(query, limit) {
      calls.push({ kind: 'search', query, limit })
      return query === '空'
        ? []
        : [{ workspace: '内容', path: 'a.md', title: 'A', snippet: '片段' }].slice(0, limit)
    },
    readDoc(path) {
      calls.push({ kind: 'readDoc', path })
      return path === 'missing.md'
        ? '没有找到文档：missing.md'
        : { workspace: '内容', path, title: 'A', text: '# A\n\n正文' }
    },
  }
}

/** 最小适配：默认读假文档，可整体覆盖 */
function deps(overrides = {}) {
  return createServiceMcpDeps({
    serverVersion: '9.9.9',
    plugins: () => PLUGINS,
    readPluginFile: (dir, rel) => (rel === 'docs/SKILL.md' ? `# ${dir} 的文档` : null),
    corpus: fakeCorpus(),
    ...overrides,
  })
}

function call(message, d = deps()) {
  return dispatch(message, d)
}

function callText(name, args, d = deps()) {
  const outcome = call(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    d,
  )
  assert.equal(outcome.kind, 'result', `${name} 应正常返回`)
  return outcome.result.content[0].text
}

test('tools/list 暴露 6 个工具（含 search_docs / read_doc）', () => {
  const outcome = call({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  assert.equal(outcome.kind, 'result')
  assert.deepEqual(
    outcome.result.tools.map(tool => tool.name),
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
})

test('initialize 回显支持的协议版本，未知版本回最新；serverInfo 为 docvi', () => {
  const known = call({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-03-26' },
  })
  assert.equal(known.result.protocolVersion, '2025-03-26')
  assert.equal(known.result.serverInfo.name, 'docvi')
  assert.equal(known.result.serverInfo.version, '9.9.9')

  const unknown = call({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '1999-01-01' },
  })
  assert.equal(unknown.result.protocolVersion, '2026-07-28')
  assert.match(unknown.result.instructions, /search_docs/, '具备检索能力时 instructions 教用法')
})

test('无 id 的消息视为通知（不产生响应体）', () => {
  assert.equal(call({ jsonrpc: '2.0', method: 'notifications/initialized' }).kind, 'notification')
})

test('方法形态不合法回 -32600（出现在通知之后仍然校验）', () => {
  const outcome = call({ jsonrpc: '1.0', id: 1, method: 'tools/list' })
  assert.equal(outcome.kind, 'error')
  assert.equal(outcome.code, -32600)
})

test('未知方法回 -32601', () => {
  const outcome = call({ jsonrpc: '2.0', id: 1, method: 'resources/list' })
  assert.equal(outcome.code, -32601)
})

test('list_components 去重：同名 kind 取先声明的插件', () => {
  const text = callText('list_components', {})
  assert.ok(text.includes('flow-diagram'))
  assert.ok(!text.includes('冲突实现'), '后声明的同名实现不应出现')
  assert.ok(text.includes('merged-table'))
  assert.equal(text.match(/flow-diagram/g)?.length, 1)
})

test('list_plugins 带信任等级（桌面口径），不暴露包目录', () => {
  const text = callText('list_plugins', {})
  assert.ok(text.includes('通用组件包'))
  assert.ok(text.includes('presentation'))
  assert.ok(!text.includes('/plugins/base'), '包目录是宿主内部信息，不进 MCP 输出')
})

test('get_component_docs 经适配层按插件包读 SKILL.md；未知 kind 给可读说明', () => {
  const found = callText('get_component_docs', { kind: 'merged-table' })
  assert.ok(found.includes('plugin: extra'))
  assert.ok(found.includes('/plugins/extra 的文档'))

  const missing = call({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'get_component_docs', arguments: { kind: 'nope' } },
  })
  assert.ok(missing.result.content[0].text.includes('没有活跃实现'))
  assert.equal(missing.result.isError, false)
})

test('search_docs 透传 query 与 limit；空结果不是错误', () => {
  const corpus = fakeCorpus()
  const text = callText('search_docs', { query: '合并', limit: 3 }, deps({ corpus }))
  assert.deepEqual(corpus.calls[0], { kind: 'search', query: '合并', limit: 3 })
  assert.ok(text.includes('a.md'))
  assert.ok(text.includes('匹配「合并」的文档 1 篇'))

  const empty = callText('search_docs', { query: '空' }, deps({ corpus: fakeCorpus() }))
  assert.ok(empty.includes('没有匹配'))
})

test('search_docs limit 上限 30，非法值回 -32602', () => {
  const corpus = fakeCorpus()
  callText('search_docs', { query: 'a', limit: 999 }, deps({ corpus }))
  assert.equal(corpus.calls[0].limit, 30)

  const invalid = call({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'search_docs', arguments: { query: 'a', limit: 0 } },
  })
  assert.equal(invalid.code, -32602)
})

test('read_doc 成功返回头部与全文；失败文本原样透出', () => {
  const okText = callText('read_doc', { path: 'guides/a.md' })
  assert.ok(okText.includes('workspace: 内容'))
  assert.ok(okText.includes('path: guides/a.md'))
  assert.ok(okText.includes('# A'))

  const missingText = callText('read_doc', { path: 'missing.md' })
  assert.equal(missingText, '没有找到文档：missing.md')
})

test('缺必填参数 / 未知工具 / 非对象 arguments 都回 -32602', () => {
  const missingArg = call({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'read_doc', arguments: {} },
  })
  assert.equal(missingArg.code, -32602)

  const unknown = call({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'nope', arguments: {} },
  })
  assert.equal(unknown.code, -32602)

  const badArgs = call({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'read_doc', arguments: ['a'] },
  })
  assert.equal(badArgs.code, -32602)
})

test('工具内部抛异常回 -32603（与参数错误分开报码）', () => {
  const outcome = call(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'list_plugins', arguments: {} },
    },
    deps({
      plugins: () => {
        throw new Error('boom')
      },
    }),
  )
  assert.equal(outcome.code, -32603)
  assert.ok(outcome.message.includes('boom'))
})
