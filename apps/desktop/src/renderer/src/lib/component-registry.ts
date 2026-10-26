import { ComponentRegistry } from '@docvi/renderer-core'

import { BUILTIN_KINDS } from '../plugins/builtin'
import { usePluginStore } from '../stores/plugins'

/**
 * 宿主组件注册表：按「插件是否启用」决定注册哪些内置组件。
 *
 * 为什么抽出来：阅读视图、导出、组件示例预览三处都要同一份注册规则——
 * 任何一处漏掉「停用插件的组件不注册」，就会出现「面板说停用了但预览里还活着」
 * 这类自相矛盾的呈现。规则只写一次，改动只改一处。
 */
export function createHostRegistry(): ComponentRegistry {
  const plugins = usePluginStore()
  const registry = new ComponentRegistry()
  const disabledPlugins = new Set(
    plugins.records.filter(record => !record.enabled || record.error).map(record => record.name),
  )
  for (const item of BUILTIN_KINDS) {
    if (disabledPlugins.has(item.plugin)) continue
    // 逐组件停用：该包把这个 kind 单独关掉时，组件退回「未注册」占位
    const record = plugins.records.find(entry => entry.name === item.plugin)
    if (record?.disabledComponents.includes(item.kind)) continue
    registry.register(item.kind, item.component, {
      title: item.title,
      description: item.description,
      packageName: item.plugin,
    })
  }
  return registry
}
