import { createHash } from 'node:crypto'
import { dirname } from 'node:path'

/**
 * 单文件文档的资产根登记表。
 *
 * 工作区文档的图片走 `docvi://asset/<工作区 id>/…`（按登记的内容根取文件），
 * 但**工作区外的单文件**没有内容根——它只被 `fileRead` 读过，位置任意。
 * 少了这一层，`![](images/a.png)` 会被拼成 `docvi://app/images/a.png`，那是
 * 渲染产物目录，必然 404：用户在单文件里看到的是一排破图。
 *
 * 两条设计取舍：
 *  - URL 里**不放磁盘路径**：按绝对路径的摘要给 id，协议侧反查目录。路径不出现
 *    在 DOM 属性、日志与截图里，也没有可注入的段。
 *  - 只认「被读过」的目录：登记是 `fileRead` 的副作用，渲染层无法凭空构造一个
 *    可访问的根。上限内按最近使用淘汰（用户可能同时开着几十个单文件标签）。
 */
export interface LocalAssetRegistry {
  /** 登记一篇已打开的单文件，返回它的资产前缀（`docvi://local/<id>`） */
  register(absolutePath: string): string
  /** 协议侧：按 id 取回资产根目录 */
  rootOf(id: string): string | undefined
}

const MAX_ROOTS = 64

export function createLocalAssetRegistry(): LocalAssetRegistry {
  /** Map 保持插入顺序：命中时先删再插，天然是 LRU */
  const roots = new Map<string, string>()

  return {
    register(absolutePath) {
      const id = createHash('sha256')
        .update(absolutePath.replaceAll('\\', '/').toLowerCase())
        .digest('hex')
        .slice(0, 16)
      roots.delete(id)
      // 资产根 = 文档所在目录：同目录下的 images/、assets/ 都能取到
      roots.set(id, dirname(absolutePath))
      while (roots.size > MAX_ROOTS) {
        const oldest = roots.keys().next()
        if (oldest.done) break
        roots.delete(oldest.value)
      }
      return `docvi://local/${id}`
    },
    rootOf(id) {
      return roots.get(id)
    },
  }
}
