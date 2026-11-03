/**
 * `packages/server/src/mcp.mjs` 的类型声明：桌面服务进程（TypeScript）直接复用这份
 * 单一实现，需要声明才能获得类型检查（实现本身是纯 JS，deployer / server 直接跑）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

/** 已启用插件（宿主导出为协议形状；displayName 支持 string 或 {zh, en}） */
export interface McpPlugin {
  name: string
  displayName: unknown
  version: string
  /** 预设包标记（容器宿主用） */
  builtin?: boolean
  /** 信任等级（桌面宿主用） */
  trust?: string
}

/** 活跃组件（每 kind 至多一条——与宿主注册表同口径） */
export interface McpComponent {
  kind: string
  title: unknown
  description: unknown
  plugin: string
}

export interface SearchHit {
  /** 展示用范围名：桌面 = 工作区名；容器 = `<仓库名>@<分支>` */
  workspace: string
  path: string
  title: string
  /** 命中位置附近的一小段纯文本 */
  snippet: string
}

export interface ReadDocResult {
  workspace: string
  path: string
  title: string
  text: string
  /** 文件 mtime（毫秒）；overwrite 时作为 baseMtime。取不到为 null */
  mtime?: number | null
}

/** 可写入的工作区（桌面 = 已打开工作区；容器不提供写能力） */
export interface McpWorkspace {
  /** 工作区名（write_doc 的 workspace 参数取值） */
  workspace: string
  /** 绝对路径 */
  root: string
  /** 是否为 AI 未指定位置时的默认落笔处 */
  default?: boolean
}

export interface WriteDocInput {
  path: string
  text: string
  workspace?: string
  mode?: 'create' | 'overwrite' | 'append'
  baseMtime?: number
}

export interface WriteDocResult {
  status: 'created' | 'updated' | 'appended'
  workspace: string
  /** 工作区相对路径 */
  path: string
  bytes: number
  mtime: number
}

export interface McpDeps {
  serverVersion: string
  /** serverInfo.name，缺省 docvi */
  serverName?: string
  listPlugins(): McpPlugin[]
  listComponents(): McpComponent[]
  /** 读所属插件 docs/SKILL.md；缺失 / 越界返回 null */
  componentDocs(kind: string): string | null | undefined
  pluginDocs(name: string): string | null | undefined
  /** 提供后 search_docs 出现在工具面；缺省则整个工具不列出 */
  searchDocs?(query: string, limit: number): SearchHit[]
  /** 提供后 read_doc 出现在工具面；字符串即「可读的失败说明」 */
  readDoc?(path: string): ReadDocResult | string
  /** 提供后 list_workspaces 出现在工具面 */
  listWorkspaces?(): McpWorkspace[]
  /** 提供后 write_doc 出现在工具面（需同时提供 listWorkspaces）；失败用 error 字段 */
  writeDoc?(input: WriteDocInput): WriteDocResult | { error: string } | string
}

export interface ToolSpec {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export type RpcOutcome =
  | { kind: 'result'; result: unknown }
  | { kind: 'error'; code: number; message: string }
  | { kind: 'notification' }

/** 参数 / 未知工具错误：回 -32602，与内部错误（-32603）区分 */
export declare class RpcParamError extends Error {}

/** 宿主实际提供的工具面（检索依赖缺席时不含 search_docs / read_doc） */
export declare function availableTools(deps: McpDeps): ToolSpec[]

/** 全量工具名（UI 展示与测试用） */
export declare function toolNames(): string[]

/** 分发一条已解析的 JSON-RPC 消息 */
export declare function dispatch(message: unknown, deps: McpDeps): RpcOutcome

/** 完整端点：读体（上限 256KB）→ 分发 → 状态码；自带错误收口 */
export declare function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
  deps: McpDeps,
): Promise<void>
