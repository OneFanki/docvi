/**
 * 插件运行时：清单校验。
 *
 * 历史上的容器与激活器（PluginContainer）已删除——本仓从来没有实例化过它，
 * 而它承载的组件激活能力随组件系统在 2026-11-24 退役。现在这个包只剩「把
 * 外部插件的 plugin.json 校验成可信形状」这一件事。
 */
export { validateManifest } from './manifest.ts'
export type { ValidationFail, ValidationOk, ValidationResult } from './manifest.ts'
