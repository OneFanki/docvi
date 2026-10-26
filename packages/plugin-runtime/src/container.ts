import type {
  CommandContribution,
  PluginActivationContext,
  PluginManifest,
  PluginModule,
} from '@docvi/plugin-api'

/**
 * 插件容器。
 *
 * 只解决四件事（刻意不复刻 Cordis）：
 *  1. **激活顺序**：按 dependencies 拓扑排序；依赖缺失则跳过该插件并记错误，不阻塞其他。
 *  2. **错误隔离**：单个插件 activate 抛错只影响它自己，宿主继续运行。
 *  3. **资源回收**：插件注册的一切（组件/命令/样式/监听）都包成 Disposable，
 *     停用时逆序执行，禁用后不留残余。
 *  4. **热重载**：先 dispose 再带 cache-bust 重新 import（开发态用）。
 *
 * 为什么不用 Cordis：Cordis 解决服务依赖图与生命周期，而这里的插件生命周期
 * 由宿主命令式驱动（安装/启用/禁用），引入依赖注入框架只多一层心智负担。
 */

export type Disposable = () => void

export interface PluginContainerOptions {
  /** 共享的 Vue 运行时（必须与宿主同一个实例） */
  vue: Record<string, unknown>
  locale: string
  log?: (level: 'info' | 'warn' | 'error', message: string) => void
  /** 组件注册表：注册/反注册由容器转发 */
  registerComponent?: (kind: string, component: unknown) => Disposable
  registerCommand?: (command: CommandContribution & { run: () => void }) => Disposable
}

export interface ActivationResult {
  pluginId: string
  ok: boolean
  error: string | null
  /** 该插件贡献的组件 kind */
  components: string[]
  /** 该插件贡献的命令 id */
  commands: string[]
}

interface LoadedPlugin {
  manifest: PluginManifest
  /** 已激活插件的清理栈（逆序执行） */
  disposables: Disposable[]
  module: PluginModule | null
  result: ActivationResult
}

export class PluginContainer {
  private readonly plugins = new Map<string, LoadedPlugin>()
  private readonly options: PluginContainerOptions

  constructor(options: PluginContainerOptions) {
    this.options = options
  }

  /** 已激活的插件结果（给插件面板展示） */
  results(): ActivationResult[] {
    return [...this.plugins.values()].map(item => item.result)
  }

  has(id: string): boolean {
    return this.plugins.has(id)
  }

  /**
   * 激活一批插件。
   *
   * @param modules 插件 id → 已 import 的模块（无 entry 的纯声明插件传 null）
   */
  async activateAll(
    modules: Map<string, { manifest: PluginManifest; module: PluginModule | null }>,
  ): Promise<ActivationResult[]> {
    const order = topoSort(modules)
    const results: ActivationResult[] = []

    for (const id of order.skipped) {
      const manifest = modules.get(id)?.manifest
      results.push({
        pluginId: id,
        ok: false,
        error: manifest ? '依赖缺失或存在循环依赖，已跳过' : '插件不存在',
        components: [],
        commands: [],
      })
    }

    for (const id of order.order) {
      const item = modules.get(id)
      if (!item) continue
      const result = await this.activateOne(item.manifest, item.module)
      results.push(result)
    }
    return results
  }

  private async activateOne(
    manifest: PluginManifest,
    module: PluginModule | null,
  ): Promise<ActivationResult> {
    const id = manifest.name
    const loaded: LoadedPlugin = {
      manifest,
      disposables: [],
      module,
      result: { pluginId: id, ok: true, error: null, components: [], commands: [] },
    }
    this.plugins.set(id, loaded)

    if (!module?.activate) {
      // 纯声明插件：贡献点由宿主直接消费（主题 token、组件元数据），无需代码
      return loaded.result
    }

    const context: PluginActivationContext = {
      pluginId: id,
      version: manifest.version,
      vue: this.options.vue,
      locale: this.options.locale,
      log: (level, message) => this.options.log?.(level, `[plugin:${id}] ${message}`),
      registerComponent: (kind, component) => {
        const off = this.options.registerComponent?.(kind, component) ?? (() => undefined)
        loaded.result.components.push(kind)
        const wrapped = () => {
          off()
          loaded.result.components = loaded.result.components.filter(item => item !== kind)
        }
        loaded.disposables.push(wrapped)
        return wrapped
      },
      registerCommand: command => {
        const off = this.options.registerCommand?.(command) ?? (() => undefined)
        loaded.result.commands.push(command.id)
        const wrapped = () => {
          off()
          loaded.result.commands = loaded.result.commands.filter(item => item !== command.id)
        }
        loaded.disposables.push(wrapped)
        return wrapped
      },
    }

    try {
      await module.activate(context)
    } catch (error) {
      // 激活失败：回滚它已经注册的贡献，标记失败但保留记录（面板要能看到原因）
      this.disposeLoaded(loaded)
      loaded.result.ok = false
      loaded.result.error = error instanceof Error ? error.message : String(error)
      this.options.log?.('error', `[plugin:${id}] 激活失败：${loaded.result.error}`)
    }
    return loaded.result
  }

  /** 停用某个插件：逆序执行清理栈 + 调 deactivate */
  async deactivate(id: string): Promise<void> {
    const loaded = this.plugins.get(id)
    if (!loaded) return
    this.disposeLoaded(loaded)
    try {
      await loaded.module?.deactivate?.()
    } catch (error) {
      this.options.log?.('warn', `[plugin:${id}] deactivate 抛错：${String(error)}`)
    }
    this.plugins.delete(id)
  }

  async deactivateAll(): Promise<void> {
    for (const id of [...this.plugins.keys()].reverse()) await this.deactivate(id)
  }

  private disposeLoaded(loaded: LoadedPlugin): void {
    // 逆序：后注册的先撤销，避免清理顺序反过来留下悬空引用
    while (loaded.disposables.length) {
      const off = loaded.disposables.pop()
      try {
        off?.()
      } catch (error) {
        this.options.log?.('warn', `[plugin:${loaded.manifest.name}] 清理失败：${String(error)}`)
      }
    }
  }
}

interface TopoResult {
  order: string[]
  skipped: string[]
}

/**
 * 拓扑排序。
 *
 * 依赖缺失或成环的插件进 skipped（不激活），其余按依赖优先的顺序排好。
 * 这里不抛错——一个坏插件不该让整批插件都装不上。
 */
function topoSort(modules: Map<string, { manifest: PluginManifest }>): TopoResult {
  const order: string[] = []
  const skipped: string[] = []
  const state = new Map<string, 'visiting' | 'done'>()

  const visit = (id: string): boolean => {
    const status = state.get(id)
    if (status === 'done') return true
    if (status === 'visiting') return false // 循环依赖
    const item = modules.get(id)
    if (!item) return false
    state.set(id, 'visiting')
    for (const dep of item.manifest.dependencies ?? []) {
      if (!visit(dep)) {
        state.delete(id)
        return false
      }
    }
    state.set(id, 'done')
    order.push(id)
    return true
  }

  for (const id of modules.keys()) {
    if (!visit(id)) skipped.push(id)
  }
  return { order, skipped }
}
