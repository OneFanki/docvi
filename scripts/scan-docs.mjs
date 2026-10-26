/**
 * 目录树扫描（node 侧包装）：逻辑已收敛到 scripts/lib/docs-core.mjs。
 * 本文件把核心函数以 node fs IO 绑定后按原签名导出（既有调用点零改动）。
 *
 * 规则（见 docs/architecture/README.md「写教程内容」）：
 * - 顶层由 docs.config.yaml 的 sidebar 声明；未声明时自动扫描顶层目录；
 * - 子目录按名称递归（自然排序，数字前缀有序），只保留含 .md 的目录；
 * - 目录节点优先链接 index.md → 索引.md → README.md，没有则是纯分组；
 * - 文件节点标题取文档首个 H1，缺失时取文件名；
 * - 目录下有 index.md 时该文件不再重复出现为子节点。
 */
import { nodeIO } from './lib/fs-io-node.mjs'
import { buildDocsSidebar as buildDocsSidebarCore, createExcludeMatcher } from './lib/docs-core.mjs'

export { createExcludeMatcher }

/**
 * 生成整站侧边栏（node fs）：声明的顶层目录 → 各自的递归子树；
 * 未声明时自动扫描顶层目录与顶层散装 Markdown。
 */
export function buildDocsSidebar(root, config = {}) {
  return buildDocsSidebarCore(root, config, nodeIO)
}
