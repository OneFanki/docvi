/**
 * 「当前文档是否已被分享」的判定（纯函数，可单测）。
 *
 * 分享登记里存的是**绝对路径**（文件分享指向那个 .md，目录分享指向目录根）。
 * 阅读视图拿到的 `DocPayload` 里既有 `path`（工作区相对）也有 `absolutePath`，
 * 而路径三处各不相同：分隔符（`\` 与 `/`）、大小写（Windows 不敏感）、以及
 * 「共享的是祖先目录」这一层关系。判定错的表现全是**静默**的——按钮该亮不亮、
 * 取消分享点不到，或者更糟：把一篇文档误判成「已分享」而点删除删掉了别的分享。
 *
 * 所以抽成纯函数单独测。
 */

/** 统一成「正斜杠 + 小写 + 无尾斜杠」：Windows 与 macOS 上两处写法都能对上 */
function canonical(value: string): string {
  return value.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
}

export interface ShareTargetLike {
  id: string
  path: string
  kind: 'file' | 'dir'
}

/**
 * 找出与某个文档相关的那条分享。
 *
 * 命中两种情况：
 *  1. **文件分享**就指向这篇文档本身；
 *  2. **目录分享**指向它的某个祖先目录——此时这篇文档确实已经能通过那个链接
 *     访问到（同目录下其它文档也在分享范围内），所以「已分享」是事实，不是近似。
 *
 * 同一篇文档可能同时被「文件分享」与「祖先目录分享」覆盖：优先返回文件分享，
 * 因为它才是用户为之点「分享」的那一次动作；取消它也最直接对应「我不想分享
 * 这一篇了」。目录分享仍然存在，界面上会因此显示为「已分享（目录）」，避免
 * 用户以为取消后别人立刻打不开——那取决于目录分享还在不在。
 */
export function findShareForDoc<T extends ShareTargetLike>(
  shares: readonly T[],
  absolutePath: string,
): { share: T; via: 'file' | 'dir' } | null {
  const target = canonical(absolutePath)
  if (!target) return null

  let viaDir: T | null = null
  for (const share of shares) {
    const root = canonical(share.path)
    if (!root) continue
    if (share.kind === 'file') {
      if (root === target) return { share, via: 'file' }
      continue
    }
    /*
     * 目录分享：`root` 必须真的是**路径段前缀**。
     * 直接 `startsWith` 会把 `/docs/guide-2` 当成 `/docs/guide` 的子目录——
     * 少一个分隔符就是一个跨目录的误判，而且会给出「已分享」的错误结论。
     */
    if (target === root || target.startsWith(`${root}/`)) {
      // 多个祖先目录同时被分享时取最深的那个：它是用户最近一次针对这片内容分享的
      viaDir ??= share
    }
  }
  return viaDir ? { share: viaDir, via: 'dir' } : null
}
