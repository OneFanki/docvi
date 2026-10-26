import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, sep } from 'node:path'

import type { FsEntryKind } from '@docvi/shared'

import { resolveInside } from './content.ts'

/**
 * 工作区内的文件操作。
 *
 * 三条硬约束：
 *  1. **只收相对路径**：所有入口都先过 `resolveInside`（拒绝绝对路径、`..`、
 *     符号链接逃逸）。渲染进程拿不到任意写权限，这是唯一的边界。
 *  2. **不覆盖已有内容**：重命名 / 移动碰到同名一律报错，绝不静默覆盖——
 *     覆盖掉的是用户手写的文档，不是缓存。复制是例外：它是「再来一份」，
 *     重名自动加序号，不该因此失败。
 *  3. **删除走回收站**：见 `resolveForTrash`，由 ipc 层用 Electron 的
 *     `shell.trashItem` 执行。这里不做永久删除的兜底——「删了还能捞回来」
 *     是这个操作能被放心使用的唯一前提。
 */

/** 新建文档的初始骨架：有 H1 才让树里有标题可显示 */
function docScaffold(name: string): string {
  const title = name.replace(/\.md$/i, '').trim() || '未命名'
  return `# ${title}\n\n`
}

/** 文件名合法性：不含分隔符与控制字符，不以点开头（隐藏文件不进树） */
function assertName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) throw Object.assign(new Error('名字不能为空'), { code: 'E_INVALID' as const })
  if (/[/\\]/.test(trimmed)) {
    throw Object.assign(new Error('名字里不能有路径分隔符'), { code: 'E_INVALID' as const })
  }
  if (/[<>:"|?*\0]/.test(trimmed)) {
    throw Object.assign(new Error('名字包含非法字符'), { code: 'E_INVALID' as const })
  }
  if (trimmed.startsWith('.')) {
    throw Object.assign(new Error('名字不能以点开头'), { code: 'E_INVALID' as const })
  }
  if (trimmed === '.' || trimmed === '..') {
    throw Object.assign(new Error('名字非法'), { code: 'E_INVALID' as const })
  }
  return trimmed
}

/** 目标目录：相对路径解析到内容根内，并确认它确实是个目录 */
function requireDir(root: string, relPath: string): string {
  const abs = relPath ? resolveInside(root, relPath) : root
  const stat = statSync(abs)
  if (!stat.isDirectory()) {
    throw Object.assign(new Error('目标不是目录'), { code: 'E_INVALID' as const })
  }
  return abs
}

function toRel(root: string, abs: string): string {
  return abs
    .slice(root.length)
    .replace(/^[/\\]/, '')
    .replaceAll('\\', '/')
}

/** abs 是否等于 parent 或在其之内（目录移动/复制的自包含判定） */
function isInside(abs: string, parent: string): boolean {
  return abs === parent || abs.startsWith(`${parent}${sep}`)
}

/**
 * 建一个不撞名的路径：`名字.md` → `名字 2.md` → `名字 3.md`…
 *
 * 只在同名时才加序号：复制一份到空目录应当保持原名。
 */
function uniquePath(absDir: string, name: string): string {
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  let candidate = join(absDir, name)
  let n = 2
  while (existsSync(candidate)) {
    candidate = join(absDir, `${stem} ${n}${ext}`)
    n += 1
  }
  return candidate
}

export interface FsOpContext {
  /** 内容根绝对路径 */
  root: string
}

export function createEntry(
  ctx: FsOpContext,
  dirRelPath: string,
  rawName: string,
  kind: FsEntryKind,
): string {
  const dirAbs = requireDir(ctx.root, dirRelPath)
  let name = assertName(rawName)
  if (kind === 'file' && !/\.(md|markdown)$/i.test(name)) name = `${name}.md`

  const target = join(dirAbs, name)
  if (existsSync(target)) {
    throw Object.assign(new Error(kind === 'dir' ? '已存在同名目录' : '已存在同名文件'), {
      code: 'E_EXISTS' as const,
    })
  }

  if (kind === 'dir') {
    mkdirSync(target)
  } else {
    // 独占创建：'wx' 在文件已存在时抛错，避免检查与写入之间的竞态
    writeFileSync(target, docScaffold(name), { encoding: 'utf8', flag: 'wx' })
  }
  return toRel(ctx.root, target)
}

/** 就地改名：只换最后一段，不允许借此跨目录 */
export function renameEntry(ctx: FsOpContext, relPath: string, rawName: string): string {
  const abs = resolveInside(ctx.root, relPath)
  const name = assertName(rawName)
  const target = join(dirname(abs), name)
  if (target === abs) return relPath
  if (existsSync(target)) {
    throw Object.assign(new Error('目标位置已有同名条目'), { code: 'E_EXISTS' as const })
  }
  renameSync(abs, target)
  return toRel(ctx.root, target)
}

/** 移动到另一目录；同目录移动是无操作 */
export function moveEntry(ctx: FsOpContext, relPath: string, targetDir: string): string {
  const abs = resolveInside(ctx.root, relPath)
  const dirAbs = requireDir(ctx.root, targetDir)
  if (dirname(abs) === dirAbs) return relPath

  // 目录移进自己的子孙会把整棵树弄丢
  if (statSync(abs).isDirectory() && isInside(dirAbs, abs)) {
    throw Object.assign(new Error('不能把目录移动到它自己里面'), { code: 'E_INVALID' as const })
  }

  const target = join(dirAbs, basename(abs))
  if (existsSync(target)) {
    throw Object.assign(new Error('目标目录已有同名条目'), { code: 'E_EXISTS' as const })
  }
  renameSync(abs, target)
  return toRel(ctx.root, target)
}

/** 递归复制到另一目录；重名自动加序号 */
export function copyEntry(ctx: FsOpContext, relPath: string, targetDir: string): string {
  const abs = resolveInside(ctx.root, relPath)
  const dirAbs = requireDir(ctx.root, targetDir)
  if (statSync(abs).isDirectory() && isInside(dirAbs, abs)) {
    throw Object.assign(new Error('不能把目录复制到它自己里面'), { code: 'E_INVALID' as const })
  }

  const target = uniquePath(dirAbs, basename(abs))
  copyRecursive(abs, target)
  return toRel(ctx.root, target)
}

function copyRecursive(from: string, to: string): void {
  if (statSync(from).isDirectory()) {
    mkdirSync(to)
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      // 跳过点开头目录与 node_modules：复制整个文档目录时不该把 .git 一起搬
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      copyRecursive(join(from, entry.name), join(to, entry.name))
    }
    return
  }
  copyFileSync(from, to)
}

/**
 * 校验并交出待删除条目的绝对路径。
 *
 * 真正送进系统回收站要用 Electron 的 `shell.trashItem`（异步、只能主进程调），
 * 所以入口放在 ipc 层：这里只负责校验，让本模块不依赖 Electron。
 */
export function resolveForTrash(
  ctx: FsOpContext,
  relPath: string,
): { abs: string; relPath: string } {
  if (!relPath) {
    throw Object.assign(new Error('不能删除工作区根'), { code: 'E_INVALID' as const })
  }
  const abs = resolveInside(ctx.root, relPath)
  return { abs, relPath: toRel(ctx.root, abs) }
}

/** 回收站不可用时（无桌面环境）才走，永久删除 */
export function hardDelete(abs: string): void {
  if (statSync(abs).isDirectory()) {
    rmSync(abs, { recursive: true, force: true })
    return
  }
  unlinkSync(abs)
}
