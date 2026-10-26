import { app } from 'electron'
import { join } from 'node:path'

/**
 * 数据目录布局（全部在 app.getPath('userData') 下）。
 *
 * 为什么集中定义：旧版把索引、设置、分享登记散在多个模块各自拼路径，
 * 迁移与备份时无法一处看清；这里只允许通过本模块取路径。
 *
 * 覆盖入口 `DOCVI_DATA_DIR`：自动化验收需要在**不碰用户真实数据**的前提下
 * 跑一个完整实例（标签会话、设置、分享登记都会往这里写）。没有这个入口时，
 * 测试只能连用户的 `%APPDATA%/docvi` 一起改——那是绝对不可接受的。
 * 与 `DOCVI_INSTANCE` 配合使用：单实例锁是按应用名全局生效的，
 * 换个名字才能让测试实例与用户实例并存。
 */
export function dataDir(): string {
  const override = process.env.DOCVI_DATA_DIR
  if (override && override.trim()) return override
  return app.getPath('userData')
}

export function workspacesFile(): string {
  return join(dataDir(), 'workspaces.json')
}

export function recentFile(): string {
  return join(dataDir(), 'recent.json')
}

export function settingsFile(): string {
  return join(dataDir(), 'settings.json')
}

/** 本地服务配置：令牌与局域网开关。单独成文件，便于用户手动重置令牌。 */
export function serviceFile(): string {
  return join(dataDir(), 'service.json')
}

export function sharesFile(): string {
  return join(dataDir(), 'shares.json')
}

export function cacheDir(): string {
  return join(dataDir(), 'cache')
}
