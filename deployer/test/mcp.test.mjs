/**
 * 容器端 MCP 端点单测（设计 6.3：Streamable HTTP 最小子集，JSON 响应模式）。
 *
 * 协议实现已下沉 `packages/server/src/mcp.mjs`（与桌面服务进程同一份），协议细节在
 * 服务层测试里已完整覆盖；这里只验证**容器侧的接线与取数**：
 * - deployer/src/mcp.mjs 的 re-export 确实指向共享实现；
 * - tools/list：容器注入了检索依赖 → 六个工具都在（含 search_docs / read_doc）；
 * - 真实 httpd + 真实工作树：search_docs 命中仓库文档、read_doc 读到全文、
 *   相对路径带仓库前缀与绝对路径越界各自有可读说明；
 * - /mcp 的方法限制 405 + Allow、POST 响应头与体。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

import { handleMcp } from '../src/mcp.mjs'
import { createHttpd } from '../src/httpd.mjs'

/** mock 响应：记录状态 / 头 / 体（handleMcp 只依赖 writeHead / end / headersSent 三面） */
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

/** mock deps：默认空平台；两个检索回调记录调用便于断言确实被问到 */
function makeDeps(overrides = {}) {
  const calls = []
  return {
    calls,
    deps: {
      serverVersion: 'test-1.0.0',
      serverName: 'docvi',
      listPlugins: () => [],
      listComponents: () => [],
      componentDocs: () => null,
      pluginDocs: () => null,
      searchDocs: (query, limit) => {
        calls.push({ query, limit })
        return []
      },
      readDoc: path => {
        calls.push({ path })
        return '没有找到文档'
      },
      ...overrides,
    },
  }
}

/** 经 handleMcp 处理一次请求体（string 原样发送，便于造非法 JSON）；返回 mock 响应 */
async function rpc(payload, deps = makeDeps().deps) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload)
  const res = mockRes()
  await handleMcp(Readable.from([Buffer.from(body, 'utf8')]), res, deps)
  return res
}

const req = (method, params, id = 1) => ({
  jsonrpc: '2.0',
  id,
  method,
  ...(params ? { params } : {}),
})

test('initialize：协议版本协商回显 / 回退最新；容器自报 docvi', async () => {
  for (const version of ['2024-11-05', '2025-03-26', '2025-06-18', '2026-07-28']) {
    const res = await rpc(req('initialize', { protocolVersion: version }))
    assert.equal(res.status, 200)
    const out = JSON.parse(res.body)
    assert.equal(out.jsonrpc, '2.0')
    assert.equal(out.id, 1)
    assert.equal(out.result.protocolVersion, version, `客户端支持版本应回显：${version}`)
    assert.deepEqual(out.result.capabilities, { tools: {} })
    assert.deepEqual(out.result.serverInfo, { name: 'docvi', version: 'test-1.0.0' })
  }
  for (const version of ['1999-01-01', undefined]) {
    const res = await rpc(req('initialize', version ? { protocolVersion: version } : {}))
    const out = JSON.parse(res.body)
    assert.equal(out.result.protocolVersion, '2026-07-28', '不支持 / 缺失版本回退最新')
  }
})

test('tools/list：容器注入检索依赖后是六个工具（含文档工具）', async () => {
  const res = await rpc(req('tools/list', {}, 'abc'))
  const out = JSON.parse(res.body)
  assert.equal(out.id, 'abc')
  const { tools } = out.result
  assert.deepEqual(
    tools.map(tool => tool.name),
    [
      'list_plugins',
      'list_components',
      'get_component_docs',
      'get_plugin_docs',
      'search_docs',
      'read_doc',
    ],
  )
  for (const tool of tools) {
    assert.equal(typeof tool.description, 'string')
    assert.ok(tool.description.length > 10, `${tool.name} 描述应说明何时用`)
    assert.equal(tool.inputSchema.type, 'object')
  }
  assert.deepEqual(tools[2].inputSchema.required, ['kind'])
  assert.deepEqual(tools[3].inputSchema.required, ['name'])
  assert.deepEqual(tools[4].inputSchema.required, ['query'])
  assert.deepEqual(tools[5].inputSchema.required, ['path'])
})

test('tools/call list_components：活跃组件清单（本地化 zh → en → 首值；kind 永不翻译）', async () => {
  const { deps } = makeDeps({
    listComponents: () => [
      {
        kind: 'flow-diagram',
        title: { zh: '流程图', en: 'Flow' },
        description: '流程与关系图',
        plugin: 'docs-plugin-base',
      },
      {
        kind: 'audio-waveform',
        title: { en: 'Waveform' },
        description: { en: 'Audio waveform' },
        plugin: 'docs-plugin-audio',
      },
    ],
  })
  const res = await rpc(req('tools/call', { name: 'list_components' }), deps)
  const out = JSON.parse(res.body)
  assert.equal(out.result.isError, false)
  assert.deepEqual(out.result.content[0].type, 'text')
  const text = out.result.content[0].text
  assert.match(text, /flow-diagram/, 'kind 原样呈现')
  assert.match(text, /流程图/, 'title 语言映射取 zh')
  assert.match(text, /Waveform/, '无 zh 时回退 en')
  assert.match(text, /docs-plugin-base/, 'plugin 为全限定身份')
  assert.match(text, /活跃组件 2 个/)
})

test('tools/call list_plugins：预设 / 第三方标签；空平台给引导文案', async () => {
  const { deps } = makeDeps({
    listPlugins: () => [
      {
        name: 'docs-plugin-base',
        displayName: { zh: '通用组件包' },
        version: '1.2.0',
        builtin: true,
      },
      { name: 'third-party', displayName: '第三个', version: '0.1.0', builtin: false },
    ],
  })
  const text = JSON.parse((await rpc(req('tools/call', { name: 'list_plugins' }), deps)).body)
    .result.content[0].text
  assert.match(text, /docs-plugin-base/)
  assert.match(text, /通用组件包/)
  assert.match(text, /v1\.2\.0/)
  assert.match(text, /预设包/)
  assert.match(text, /第三方/)

  const empty = await rpc(req('tools/call', { name: 'list_plugins' }))
  assert.match(JSON.parse(empty.body).result.content[0].text, /没有已启用的插件包/)
})

test('tools/call get_component_docs：已知 kind 给头部 + SKILL.md；未知 kind 是说明不是错误', async () => {
  const { deps } = makeDeps({
    listComponents: () => [
      {
        kind: 'flow-diagram',
        title: '流程图',
        description: '流程与关系图',
        plugin: 'docs-plugin-base',
      },
    ],
    componentDocs: kind =>
      kind === 'flow-diagram' ? '# 用法\n\n<at-flow-diagram data-key="x">' : null,
  })
  const okOut = JSON.parse(
    (
      await rpc(
        req('tools/call', { name: 'get_component_docs', arguments: { kind: 'flow-diagram' } }),
        deps,
      )
    ).body,
  ).result
  assert.equal(okOut.isError, false)
  assert.match(
    okOut.content[0].text,
    /^kind: flow-diagram ｜ title: 流程图 ｜ plugin: docs-plugin-base\n\n/,
  )
  assert.match(okOut.content[0].text, /<at-flow-diagram data-key="x">/)

  const unknownOut = JSON.parse(
    (
      await rpc(
        req('tools/call', { name: 'get_component_docs', arguments: { kind: 'nope' } }),
        deps,
      )
    ).body,
  ).result
  assert.equal(unknownOut.isError, false, '停用 / 不存在 kind 是说明而非错误')
  assert.match(unknownOut.content[0].text, /没有活跃实现/)

  const naked = makeDeps({
    listComponents: () => [{ kind: 'flow-diagram', title: 't', description: 'd', plugin: 'p' }],
  })
  assert.match(
    JSON.parse(
      (
        await rpc(
          req('tools/call', { name: 'get_component_docs', arguments: { kind: 'flow-diagram' } }),
          naked.deps,
        )
      ).body,
    ).result.content[0].text,
    /SKILL\.md 不存在/,
  )
})

test('tools/call get_plugin_docs：已启用插件返回全文；未启用返回说明', async () => {
  const { deps } = makeDeps({
    listPlugins: () => [
      { name: 'docs-plugin-base', displayName: 'base', version: '1.0.0', builtin: true },
    ],
    pluginDocs: () => '# base 插件文档',
  })
  const okOut = JSON.parse(
    (
      await rpc(
        req('tools/call', { name: 'get_plugin_docs', arguments: { name: 'docs-plugin-base' } }),
        deps,
      )
    ).body,
  ).result
  assert.equal(okOut.isError, false)
  assert.equal(okOut.content[0].text, '# base 插件文档')

  const missingOut = JSON.parse(
    (await rpc(req('tools/call', { name: 'get_plugin_docs', arguments: { name: 'other' } }), deps))
      .body,
  ).result
  assert.equal(missingOut.isError, false)
  assert.match(missingOut.content[0].text, /不可用/)
})

test('JSON-RPC 错误码：解析失败 -32700 / 批量 -32600 / 未知方法 -32601 / 缺参与未知工具 -32602', async () => {
  const bad = await rpc('{ not json')
  assert.equal(bad.status, 400, '解析失败回 400（MCP 规范）')
  assert.equal(JSON.parse(bad.body).error.code, -32700)

  const batch = await rpc([req('tools/list')])
  assert.equal(batch.status, 400)
  assert.equal(JSON.parse(batch.body).error.code, -32600)

  const unknown = await rpc(req('resources/list'))
  assert.equal(unknown.status, 200)
  assert.equal(JSON.parse(unknown.body).error.code, -32601)

  const badTool = await rpc(req('tools/call', { name: 'hack_the_planet', arguments: {} }))
  assert.equal(JSON.parse(badTool.body).error.code, -32602, '未知工具 -32602')

  const noKind = await rpc(req('tools/call', { name: 'get_component_docs', arguments: {} }))
  assert.equal(JSON.parse(noKind.body).error.code, -32602, '缺必填参数 -32602')

  const noName = await rpc(req('tools/call', {}))
  assert.equal(JSON.parse(noName.body).error.code, -32602, '缺工具名 -32602')
})

test('deps 回调抛错 → -32603（内部错不与参数错混码）', async () => {
  const { deps } = makeDeps({
    listComponents: () => {
      throw new Error('磁盘读失败')
    },
  })
  const res = await rpc(req('tools/call', { name: 'list_components' }), deps)
  assert.equal(res.status, 200)
  assert.equal(JSON.parse(res.body).error.code, -32603)
  assert.match(JSON.parse(res.body).error.message, /磁盘读失败/)
})

test('通知（无 id）：202 空体、不产生 JSON-RPC 响应', async () => {
  const res = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })
  assert.equal(res.status, 202)
  assert.equal(res.body, '')

  const other = await rpc({ jsonrpc: '2.0', method: 'notifications/whatever' })
  assert.equal(other.status, 202)
})

/** 造一个临时数据卷：一个仓库的分支工作树里放两篇 Markdown */
function makeVolume() {
  const dataDir = mkdtempSync(join(tmpdir(), 'docs-mcp-'))
  const worktree = join(dataDir, 'worktrees', 'handbook', 'main')
  mkdirSync(join(worktree, 'guides'), { recursive: true })
  writeFileSync(
    join(worktree, 'guides', 'deploy.md'),
    '# 部署指南\n\n容器部署用一条 docker run 命令完成，注意数据卷挂载。\n',
    'utf8',
  )
  writeFileSync(join(worktree, 'README.md'), '# 手册首页\n\n综述与目录。\n', 'utf8')
  return { dataDir, worktree }
}

/** 起一个真实 httpd（repo 配置 / git 分支列表都用桩，工作树走真实磁盘） */
async function withHttpd(run) {
  const { dataDir, worktree } = makeVolume()
  const httpd = createHttpd({
    dataDir,
    platformDir: 'unused',
    version: 'test-1.0.0',
    token: '',
    gitOps: {
      hasBare: () => true,
      remoteBranches: async () => ['main'],
    },
    builder: {},
    plugins: {
      catalog: () => ({ plugins: [] }),
      activeKinds: () => ({ active: [], conflicts: [] }),
      findPluginRoot: () => null,
    },
    shares: {},
    loadConfigData: () => ({
      repos: [{ slug: 'handbook', name: '工程手册', branches: ['main'] }],
      global: {},
    }),
    saveConfigData: () => {},
    audit: () => {},
  })
  const server = createServer(httpd)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const post = async message => {
    const res = await fetch(`${origin}/mcp`, {
      method: 'POST',
      body: JSON.stringify(message),
    })
    return res.json()
  }
  try {
    await run({ origin, post, worktree })
  } finally {
    await new Promise(resolve => server.close(resolve))
    rmSync(dataDir, { recursive: true, force: true })
  }
}

test('httpd 接线：GET /mcp → 405 + Allow: POST；POST → JSON 响应模式', async () => {
  await withHttpd(async ({ origin, post }) => {
    const get = await fetch(`${origin}/mcp`)
    assert.equal(get.status, 405)
    assert.equal(get.headers.get('allow'), 'POST')

    const out = await post({
      jsonrpc: '2.0',
      id: 7,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18' },
    })
    assert.equal(out.id, 7)
    assert.equal(out.result.protocolVersion, '2025-06-18')
    assert.deepEqual(out.result.serverInfo, { name: 'docvi', version: 'test-1.0.0' })

    const call = await post({
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: { name: 'list_components' },
    })
    assert.equal(call.result.isError, false)
    assert.match(call.result.content[0].text, /没有活跃组件/)
  })
})

test('容器 search_docs：命中工作树文档，路径带仓库前缀、范围名带分支', async () => {
  await withHttpd(async ({ post }) => {
    const out = await post({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'search_docs', arguments: { query: 'docker run' } },
    })
    assert.equal(out.result.isError, false)
    const text = out.result.content[0].text
    assert.match(text, /工程手册@main/, '范围名 = 仓库名@分支')
    assert.match(text, /handbook\/guides\/deploy\.md/, '路径带仓库 slug 前缀')
    assert.match(text, /部署指南/, '标题取自首个 H1')

    const none = await post({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'search_docs', arguments: { query: '不存在的词' } },
    })
    assert.equal(none.result.isError, false, '无命中是正常答案')
    assert.match(none.result.content[0].text, /没有匹配/)
  })
})

test('容器 read_doc：前缀路径与绝对路径可读；越界与非法段给可读说明且 isError=false', async () => {
  await withHttpd(async ({ post, worktree }) => {
    const prefixed = await post({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'read_doc', arguments: { path: 'handbook/guides/deploy.md' } },
    })
    assert.match(prefixed.result.content[0].text, /workspace: 工程手册@main/)
    assert.match(prefixed.result.content[0].text, /path: handbook\/guides\/deploy\.md/)
    assert.match(prefixed.result.content[0].text, /一条 docker run 命令/)

    // 不带前缀的裸相对路径也能命中（AI 手抄路径时的容错）
    const bare = await post({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'read_doc', arguments: { path: 'guides/deploy.md' } },
    })
    assert.match(bare.result.content[0].text, /一条 docker run 命令/)

    const absolute = await post({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'read_doc', arguments: { path: join(worktree, 'README.md') } },
    })
    assert.match(absolute.result.content[0].text, /手册首页/)
    assert.match(absolute.result.content[0].text, /path: handbook\/README\.md/)

    const escape = await post({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'read_doc', arguments: { path: '../outside.md' } },
    })
    assert.equal(escape.result.isError, false)
    assert.match(escape.result.content[0].text, /非法段/)

    const outside = await post({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'read_doc', arguments: { path: join(tmpdir(), 'not-in-scope.md') } },
    })
    assert.match(outside.result.content[0].text, /不在任何可读范围/)
  })
})

test('容器范围解析：worktree 缺失的仓库不参与检索（不报错）', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'docs-mcp-empty-'))
  const httpd = createHttpd({
    dataDir,
    platformDir: 'unused',
    version: 'test-1.0.0',
    token: '',
    gitOps: { hasBare: () => true, remoteBranches: async () => ['main'] },
    builder: {},
    plugins: {
      catalog: () => ({ plugins: [] }),
      activeKinds: () => ({ active: [], conflicts: [] }),
      findPluginRoot: () => null,
    },
    shares: {},
    loadConfigData: () => ({
      repos: [{ slug: 'handbook', name: '工程手册', branches: ['main'] }],
      global: {},
    }),
    saveConfigData: () => {},
    audit: () => {},
  })
  const server = createServer(httpd)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  try {
    const res = await fetch(`${origin}/mcp`, {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'search_docs', arguments: { query: '任意词' } },
      }),
    })
    const out = await res.json()
    assert.equal(out.result.isError, false)
    assert.match(out.result.content[0].text, /没有匹配/)

    const read = await fetch(`${origin}/mcp`, {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'read_doc', arguments: { path: 'README.md' } },
      }),
    })
    const readOut = await read.json()
    assert.match(readOut.result.content[0].text, /没有可读取的文档范围/)
  } finally {
    await new Promise(resolve => server.close(resolve))
    rmSync(dataDir, { recursive: true, force: true })
  }
})
