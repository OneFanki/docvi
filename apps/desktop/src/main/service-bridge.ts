import { randomBytes } from 'node:crypto'

import type { ServicePlugin, ServiceState, ShareEntry, WorkspaceEntry } from '@docvi/shared'

import { readJsonFile, writeJsonFile } from './store.ts'
import { serviceFile } from './paths.ts'
import type { PluginStore } from './plugin-store.ts'
import type { ServiceManager } from './service.ts'
import type { WorkspaceStore } from './store.ts'

/**
 * 服务配置与快照。
 *
 * 令牌持久化在 `service.json`：MCP 客户端的配置里写死的是完整 URL + 令牌，
 * 每次启动换一个令牌会让所有已配置的客户端立刻失效。
 */

interface ServiceSettings {
  token: string
  lan: boolean
  /** 首选端口：用户改过就记住，否则每次从默认值起 */
  port: number
}

const DEFAULT_PORT = 7311

function loadSettings(): ServiceSettings {
  const raw = readJsonFile<Partial<ServiceSettings>>(serviceFile(), {})
  return {
    token: typeof raw.token === 'string' && raw.token.length >= 32 ? raw.token : newToken(),
    lan: raw.lan === true,
    port:
      typeof raw.port === 'number' &&
      Number.isInteger(raw.port) &&
      raw.port > 1024 &&
      raw.port < 65536
        ? raw.port
        : DEFAULT_PORT,
  }
}

function newToken(): string {
  return randomBytes(24).toString('hex')
}

export function saveServiceSettings(patch: Partial<ServiceSettings>): ServiceSettings {
  const next = { ...loadSettings(), ...patch }
  writeJsonFile(serviceFile(), next)
  return next
}

/** 当前已启用插件 → 服务快照（MCP 的插件工具只应看到启用中的包与组件） */
export function pluginSnapshot(plugins: PluginStore): ServicePlugin[] {
  return plugins
    .list()
    .filter(record => record.enabled && !record.error)
    .map(record => {
      const off = record.disabledComponents
      // 逐组件停用要在快照里就剔掉：MCP 的 list_components 必须与宿主注册表
      // 看到同一份活跃清单，否则 AI 会写出「AI 看得见、渲染不出来」的标签
      const contributes =
        record.manifest.contributes && off.length
          ? {
              ...record.manifest.contributes,
              components: (record.manifest.contributes.components ?? []).filter(
                item => !off.includes(item.kind),
              ),
            }
          : record.manifest.contributes
      return {
        name: record.manifest.name,
        displayName: record.manifest.displayName,
        version: record.manifest.version,
        trust: record.manifest.trust,
        dir: record.dir,
        ...(record.manifest.description ? { description: record.manifest.description } : {}),
        ...(contributes ? { contributes } : {}),
      }
    })
}

/** 工作区 → 服务快照 */
export function workspaceSnapshot(
  store: WorkspaceStore,
): Array<{ id: string; name: string; root: string }> {
  return store.list().map((entry: WorkspaceEntry) => ({
    id: entry.id,
    name: entry.name,
    root: entry.root,
  }))
}

export interface ServiceBridge {
  state(): ServiceState
  restart(): Promise<ServiceState>
  setLan(lan: boolean): Promise<ServiceState>
  /** 改首选端口并重启，同时记住这次选择 */
  setPort(port: number): Promise<ServiceState>
  /** 当前记住的首选端口（设置页显示用） */
  preferredPort(): number
  listShares(): Promise<ShareEntry[]>
  createShare(path: string): Promise<ShareEntry | null>
  removeShare(id: string): Promise<ShareEntry[]>
  onState(listener: (state: ServiceState) => void): () => void
  /** 插件或工作区变化后刷新服务侧快照 */
  sync(): void
  /** 应用退出：停掉服务进程，避免后台残留占端口 */
  stop(): void
}

export function createServiceBridge(
  manager: ServiceManager,
  store: WorkspaceStore,
  plugins: PluginStore,
  dataDir: string,
): ServiceBridge {
  const settings = loadSettings()
  /** 记住的首选端口：改端口后设置页要显示「下次启动用哪个」，不能只看当前实际端口 */
  let preferred = settings.port
  // 首次运行时把生成的令牌写回，后续启动复用
  if (readJsonFile<Partial<ServiceSettings>>(serviceFile(), {}).token !== settings.token) {
    saveServiceSettings(settings)
  }

  manager.start({
    dataDir,
    preferredPort: settings.port,
    lan: settings.lan,
    token: settings.token,
    workspaces: workspaceSnapshot(store),
    plugins: pluginSnapshot(plugins),
  })

  return {
    state: () => manager.state(),
    restart: () => manager.restart(),
    async setLan(lan) {
      saveServiceSettings({ lan })
      return manager.setLan(lan)
    },
    async setPort(port) {
      // 先落盘再重启：重启失败也不能丢掉用户的选择
      saveServiceSettings({ port })
      preferred = port
      return manager.setPort(port)
    },
    preferredPort: () => preferred,
    listShares: () => manager.listShares(),
    createShare: path => manager.createShare(path),
    removeShare: id => manager.removeShare(id),
    onState: listener => manager.onState(listener),
    sync() {
      manager.update(workspaceSnapshot(store), pluginSnapshot(plugins))
    },
    stop: () => manager.stop(),
  }
}
