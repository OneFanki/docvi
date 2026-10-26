/**
 * MCP 端点（MCP Streamable HTTP 的 JSON 应答子集，单一实现）。
 *
 * 两个宿主共用同一份协议逻辑：容器部署器（deployer/src/httpd.mjs 直挂 POST /mcp）、
 * docvi 桌面服务进程（apps/desktop/src/service/http.ts，自带令牌与分享路由）。
 * 设计口径见 docs/design/平台插件化与 AI 分发.md 6.3。
 *
 * 传输分两层，宿主按需取用：
 *   - `dispatch(message, deps)`：纯分发（已解析的消息进、结构化的结果出），
 *     供自带 HTTP 面的宿主复用；
 *   - `handleMcp(req, res, deps)`：完整端点（读体 → 分发 → 状态码），容器直接挂载。
 *
 * 工具面 = 插件 / 组件四件套 + 文档读写两件套；`searchDocs` / `readDoc` 依赖缺省时
 * 后两个不出现在 tools/list 里——工具面即宿主能力，不能声明自己兑现不了的查询。
 *
 * 工具数据全部由 deps 注入（宿主组装成活查询回调），本模块不触磁盘、不缓存——
 * 插件启停 / 组件启停 / 升级即查询即变。工具结果一律是 `isError: false` 的说明文本：
 * 「查不到」是正常答案而非协议错误，只有「请求本身不合法」（缺参数、未知工具）才回 -32602。
 *
 * deps 契约：
 *   serverVersion: string
 *   serverName?: string        serverInfo.name（缺省 docvi；宿主可覆盖）
 *   listPlugins(): Array<{name, displayName, version, builtin?, trust?}>  已启用插件
 *   listComponents(): Array<{kind, title, description, plugin}>  活跃组件（每 kind 至多一条）
 *   componentDocs(kind): string | null          所属插件 docs/SKILL.md 全文
 *   pluginDocs(name): string | null             同上（按插件名）
 *   searchDocs?(query, limit): Array<{workspace, path, title, snippet}>
 *   readDoc?(path): {workspace, path, title, text} | string   字符串即可读的失败说明
 */

/** 支持的协议版本（initialize 协商：客户端值在列则回显，否则回最新——MCP 规范行为） */
const PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18', '2026-07-28']
const LATEST_PROTOCOL_VERSION = '2026-07-28'

/** 请求体上限（MCP 工具调用都是小对象，无需 httpd 的 2MB 口径） */
const BODY_LIMIT = 256 * 1024

/** 本地化字段解析（协议 v1.1 双形态：string 或语言映射；zh → en → 首值）。kind 永不翻译 */
function lz(value) {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value
    const first = typeof record.zh === 'string' ? record.zh : record.en
    return typeof first === 'string' ? first : ''
  }
  return ''
}

/** 参数错误（-32602）：缺参 / 未知工具——与内部错（-32603）分开报码 */
export class RpcParamError extends Error {}

/** 读必填字符串参数（缺 / 空 → -32602） */
function argString(args, key) {
  const value = args[key]
  if (typeof value !== 'string' || !value.trim()) {
    throw new RpcParamError(`参数错误：缺少必填字符串参数 ${key}`)
  }
  return value.trim()
}

/** limit：缺省值 + 上限钳制；非法值报 -32602（静默纠正会让 AI 误判返回完整性） */
function argLimit(args, fallback, max) {
  const value = args.limit
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    throw new RpcParamError('参数错误：limit 必须是正整数')
  }
  return Math.min(Math.floor(value), max)
}

/** 插件来源标签：桌面给 trust 信任等级，容器只有「预设 / 第三方」两档 */
function originOf(plugin) {
  if (typeof plugin.trust === 'string' && plugin.trust) return plugin.trust
  return plugin.builtin ? '预设包' : '第三方'
}

/** list_plugins：已启用插件清单（包名与版本是全限定身份，原样呈现） */
function toolListPlugins(_args, deps) {
  const plugins = deps.listPlugins() ?? []
  if (!plugins.length) return '当前没有已启用的插件包——管理面「插件」面板可安装 / 启用。'
  const lines = plugins.map(
    plugin =>
      `- ${plugin.name} ｜ ${lz(plugin.displayName) || plugin.name} ｜ v${plugin.version} ｜ ${originOf(plugin)}`,
  )
  return `已启用插件包 ${plugins.length} 个：\n\n${lines.join('\n')}`
}

/** list_components：活跃组件清单（本地化字段按 zh → en → 首值解析；kind 永不翻译） */
function toolListComponents(_args, deps) {
  const components = deps.listComponents() ?? []
  if (!components.length) return '当前没有活跃组件（未安装插件包，或组件全部已停用）。'
  const lines = components.map(
    item =>
      `- ${item.kind} ｜ ${lz(item.title) || item.kind} ｜ ${lz(item.description)} ｜ 插件：${item.plugin}`,
  )
  return `活跃组件 ${components.length} 个（每个 kind 至多一条活跃实现；用法经 get_component_docs(kind) 获取）：\n\n${lines.join('\n')}`
}

/** get_component_docs：头部一行（kind/title/plugin）+ 所属插件 docs/SKILL.md 全文 */
function toolGetComponentDocs(args, deps) {
  const kind = argString(args, 'kind')
  const active = (deps.listComponents() ?? []).find(item => item.kind === kind)
  if (!active) {
    return `该 kind 当前没有活跃实现（未安装 / 已停用 / 同名冲突）：${kind}——先调用 list_components 查看可用组件。`
  }
  const docs = deps.componentDocs(kind)
  if (typeof docs !== 'string' || !docs) {
    return `组件 ${kind}（插件 ${active.plugin}）的用法文档缺失：包内 docs/SKILL.md 不存在或不可读。`
  }
  return `kind: ${kind} ｜ title: ${lz(active.title) || kind} ｜ plugin: ${active.plugin}\n\n${docs}`
}

/** get_plugin_docs：插件 docs/SKILL.md 全文（仅已启用插件——与活查询口径一致） */
function toolGetPluginDocs(args, deps) {
  const name = argString(args, 'name')
  const known = (deps.listPlugins() ?? []).find(item => item.name === name)
  if (!known) {
    return `插件 ${name} 不可用（未安装 / 已停用——MCP 仅列已启用插件）。先调用 list_plugins 查看可用插件。`
  }
  const docs = deps.pluginDocs(name)
  if (typeof docs !== 'string' || !docs) {
    return `插件 ${name} 的用法文档缺失：包内 docs/SKILL.md 不存在或不可读。`
  }
  return docs
}

/** search_docs：宿主可检索范围（桌面工作区 / 容器发布分支）内的全文检索 */
function toolSearchDocs(args, deps) {
  const query = argString(args, 'query')
  const limit = argLimit(args, 10, 30)
  const hits = deps.searchDocs?.(query, limit) ?? []
  if (!hits.length) return `没有匹配「${query}」的文档。`
  const lines = hits.map(
    (hit, index) =>
      `${index + 1}. [${hit.workspace}] ${hit.path} ｜ ${hit.title}\n   ${hit.snippet}`,
  )
  return `匹配「${query}」的文档 ${hits.length} 篇：\n\n${lines.join('\n')}`
}

/** read_doc：全文读取；失败文案由宿主给出（越界 / 不存在 / 超限各有可读说明） */
function toolReadDoc(args, deps) {
  const path = argString(args, 'path')
  const result = deps.readDoc?.(path)
  if (typeof result === 'string' || !result) return result || `没有找到文档：${path}`
  return `workspace: ${result.workspace} ｜ path: ${result.path} ｜ title: ${result.title}\n\n${result.text}`
}

/** 工具面（描述说明「何时用」——AI 的选择依据；必填参数经 inputSchema 声明） */
const TOOLS = [
  {
    name: 'list_plugins',
    description:
      '列出当前已启用的插件包（name / displayName / version / 来源或信任等级）。何时用：了解组件来源，或获取 get_plugin_docs 需要的包名。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: toolListPlugins,
  },
  {
    name: 'list_components',
    description:
      '列出全部活跃组件（kind / title / description / 所属插件；停用插件与同名冲突落选者不出现）。何时用：写文档前先看有哪些组件、各做什么。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: toolListComponents,
  },
  {
    name: 'get_component_docs',
    description:
      '获取某个组件的用法文档（所属插件 docs/SKILL.md 全文 + kind/title/plugin 头部）。何时用：选定 kind 后、写 <at-kind> 标签前获取数据格式。',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', description: '组件 kind（list_components 返回的 kind）' },
      },
      required: ['kind'],
      additionalProperties: false,
    },
    handler: toolGetComponentDocs,
  },
  {
    name: 'get_plugin_docs',
    description: '获取插件包 docs/SKILL.md 全文（含该包全部组件的写法与示例）。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '插件包名（list_plugins 返回的 name）' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    handler: toolGetPluginDocs,
  },
  {
    name: 'search_docs',
    description:
      '在宿主可检索范围（桌面端 = 已打开工作区；容器端 = 已发布的仓库默认分支）内全文检索 Markdown 文档，返回路径、标题与命中片段。何时用：动笔前了解已有内容、避免重复，或定位相关章节。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索词（不区分大小写，支持多个词同时命中）' },
        limit: { type: 'number', description: '最多返回篇数，默认 10，上限 30' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    handler: toolSearchDocs,
  },
  {
    name: 'read_doc',
    description:
      '读取一篇 Markdown 文档全文。path 用 search_docs 返回的 path（桌面宿主也接受工作区内的绝对路径）。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'search_docs 返回的文档路径' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    handler: toolReadDoc,
  },
]

/** 宿主实际提供的工具面：检索依赖缺席时后两个不出现在 tools/list */
export function availableTools(deps) {
  return TOOLS.filter(tool => {
    if (tool.name === 'search_docs') return typeof deps.searchDocs === 'function'
    if (tool.name === 'read_doc') return typeof deps.readDoc === 'function'
    return true
  })
}

/** 全量工具名（UI 展示与测试用；不受宿主能力影响） */
export function toolNames() {
  return TOOLS.map(tool => tool.name)
}

/** 对外暴露的工具描述：处理器是实现细节，不进 tools/list */
function publicSpec(tool) {
  return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema }
}

/** initialize 的 instructions：连接即获知工作流（先看组件、再看写法、再查存量文档） */
function instructionsOf(deps) {
  const canRead =
    typeof deps.searchDocs === 'function' && typeof deps.readDoc === 'function'
      ? '写文档前用 search_docs 检索既有内容，用 read_doc 读全文（path 用检索结果里的路径）。'
      : ''
  return (
    '先 list_components 查看可用组件（kind 即文档标签名 at-<kind>），再 get_component_docs(kind) 获取写法。' +
    canRead +
    '文档写法：frontmatter 的 components 段放数据，正文用 <at-kind data-key="键"> 引用。'
  )
}

/** initialize 结果：协议版本协商 + 工具能力声明 + 平台信息与工作流说明 */
function initializeResult(params, deps) {
  const requested =
    params && typeof params === 'object' && typeof params.protocolVersion === 'string'
      ? params.protocolVersion
      : undefined
  return {
    protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION,
    capabilities: { tools: {} },
    serverInfo: {
      name: typeof deps.serverName === 'string' && deps.serverName ? deps.serverName : 'docvi',
      version: String(deps.serverVersion ?? ''),
    },
    instructions: instructionsOf(deps),
  }
}

/** tools/call：未知工具 / 缺参报 -32602；工具业务一律返回 isError=false 的说明文本 */
function toolsCall(params, deps) {
  const record = params && typeof params === 'object' ? params : null
  const name = record?.name
  if (typeof name !== 'string' || !name) {
    throw new RpcParamError('参数错误：tools/call 需要字符串参数 name')
  }
  const tool = availableTools(deps).find(item => item.name === name)
  if (!tool) throw new RpcParamError(`未知工具：${name}`)
  const rawArgs = record?.arguments ?? {}
  if (rawArgs === null || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
    throw new RpcParamError('参数错误：arguments 应为对象')
  }
  const text = tool.handler(rawArgs, deps)
  return { content: [{ type: 'text', text }], isError: false }
}

/** 方法名 → 处理器（Map 防原型键误命中） */
const HANDLERS = new Map([
  ['initialize', (params, deps) => initializeResult(params, deps)],
  ['tools/list', (_params, deps) => ({ tools: availableTools(deps).map(publicSpec) })],
  ['tools/call', (params, deps) => toolsCall(params, deps)],
])

/**
 * 分发一条 JSON-RPC 消息（解析层由调用方负责——这里拿到的是已解析的值）。
 *
 * 通知（无 id 成员，如 notifications/initialized）不产生响应；消息形态不合法回 -32600；
 * 未知方法 -32601；参数 / 未知工具 -32602；内部异常 -32603。
 *
 * @returns {{kind: 'result', result: unknown}
 *          | {kind: 'error', code: number, message: string}
 *          | {kind: 'notification'}}
 */
export function dispatch(message, deps) {
  if (Array.isArray(message)) {
    return {
      kind: 'error',
      code: -32600,
      message: '非法请求：不支持批量请求（JSON-RPC 2.0 批量为可选扩展）',
    }
  }
  if (!message || typeof message !== 'object') {
    return { kind: 'error', code: -32600, message: '非法请求：请求体应为 JSON-RPC 2.0 对象' }
  }
  const hasId = Object.prototype.hasOwnProperty.call(message, 'id')
  if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return {
      kind: 'error',
      code: -32600,
      message: '非法请求：jsonrpc 须为 "2.0" 且 method 须为字符串',
    }
  }
  if (!hasId) return { kind: 'notification' }

  const handler = HANDLERS.get(message.method)
  if (!handler) {
    return { kind: 'error', code: -32601, message: `未知方法：${message.method}` }
  }
  try {
    return { kind: 'result', result: handler(message.params, deps) }
  } catch (error) {
    if (error instanceof RpcParamError) {
      return { kind: 'error', code: -32602, message: error.message }
    }
    return {
      kind: 'error',
      code: -32603,
      message: `内部错误：${String(error?.message ?? error)}`,
    }
  }
}

/** 读请求体（UTF-8 文本；超限即拒——超限后不再累积，仍消费剩余数据避免连接悬挂） */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    let settled = false
    const chunks = []
    req.on('data', chunk => {
      if (settled) return
      size += chunk.length
      if (size > BODY_LIMIT) {
        settled = true
        reject(new Error('请求体超过大小上限'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', error => {
      if (settled) return
      settled = true
      reject(error)
    })
  })
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache',
  })
  res.end(JSON.stringify(payload))
}

/** 成功响应（HTTP 200 + JSON-RPC result） */
function sendResult(res, id, result) {
  sendJson(res, 200, { jsonrpc: '2.0', id, result })
}

/** 错误响应：-32700 / -32600（消息形态不合法）按 MCP 规范回 400；其余协议错误回 200 带 error 体 */
function sendError(res, id, code, message, status = 200) {
  sendJson(res, status, { jsonrpc: '2.0', id, error: { code, message } })
}

/** 只从合法消息对象里取 id（非对象 / 数组一律 null——错误响应无法关联请求） */
function idOf(message) {
  return message && typeof message === 'object' && !Array.isArray(message)
    ? (message.id ?? null)
    : null
}

/**
 * 端点入口（httpd 路由 POST /mcp 调用）：读体 → JSON.parse → dispatch。
 *
 * - 解析失败 → -32700（400）；批量数组 / 消息形态非法 → -32600（400）；
 * - 通知 → 202 空体；未知方法 → -32601（200）；参数 / 未知工具 → -32602（200）；
 * - 内部异常 → -32603（200）。
 * 本函数自带全部错误收口（返回的 Promise 不会因业务异常而 reject）。
 */
export function handleMcp(req, res, deps) {
  return readBody(req)
    .then(raw => {
      let message
      try {
        message = JSON.parse(raw)
      } catch {
        return sendError(res, null, -32700, '解析失败：请求体不是合法 JSON', 400)
      }
      const outcome = dispatch(message, deps)
      if (outcome.kind === 'notification') {
        res.writeHead(202)
        return res.end()
      }
      if (outcome.kind === 'error') {
        return sendError(
          res,
          idOf(message),
          outcome.code,
          outcome.message,
          outcome.code === -32600 ? 400 : 200,
        )
      }
      return sendResult(res, idOf(message), outcome.result)
    })
    .catch(() => {
      if (!res.headersSent) {
        sendError(res, null, -32600, '非法请求：请求体读取失败或超过大小上限', 400)
      } else {
        res.end()
      }
    })
}
