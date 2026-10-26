import { randomBytes } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { Server } from 'node:http'

import type {
  ServiceCommand,
  ServiceConfig,
  ServiceEvent,
  ServicePlugin,
  ServiceRuntimeState,
  ServiceWorkspace,
} from '@docvi/shared'

import { createCorpus, type Corpus } from '../../../../packages/server/src/corpus.mjs'
import { createHttpServer } from './http.ts'
import type { McpDeps } from '../../../../packages/server/src/mcp.mjs'
import { createServiceMcpDeps } from './plugin-deps.ts'
import { createShareRenderer } from './share.ts'
import { createShareStore } from './shares.ts'

/**
 * 服务进程入口。
 *
 * 两种启动方式共用这一份代码：
 *  - **托管**：主进程 `utilityProcess.fork(out/main/service.js)`，通过 parentPort 收发消息；
 *  - **独立**：`node out/main/service.js` 配环境变量，无窗口也能提供 MCP 与分享——
 *    这是「关掉窗口后 AI 仍能查文档」的前提。
 *
 * 进程内状态：workspaces / plugins 是主进程推来的快照，服务自己不扫盘发现插件。
 */

/** utilityProcess 的 parentPort（Node 类型里没有） */
interface ParentPortLike {
  postMessage(message: unknown): void
  on(event: 'message', listener: (event: { data: unknown }) => void): void
}

const PORT_ATTEMPTS = 20
const SERVER_VERSION = process.env.DOCVI_APP_VERSION ?? 'dev'

function parentPort(): ParentPortLike | null {
  const candidate = (process as unknown as { parentPort?: ParentPortLike }).parentPort
  return candidate ?? null
}

function emit(port: ParentPortLike | null, event: ServiceEvent): void {
  if (port) {
    port.postMessage(event)
    return
  }
  if (event.type === 'log') {
    const line = `[service] ${event.level}: ${event.message}`
    if (event.level === 'error') console.error(line)
    else console.log(line)
  }
}

/** 独立模式的配置：环境变量优先，缺省值保证「直接跑起来」也能用 */
function configFromEnv(): ServiceConfig {
  const raw = process.env.DOCVI_SERVICE_CONFIG
  if (raw) {
    try {
      return JSON.parse(raw) as ServiceConfig
    } catch {
      console.error('[service] DOCVI_SERVICE_CONFIG 不是合法 JSON，改用环境变量')
    }
  }
  const workspaces: ServiceWorkspace[] = []
  const wsRaw = process.env.DOCVI_SERVICE_WORKSPACES
  if (wsRaw) {
    try {
      const list = JSON.parse(wsRaw) as unknown
      if (Array.isArray(list)) {
        for (const item of list) {
          if (typeof item === 'string' && item) {
            workspaces.push({
              id: item,
              name: item.split(/[/\\]/).filter(Boolean).pop() ?? item,
              root: resolve(item),
            })
          }
        }
      }
    } catch {
      console.error('[service] DOCVI_SERVICE_WORKSPACES 不是合法 JSON 数组')
    }
  }
  const dataDir =
    process.env.DOCVI_SERVICE_DATA_DIR ??
    (process.env.APPDATA ? join(process.env.APPDATA, 'docvi') : process.cwd())
  return {
    dataDir,
    preferredPort: Number(process.env.DOCVI_SERVICE_PORT ?? 7311) || 7311,
    lan: process.env.DOCVI_SERVICE_LAN === '1',
    // 独立模式也必须有令牌：没有令牌的 MCP 端点等于把文档库交给本机任意进程
    token: process.env.DOCVI_SERVICE_TOKEN ?? randomBytes(16).toString('hex'),
    workspaces,
    plugins: [],
  }
}

/** 读插件包内文件（限在包目录内） */
function readPluginFile(pluginDir: string, relPath: string): string | null {
  const base = resolve(pluginDir)
  const target = resolve(base, relPath)
  const prefix = base.endsWith(sep) ? base : `${base}${sep}`
  if (target !== base && !target.startsWith(prefix)) return null
  try {
    return readFileSync(target, 'utf8')
  } catch {
    return null
  }
}

async function listen(server: Server, host: string, preferredPort: number): Promise<number> {
  for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt += 1) {
    const port = preferredPort + attempt
    try {
      await new Promise<void>((resolveListen, rejectListen) => {
        const onError = (error: NodeJS.ErrnoException): void => {
          server.removeListener('listening', onListening)
          rejectListen(error)
        }
        const onListening = (): void => {
          server.removeListener('error', onError)
          resolveListen()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(port, host)
      })
      return port
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
    }
  }
  throw new Error(`端口 ${preferredPort}–${preferredPort + PORT_ATTEMPTS - 1} 全部被占用`)
}

interface Runtime {
  port: number | null
  /** 对外展示用的主机名（监听 0.0.0.0 时给 localhost） */
  host: string | null
  error: string | null
}

async function main(): Promise<void> {
  const port = parentPort()
  let config: ServiceConfig | null = port ? null : configFromEnv()
  let workspaces: ServiceWorkspace[] = config?.workspaces ?? []
  let plugins: ServicePlugin[] = config?.plugins ?? []
  let shares = createShareStore(join(config?.dataDir ?? process.cwd(), 'shares.json'))
  let server: Server | null = null
  let runtime: Runtime = { port: null, host: null, error: null }

  const renderer = createShareRenderer()
  // 检索范围 = 已打开工作区（MCP 的 search_docs / read_doc 只读这一层，不碰窗口状态）
  const corpus: Corpus = createCorpus(() =>
    workspaces.map(workspace => ({ workspace: workspace.name, root: workspace.root })),
  )

  const mcpDeps: McpDeps = createServiceMcpDeps({
    serverVersion: SERVER_VERSION,
    plugins: () => plugins,
    readPluginFile,
    corpus,
  })

  const stateNow = (): ServiceRuntimeState => {
    const lan = config?.lan ?? false
    const { port: listening, host, error } = runtime
    return {
      running: listening !== null,
      port: listening,
      host,
      lan,
      endpoint: listening ? `http://${host ?? '127.0.0.1'}:${listening}/mcp` : '',
      token: config?.token ?? '',
      error,
    }
  }

  const publish = (): void => {
    emit(port, { type: 'state', state: stateNow() })
  }

  const startServer = async (): Promise<void> => {
    const active = config
    if (!active) return
    if (server) {
      const closing = server
      server = null
      await new Promise<void>(resolveClose => closing.close(() => resolveClose()))
    }
    const bindHost = active.lan ? '0.0.0.0' : '127.0.0.1'
    const current = createHttpServer({
      token: active.token,
      mcp: mcpDeps,
      shares: {
        list: () => shares.list(stateNow()),
        find: id => shares.find(id),
      },
      readShareFile: (share, rel) => renderer.readShareFile(share, rel),
      renderShareDoc: (share, rel) => renderer.renderShareDoc(share, rel),
      renderShareIndex: share => renderer.renderShareIndex(share),
      log: (level, message) => emit(port, { type: 'log', level, message }),
    })
    server = current
    try {
      const actual = await listen(current, bindHost, active.preferredPort)
      runtime = { port: actual, host: active.lan ? 'localhost' : bindHost, error: null }
      publish()
      emit(port, { type: 'log', level: 'info', message: `服务已启动：${bindHost}:${actual}` })
    } catch (error) {
      runtime = { port: null, host: null, error: (error as Error).message }
      publish()
      emit(port, {
        type: 'log',
        level: 'error',
        message: `服务启动失败：${(error as Error).message}`,
      })
    }
  }

  const applyInit = async (next: ServiceConfig): Promise<void> => {
    config = next
    workspaces = next.workspaces
    plugins = next.plugins
    shares = createShareStore(join(next.dataDir, 'shares.json'))
    await startServer()
  }

  /** 分享目标类型：以磁盘实际状态为准，路径不存在时按扩展名猜 */
  const kindOf = (target: string): 'file' | 'dir' => {
    try {
      return statSync(target).isDirectory() ? 'dir' : 'file'
    } catch {
      return target.toLowerCase().endsWith('.md') ? 'file' : 'dir'
    }
  }

  const handleRpc = (command: Extract<ServiceCommand, { type: 'rpc' }>): void => {
    const reply = (ok: boolean, data: unknown, error?: string): void => {
      if (ok) emit(port, { type: 'rpc-result', id: command.id, ok: true, data })
      else emit(port, { type: 'rpc-result', id: command.id, ok: false, error: error ?? '未知错误' })
    }
    try {
      if (command.method === 'share-list') {
        reply(true, shares.list(stateNow()))
        return
      }
      if (command.method === 'share-create') {
        const target = command.params?.path
        if (!target) throw new Error('缺少分享目标路径')
        const entry = shares.add({ path: target, kind: kindOf(target) })
        const created = shares.list(stateNow()).find(item => item.id === entry.id) ?? null
        reply(true, created)
        return
      }
      if (command.method === 'share-remove') {
        const id = command.params?.id
        if (!id) throw new Error('缺少分享 id')
        shares.remove(id)
        reply(true, shares.list(stateNow()))
        return
      }
      throw new Error(`未知 RPC 方法：${command.method}`)
    } catch (error) {
      reply(false, null, (error as Error).message)
    }
  }

  const shutdown = async (): Promise<void> => {
    const closing = server
    server = null
    if (closing) await new Promise<void>(resolveClose => closing.close(() => resolveClose()))
    process.exit(0)
  }

  const handle = (command: ServiceCommand): void => {
    switch (command.type) {
      case 'init':
        void applyInit(command.config)
        return
      case 'update':
        workspaces = command.workspaces
        plugins = command.plugins
        return
      case 'set-lan':
        if (!config) return
        config = { ...config, lan: command.lan }
        void startServer()
        return
      case 'rpc':
        handleRpc(command)
        return
      case 'shutdown':
        void shutdown()
        return
    }
  }

  if (port) {
    port.on('message', event => {
      const data = event.data as ServiceCommand | undefined
      if (data && typeof data === 'object' && typeof data.type === 'string') handle(data)
    })
    emit(port, { type: 'log', level: 'info', message: '服务进程已就绪，等待初始化' })
  } else {
    // 独立模式：立刻用环境配置启动
    const initial = config
    if (initial) await applyInit(initial)
    process.on('SIGINT', () => void shutdown())
    process.on('SIGTERM', () => void shutdown())
  }
}

void main()
