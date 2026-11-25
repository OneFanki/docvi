import { join } from 'node:path'

/**
 * 隔离模式下的路径推导（不依赖 electron，可单测）。
 *
 * 背景（2026-11-25 严重事故）：`DOCVI_DATA_DIR` 只隔离了注册表与设置，内建默认
 * 工作区仍取系统「文档」目录。一次截图跑下来，产品截图里出现了用户私人笔记的
 * 文件名——测试脚本真的读了真实的 `~/Documents/docvi`。
 *
 * 判据：只要给了 `DOCVI_DATA_DIR`，**所有**从系统环境推导的路径都必须落到它里面；
 * 只有不给（生产运行）才回退系统值。
 */

/**
 * 内建默认工作区的落点：隔离模式下是 `<dataDir>/documents`，否则是系统「文档」目录。
 *
 * 为什么不能只隔离我们自己的 JSON：真正的用户数据往往躺在 documents / desktop /
 * downloads / home 这些系统目录里，只改 `%APPDATA%` 等于没隔离。
 */
export function documentsDirFor(override: string | undefined, systemDocuments: string): string {
  const trimmed = override?.trim()
  if (trimmed) return join(trimmed, 'documents')
  return systemDocuments
}
