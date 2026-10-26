import type { LocalPreviewFile, TreeNode } from '@docvi/shared'

/**
 * 本地预览的路径与目录树处理（纯函数，容器读者面专用）。
 *
 * 为什么单独成文件：浏览器选目录时拿到的是 `webkitRelativePath`（如
 * `我的笔记/指南/intro.md`），选散文件时只有文件名——两种形态都要收敛成
 * 「内容根内相对路径」，否则树、路由、最近打开会各按各的规则拼，互相认不出。
 * 这里全部按纯函数写，便于直接单测（不需要 DOM 与 localStorage）。
 */

/** 规范化：反斜杠统一成 `/`，去掉前导 `./` 与 `/`，丢弃空段与 `.` */
export function normalizeLocalPath(raw: string): string {
  return raw
    .replace(/\\/g, '/')
    .split('/')
    .filter(segment => segment && segment !== '.')
    .join('/')
}

/**
 * 目录模式：剥掉共同的第一段（webkitdirectory 的根目录名）。
 *
 * 返回 `rootName` 作为工作区显示名，`files` 里的路径变成内容根内相对路径。
 * 若所有文件都在根层（没有共同目录），rootName 为 null、路径保持原样——
 * 这时「根」就是用户选的这一批文件本身。
 */
export function stripCommonRoot(files: LocalPreviewFile[]): {
  rootName: string | null
  files: LocalPreviewFile[]
} {
  const normalized = files.map(file => ({
    path: normalizeLocalPath(file.path),
    text: file.text,
  }))
  const first = normalized[0]?.path
  if (!first || !first.includes('/')) return { rootName: null, files: normalized }
  const root = first.slice(0, first.indexOf('/'))
  const allShareRoot = normalized.every(file => file.path.startsWith(`${root}/`))
  if (!allShareRoot) return { rootName: null, files: normalized }
  return {
    rootName: root,
    files: normalized.map(file => ({ path: file.path.slice(root.length + 1), text: file.text })),
  }
}

/**
 * 文件列表 → 目录树。
 *
 * 排序与站点目录树同口径（中文 locale、数字前缀自然序）：读者在两种来源之间
 * 切换时，同一批文件不该换个顺序。
 */
export function buildLocalTree(files: LocalPreviewFile[]): TreeNode[] {
  const roots: TreeNode[] = []

  const dirAt = (list: TreeNode[], path: string, name: string): TreeNode => {
    const found = list.find(node => node.type === 'dir' && node.path === path)
    if (found) return found
    const created: TreeNode = { path, name, type: 'dir', children: [] }
    list.push(created)
    return created
  }

  for (const file of files) {
    const segments = normalizeLocalPath(file.path).split('/').filter(Boolean)
    const name = segments.pop()
    if (!name) continue
    let level = roots
    let walked = ''
    for (const segment of segments) {
      walked = walked ? `${walked}/${segment}` : segment
      const dir = dirAt(level, walked, segment)
      level = dir.children ?? []
    }
    level.push({ path: normalizeLocalPath(file.path), name, type: 'doc' })
  }

  const sort = (list: TreeNode[]): void => {
    list.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
      return a.name.localeCompare(b.name, 'zh-CN', { numeric: true })
    })
    for (const node of list) if (node.children) sort(node.children)
  }
  sort(roots)
  return roots
}

/** 树里第一篇文档（落地页缺失时的兜底） */
export function firstDocPath(nodes: TreeNode[]): string | null {
  for (const node of nodes) {
    if (node.type === 'doc') return node.path
    if (node.children) {
      const hit = firstDocPath(node.children)
      if (hit) return hit
    }
  }
  return null
}
