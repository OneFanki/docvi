import { utilityProcess, type UtilityProcess } from 'electron'
import { join } from 'node:path'

import type {
  ServiceCommand,
  ServiceConfig,
  ServiceEvent,
  ServicePlugin,
  ServiceRuntimeState,
  ServiceWorkspace,
  ShareEntry,
} from '@docvi/shared'

/**
 * 服务进程托管。
 *
 * 主进程只管「拉起 / 转发 / 重启」，不理解 MCP 与分享的细节：
 *  - 状态由服务自己算好推上来（端口顺延、绑定失败都在服务内收口），这里只缓存最后一份；
 *  - 分享 CRUD 走 RPC（id 匹配请求与应答），避免主进程再读一遍 shares.json；
 *  - 崩溃后按指数退避重启，并保留最近一次错误给 UI 显示。
 */

const RPC_TIMEOUT_MS = 8000

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export interface ServiceManager {
  start(config: ServiceConfig): void
  state(): ServiceRuntimeState
  restart(): Promise<ServiceRuntimeState>
  setLan(lan: boolean): Promise<ServiceRuntimeState>
  /** 改首选端口并重启（端口被占用时服务仍会顺延，返回的是最终端口） */
  setPort(port: number): Promise<ServiceRuntimeState>
  update(workspaces: ServiceWorkspace[], plugins: ServicePlugin[]): void
  listShares(): Promise<ShareEntry[]>
  createShare(path: string): Promise<ShareEntry | null>
  removeShare(id: string): Promise<ShareEntry[]>
  /** 订阅状态变化（推给渲染进程） */
  onState(listener: (state: ServiceRuntimeState) => void): () => void
  /** 等待服务就绪（首次启动或重启后） */
  ready(): Promise<ServiceRuntimeState>
  stop(): void
}

const EMPTY_STATE: ServiceRuntimeState = {
  running: false,
  port: null,
  host: null,
  lan: false,
  endpoint: '',
  token: '',
  error: null,
}

export function createServiceManager(entryPath: string): ServiceManager {
  let child: UtilityProcess | null = null
  let config: ServiceConfig | null = null
  let current: ServiceRuntimeState = EMPTY_STATE
  let pending = new Map<string, Pending>()
  const listeners = new Set<(state: ServiceRuntimeState) => void>()
  let seq = 0
  let restartCount = 0
  let readyWaiters: Array<(state: ServiceRuntimeState) => void> = []
  let stopped = false

  const notify = (): void => {
    for (const listener of listeners) listener(current)
    if (current.running && readyWaiters.length) {
      const waiters = readyWaiters
      readyWaiters = []
      for (const resolve of waiters) resolve(current)
    }
  }

  const settle = (event: Extract<ServiceEvent, { type: 'rpc-result' }>): void => {
    const item = pending.get(event.id)
    if (!item) return
    pending.delete(event.id)
    clearTimeout(item.timer)
    if (event.ok) item.resolve(event.data)
    else item.reject(new Error(event.error))
  }

  const handleEvent = (event: ServiceEvent): void => {
    if (event.type === 'state') {
      // 服务重启后重启计数清零：只有「稳定跑起来过又挂了」才值得退避
      if (event.state.running) restartCount = 0
      current = event.state
      notify()
      return
    }
    if (event.type === 'log') {
      if (event.level === 'error') console.error(`[service] ${event.message}`)
      else console.log(`[service] ${event.message}`)
      return
    }
    settle(event)
  }

  const send = (command: ServiceCommand): void => {
    child?.postMessage(command)
  }

  const rpc = <T>(
    method: 'share-list' | 'share-create' | 'share-remove',
    params?: Record<string, string>,
  ): Promise<T> => {
    if (!child) return Promise.reject(new Error('服务未启动'))
    const id = `r${(seq += 1)}`
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error('服务响应超时'))
      }, RPC_TIMEOUT_MS)
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
      send({ type: 'rpc', id, method, ...(params ? { params } : {}) })
    })
  }

  const spawn = (): void => {
    if (!config) return
    stopped = false
    child = utilityProcess.fork(entryPath, [], {
      serviceName: 'docvi-service',
      env: {
        ...process.env,
        DOCVI_APP_VERSION: process.env.npm_package_version ?? 'dev',
      },
    })
    child.on('message', event => handleEvent(event as ServiceEvent))
    child.on('exit', code => {
      // 先结算所有挂起 RPC：否则 UI 会一直转圈到超时
      for (const [, item] of pending) {
        clearTimeout(item.timer)
        item.reject(new Error('服务进程已退出'))
      }
      pending = new Map()
      child = null
      current = { ...current, running: false, error: `服务进程退出（code=${code ?? '未知'}）` }
      notify()

      if (stopped || !config) return
      const delay = Math.min(1000 * 2 ** restartCount, 10_000)
      restartCount += 1
      setTimeout(() => {
        if (stopped) return
        spawn()
        if (config) send({ type: 'init', config })
      }, delay)
    })
    send({ type: 'init', config })
  }

  const ready = (): Promise<ServiceRuntimeState> => {
    if (current.running) return Promise.resolve(current)
    return new Promise<ServiceRuntimeState>(resolve => {
      readyWaiters.push(resolve)
      // 启动失败的兜底：不能让 await 永远挂着
      setTimeout(() => resolve(current), 6000)
    })
  }

  const setLan = (lan: boolean): Promise<ServiceRuntimeState> => {
    if (!config) return Promise.reject(new Error('服务未启动'))
    config = { ...config, lan }
    send({ type: 'set-lan', lan })
    // 重绑端口是异步的：等 state 事件；这里给一个上限，避免 UI 卡住
    return new Promise<ServiceRuntimeState>(resolve => {
      const timer = setTimeout(() => {
        unsubscribe()
        resolve(current)
      }, 5000)
      const unsubscribe = manager.onState(state => {
        if (state.running && state.lan === lan) {
          clearTimeout(timer)
          unsubscribe()
          resolve(state)
        }
      })
    })
  }

  const restart = async (): Promise<ServiceRuntimeState> => {
    stopped = true
    if (child) {
      send({ type: 'shutdown' })
      // 等一小会儿再强杀：服务进程收尾要关 HTTP 连接
      await new Promise<void>(resolveDelay => setTimeout(resolveDelay, 400))
      child?.kill()
      child = null
    }
    stopped = false
    restartCount = 0
    current = { ...EMPTY_STATE, lan: config?.lan ?? false, token: config?.token ?? '' }
    notify()
    spawn()
    return ready()
  }

  const setPort = async (port: number): Promise<ServiceRuntimeState> => {
    if (!config) throw new Error('服务未启动')
    // 新端口要重启才生效：服务进程只在 init 时读 preferredPort
    config = { ...config, preferredPort: port }
    return restart()
  }

  const manager: ServiceManager = {
    start(next) {
      config = next
      spawn()
    },
    state: () => current,
    restart,
    setLan,
    setPort,
    update(workspaces, plugins) {
      if (!config) return
      config = { ...config, workspaces, plugins }
      send({ type: 'update', workspaces, plugins })
    },
    listShares: () => rpc<ShareEntry[]>('share-list'),
    createShare: path => rpc<ShareEntry | null>('share-create', { path }),
    removeShare: id => rpc<ShareEntry[]>('share-remove', { id }),
    onState(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    ready,
    stop() {
      stopped = true
      send({ type: 'shutdown' })
      child?.kill()
      child = null
    },
  }

  return manager
}

/**
 * 服务进程入口产物路径（main 构建的第二个入口）。
 *
 * 打包态 service.js 走 asarUnpack 落到真实磁盘：utilityProcess.fork 拿到
 * `app.asar/...` 的虚拟路径时能否解析依赖 asar 实现版本，指到 `.unpacked`
 * 下的真实文件没有这个不确定性。
 */
export function serviceEntryPath(mainDir: string): string {
  const entry = join(mainDir, 'service.js')
  return entry.replace(/([/\\])app\.asar([/\\])/, '$1app.asar.unpacked$2')
}
