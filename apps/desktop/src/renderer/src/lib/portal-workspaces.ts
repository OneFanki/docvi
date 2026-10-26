import type { PortalWorkspace, WorkspaceEntry } from '@docvi/shared'

/**
 * 部署器 `/api/portal` → 渲染层工作区（容器读者面）。
 *
 * 单独成模块而不是留在 web-host 里：web-host 依赖 localStorage 与 fetch，
 * 在 node 里无法整模块加载；这里的转换是纯函数，可以直接单测。转换本身
 * 又是「界面信息是否完整」的唯一来源，值得有测试钉住。
 */

/** 部署器分支（artifact / index 是自由字符串，进来先收窄） */
export interface PortalBranchRaw {
  branch: string
  isDefault: boolean
  artifact: string
  index: string
}

export interface PortalRepoRaw {
  slug: string
  name: string
  ready: boolean
  branches: PortalBranchRaw[]
  defaultBranch: string | null
  /** 首次克隆尚未完成（此时 branches 为空、主库还不存在） */
  cloning?: boolean
  syncAt?: string | null
  syncError?: string | null
}

export interface PortalPayloadRaw {
  repos: PortalRepoRaw[]
  mounted: { slug: string; branch: string } | null
}

export function toArtifact(value: string): PortalWorkspace['branches'][number]['artifact'] {
  return value === 'ready' || value === 'building' || value === 'failed' ? value : 'none'
}

export function toIndex(value: string): PortalWorkspace['branches'][number]['index'] {
  return value === 'indexed' || value === 'indexing' || value === 'failed' ? value : 'pending'
}

/**
 * 两处「不能按直觉写」：
 *  1. **克隆中的仓库也要列出来**：旧版门户会显示「克隆中」并自动刷新，读者
 *     否则会以为仓库丢了。没建好产物的仓库进不去正文，但卡片要占位——所以
 *     这里不过滤 ready，进入动作由卡片按 `portal.cloning` 与分支状态决定。
 *  2. **分支状态原样带过去**：分支选择器要区分「可浏览」「构建中」「失败」，
 *     这些信息只有 `/api/portal` 有；丢掉它就得在界面里重新拉一次接口。
 */
export function normalizePortal(portal: PortalPayloadRaw): WorkspaceEntry[] {
  return portal.repos.map(repo => ({
    // 渲染层的 workspaceId 要稳定且能反查 slug，这里直接用 slug
    id: repo.slug,
    name: repo.name,
    // 容器里没有本地路径；root 放读者面 URL，仅用于展示
    root: `/${repo.slug}/`,
    addedAt: 0,
    lastOpenedAt: Date.now(),
    portal: {
      branches: repo.branches.map(item => ({
        branch: item.branch,
        artifact: toArtifact(item.artifact),
        index: toIndex(item.index),
        isDefault: item.isDefault,
      })),
      defaultBranch: repo.defaultBranch ?? null,
      syncAt: repo.syncAt ?? null,
      syncError: repo.syncError ?? null,
      cloning: repo.cloning === true,
    },
  }))
}
