import type { TreeNode } from '@docvi/shared'

/**
 * 目录树的选区、拖拽与展开纯逻辑。
 *
 * 抽出来是为了能脱离 DOM 单测：Shift 范围、拖拽落点过滤、「展开所选」要
 * 收集哪些路径，正确性全藏在路径算术里，写在组件里只能手测。路径一律是
 * 相对内容根的 POSIX 路径（TreeNode.path 的口径），顶层目录用空串表示。
 */

/**
 * 树内拖拽的自定义 MIME。shell 的外部文件拖放（拖 .md 进窗口打开）按
 * dataTransfer 里有没有它区分：树内移动不许被当成「打开外部文件」。
 */
export const TREE_DND_TYPE = 'application/x-docvi-tree'

/** 这次拖拽是不是树内移动（外部文件拖入的 dataTransfer 是 Files，不含它） */
export function isTreeDrag(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes(TREE_DND_TYPE) ?? false
}

/** 相对路径的父目录（`a/b/c` → `a/b`；顶层 → 空串） */
export function parentDirOf(relPath: string): string {
  const slash = relPath.lastIndexOf('/')
  return slash < 0 ? '' : relPath.slice(0, slash)
}

/** 路径最后一段（用于把相对路径还原成名字） */
export function baseNameOf(relPath: string): string {
  const slash = relPath.lastIndexOf('/')
  return slash < 0 ? relPath : relPath.slice(slash + 1)
}

/** 从根到该路径的祖先目录链（不含自身），`a/b/c` → ['', 'a', 'a/b'] */
export function ancestorDirs(relPath: string): string[] {
  const chain: string[] = []
  let dir = parentDirOf(relPath)
  while (dir) {
    chain.unshift(dir)
    dir = parentDirOf(dir)
  }
  return ['', ...chain]
}

/**
 * Shift 范围选择：锚点与当前行之间（含两端）的可见路径。
 *
 * 锚点不在可见序列里（树刷新后被清、或从没点过）时，退化为只选当前行——
 * 范围选择没有起点就无从谈起，宁可选得少也不选错。
 */
export function rangeSelection(
  visiblePaths: string[],
  anchor: string | null,
  current: string,
): string[] {
  const from = anchor ? visiblePaths.indexOf(anchor) : -1
  const to = visiblePaths.indexOf(current)
  if (from < 0 || to < 0) return [current]
  const [lo, hi] = from < to ? [from, to] : [to, from]
  return visiblePaths.slice(lo, hi + 1)
}

/**
 * 批量移动前剔除无效项，返回真正要移动的路径。
 *
 * 三类剔除，全是「静默跳过」而不是报错——它们不是失败，是用户意图里本来
 * 就不存在的移动：
 *  1. 拖回当前所在目录 / 拖到目录自己身上（同目录移动是无操作）；
 *  2. 目录拖进自己的子孙（主进程 moveEntry 会拒绝，多项拖拽里一项被拒
 *     不该中断整批，直接不发出去）；
 *  3. 被同批祖先项包含的项（父目录移动时会带走它们，按旧路径再移一次
 *     必然 ENOENT——只移最顶层项）。
 */
export function filterMoveTargets(
  paths: string[],
  targetDir: string,
): { move: string[]; skipped: number } {
  const move: string[] = []
  let skipped = 0
  for (const path of paths) {
    const parent = parentDirOf(path)
    if (parent === targetDir || targetDir === path || targetDir.startsWith(`${path}/`)) {
      skipped += 1
      continue
    }
    const contained = paths.some(
      other => other !== path && (path === other || path.startsWith(`${other}/`)),
    )
    if (!contained) move.push(path)
  }
  return { move, skipped }
}

/**
 * 「展开所选」要加入展开集合的目录路径。
 *
 * 对每个选中节点：它的祖先链（不展开祖先，铺开的子树看不见）+ 它目录子树
 * 里的所有目录（只铺自身一层，深层还得逐层点，就没有「所选全展开」的意义）。
 * 落地页目录的 landing 是文档路径、不在树节点表里，靠祖先链覆盖。
 */
export function collectExpandPaths(nodes: TreeNode[], selected: string[]): string[] {
  const result = new Set<string>()
  const find = (list: TreeNode[], target: string): TreeNode | null => {
    for (const node of list) {
      if (node.path === target) return node
      const hit = find(node.children ?? [], target)
      if (hit) return hit
    }
    return null
  }
  const collectDirs = (list: TreeNode[]): void => {
    for (const node of list) {
      if (node.type !== 'dir') continue
      result.add(node.path)
      collectDirs(node.children ?? [])
    }
  }
  for (const path of selected) {
    for (const dir of ancestorDirs(path)) {
      // 空串是工作区根本身，不是可展开的树节点（顶层行没有 path='' 的目录）
      if (dir) result.add(dir)
    }
    const node = find(nodes, path)
    if (node?.type === 'dir') {
      result.add(node.path)
      collectDirs(node.children ?? [])
    }
  }
  return [...result]
}
