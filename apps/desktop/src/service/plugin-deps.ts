import type { ServicePlugin } from '@docvi/shared'

import type { Corpus } from '../../../../packages/server/src/corpus.mjs'
import type { McpComponent, McpDeps, McpPlugin } from '../../../../packages/server/src/mcp.mjs'

/**
 * 桌面服务进程 → MCP 依赖的适配层。
 *
 * MCP 协议本身只有一份实现（`packages/server/src/mcp.mjs`），它只认**归一化**的取数
 * 契约（listPlugins / listComponents / componentDocs / pluginDocs + 文档检索）。
 * 桌面这边的插件是 `ServicePlugin` 形状（组件挂在 contributes 里、文档按包目录读），
 * 归一化逻辑属于宿主差异，放在这里；容器那边由 plugins 服务直接提供同形数据。
 */

/** 已启用插件清单（MCP list_plugins 的输入） */
export function mcpPlugins(plugins: ServicePlugin[]): McpPlugin[] {
  return plugins.map(plugin => ({
    name: plugin.name,
    displayName: plugin.displayName,
    version: plugin.version,
    trust: plugin.trust,
  }))
}

/** 活跃组件：按插件顺序先到先得（与宿主注册表同口径：同名 kind 后到者不出现） */
export function mcpComponents(plugins: ServicePlugin[]): McpComponent[] {
  const seen = new Set<string>()
  const out: McpComponent[] = []
  for (const plugin of plugins) {
    for (const item of plugin.contributes?.components ?? []) {
      if (seen.has(item.kind)) continue
      seen.add(item.kind)
      out.push({
        kind: item.kind,
        title: item.title,
        description: item.description,
        plugin: plugin.name,
      })
    }
  }
  return out
}

export interface ServiceMcpOptions {
  serverVersion: string
  /** 活查询：插件快照由主进程推来，替换即生效 */
  plugins: () => ServicePlugin[]
  /** 读插件包内相对文件；越界或缺失返回 null */
  readPluginFile: (pluginDir: string, relPath: string) => string | null
  corpus: Corpus
}

export function createServiceMcpDeps(options: ServiceMcpOptions): McpDeps {
  const components = (): McpComponent[] => mcpComponents(options.plugins())

  /** 组件 → 所属插件包目录（只在活跃清单里找，停用插件不返回文档） */
  const pluginDirOf = (kind: string): string | null => {
    const active = components().find(item => item.kind === kind)
    if (!active) return null
    return options.plugins().find(item => item.name === active.plugin)?.dir ?? null
  }

  return {
    serverVersion: options.serverVersion,
    serverName: 'docvi',
    listPlugins: () => mcpPlugins(options.plugins()),
    listComponents: components,
    componentDocs: kind => {
      const dir = pluginDirOf(kind)
      return dir ? options.readPluginFile(dir, 'docs/SKILL.md') : null
    },
    pluginDocs: name => {
      const plugin = options.plugins().find(item => item.name === name)
      return plugin ? options.readPluginFile(plugin.dir, 'docs/SKILL.md') : null
    },
    searchDocs: (query, limit) => options.corpus.search(query, limit),
    readDoc: path => options.corpus.readDoc(path),
  }
}
