/**
 * 内容索引生成器（node 侧包装，AC5/AC6）：
 *   tree.json（目录树清单）+ search-index.json（minisearch 导出）
 *
 * 逻辑已收敛到 scripts/lib/docs-core.mjs（零 node 依赖，多宿主共用）——
 * deployer 索引刷新任务、壳 dev 中间件、Tauri 本地查看器、单文件 viewer
 * 全部走同一份实现，本文件只是 node fs 的注入包装。
 *
 * 产物协议（docs/design/平台自研壳与多宿主迁移.md 五）：
 * - version：两份产物一致的内容指纹（tree 与 index 版本一致方可配套加载）；
 * - tree：{ version, title, description, configSource, roots }（roots 与现有侧栏 1:1）；
 * - search-index：{ version, index(minisearch toJSON), docs[{path,title,summary}] }。
 */
import { nodeIO } from './lib/fs-io-node.mjs'
import {
  buildDocsIndex as buildDocsIndexCore,
  contentFingerprint as contentFingerprintCore,
} from './lib/docs-core.mjs'

/**
 * 生成两份索引产物。返回 { version, tree, searchIndex }。
 * @param root 内容根（含 docs.config.yaml）
 * @param options.autoscan 无配置时是否自动扫描（发布场景默认 false，由调用方前置要求）
 */
export async function buildDocsIndex(root, options = {}) {
  return buildDocsIndexCore(root, nodeIO, options)
}

/** 内容版本指纹：全部 md 的 路径+内容 摘要（同一内容 → 同一版本号） */
export function contentFingerprint(root) {
  return contentFingerprintCore(root, nodeIO)
}
