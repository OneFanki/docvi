/**
 * 主进程 ↔ 服务进程的消息契约。
 *
 * 服务是独立进程（utilityProcess）：主进程只负责窗口，服务负责长驻的
 * MCP 端点与分享站点。两者之间的消息必须可序列化（结构化克隆），
 * 因此这里只放纯数据形状，不放函数。
 */

/** 服务已知的工作区（搜索语料的来源） */
export interface ServiceWorkspace {
  id: string
  name: string
  /** 绝对路径 */
  root: string
}

/** 已启用插件的只读快照：MCP 的插件类工具直接读它，不回查主进程 */
export interface ServicePlugin {
  name: string
  displayName: { zh: string; en?: string }
  version: string
  trust: 'presentation' | 'sandbox-service' | 'trusted-service'
  /** 插件包绝对目录：docs/SKILL.md 与组件文档从这里读 */
  dir: string
  description?: { zh: string; en?: string }
  contributes?: {
    components?: Array<{
      kind: string
      title: { zh: string; en?: string }
      description: { zh: string; en?: string }
    }>
    themes?: Array<{ id: string; title: { zh: string; en?: string } }>
    markdownSyntax?: Array<{
      name: string
      form: 'fence' | 'container'
      component: string
    }>
  }
}

/** 启动配置：主进程 spawn 时注入，或 `--service` 独立运行时从环境变量读 */
export interface ServiceConfig {
  /** 数据目录（shares.json、日志落点） */
  dataDir: string
  /** 首选端口；被占用时顺延，最终以 state.port 为准 */
  preferredPort: number
  /** true = 监听 0.0.0.0（局域网可访问） */
  lan: boolean
  /** MCP 访问令牌 */
  token: string
  workspaces: ServiceWorkspace[]
  plugins: ServicePlugin[]
}

/** 主进程 → 服务进程 */
export type ServiceCommand =
  | { type: 'init'; config: ServiceConfig }
  | { type: 'update'; workspaces: ServiceWorkspace[]; plugins: ServicePlugin[] }
  | { type: 'set-lan'; lan: boolean }
  /** 分享管理：分享登记由服务持有（路由要用），主进程只负责选择路径与展示 */
  | {
      type: 'rpc'
      id: string
      method: 'share-list' | 'share-create' | 'share-remove'
      params?: { path?: string; id?: string }
    }
  | { type: 'shutdown' }

/** 服务进程 → 主进程 */
export type ServiceEvent =
  | { type: 'state'; state: ServiceRuntimeState }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'rpc-result'; id: string; ok: true; data: unknown }
  | { type: 'rpc-result'; id: string; ok: false; error: string }

/** 服务自身的运行状态（与渲染层的 ServiceState 同形状，token 只在这里出现一次） */
export interface ServiceRuntimeState {
  running: boolean
  port: number | null
  host: string | null
  lan: boolean
  endpoint: string
  token: string
  error: string | null
}
