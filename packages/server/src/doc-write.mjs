/**
 * 文档写入（MCP write_doc 的实现层，桌面服务进程调用）。
 *
 * 三种模式，语义刻意保守：
 *   create    只新建。目标已存在直接拒绝——静默覆盖用户手写的文档是本功能最坏的失败形态。
 *   overwrite 整篇替换，**必须**带 baseMtime（`read_doc` 返回的那个值）。mtime 对不上就
 *             拒绝并告知重新读取——与编辑器保存走同一套冲突判定，语义只有一份。
 *   append    追加到末尾；文件不存在则拒绝（追加到不存在的文件通常是路径写错了）。
 *
 * 不提供删除：删文档的破坏力远超写，这个口子不开。
 *
 * 上限 1MB 与语料层的读取上限对齐——写出去却读不回来的文件等于丢失。
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'

import { atomicWriteText } from './fs-atomic.mjs'
import { validateDocRelativePath } from './doc-paths.mjs'

/** 单篇写入上限：与 corpus 的 MAX_DOC_BYTES 一致 */
export const DOC_WRITE_MAX_BYTES = 1024 * 1024

/** mtime 比较容差（FAT 2 秒、ext4 纳秒；与编辑器保存同一个 1ms 口径） */
const MTIME_TOLERANCE_MS = 1

/** 支持的写入模式（顺序即文档顺序） */
export const WRITE_MODES = ['create', 'overwrite', 'append']

function fail(code, message) {
  return Object.assign(new Error(message), { code })
}

function statOrNull(abs) {
  try {
    const stat = statSync(abs)
    return stat.isFile() ? { mtimeMs: stat.mtimeMs, size: stat.size } : null
  } catch {
    return null
  }
}

/**
 * 目标经 realpath 解析后必须落在工作区根内。
 *
 * `validateDocRelativePath` 只保证**字面**路径不越界，挡不住工作区里预先存在的
 * 符号链接 / 目录联接：`link -> C:\Windows` 时 `link/x.md` 字面完全合法，写下去
 * 却落到根外面。这与临时分享「解析后必须 realpath 再做共享根判定」是同一条纪律。
 *
 * 目标可能还不存在（create 会自动建父目录），所以取**最深的已存在节点**做判定：
 * 已存在的目标直接 realpath 它本身（连 `link.md -> 根外` 这种文件级链接也一并挡住，
 * 否则 append 会把根外文件的内容读进来），不存在时退到最近一级已存在的祖先目录——
 * 递归建目录时符号链接只可能出现在这一段里。
 */
function assertTargetInsideRoot(root, abs) {
  let rootReal
  try {
    rootReal = realpathSync(root)
  } catch {
    throw fail('E_IO', `工作区根不可访问：${root}`)
  }

  let probe = abs
  // 向上找到第一个存在的节点（待创建的目标与其父目录都可能不存在）
  while (!existsSync(probe)) {
    const parent = dirname(probe)
    if (parent === probe) break
    probe = parent
  }

  let probeReal
  try {
    probeReal = realpathSync(probe)
  } catch {
    throw fail('E_IO', `目标路径不可解析：${probe}`)
  }

  const prefix = rootReal.endsWith(sep) ? rootReal : `${rootReal}${sep}`
  if (probeReal !== rootReal && !probeReal.startsWith(prefix)) {
    throw fail('E_INVALID', '目标路径经符号链接解析后落在工作区之外，已拒绝写入')
  }
}

/**
 * 写一篇文档。失败抛带 `code` 的错误（E_INVALID / E_EXISTS / E_NOT_FOUND /
 * E_CONFLICT / E_TOO_LARGE / E_IO），由调用方转成可读说明。
 *
 * @param {{ root: string, relPath: string, text: string, mode?: string, baseMtime?: number }} input
 * @returns {{ status: 'created'|'updated'|'appended', relPath: string, mtime: number, size: number, bytes: number }}
 */
export function writeDocText(input) {
  const { root, text } = input
  if (typeof root !== 'string' || !root) throw fail('E_INVALID', '缺少工作区根目录')
  if (typeof text !== 'string') throw fail('E_INVALID', 'text 必须是字符串')

  const mode = input.mode ?? 'create'
  if (!WRITE_MODES.includes(mode)) {
    throw fail('E_INVALID', `mode 只能是 ${WRITE_MODES.join(' / ')}`)
  }

  const relPath = validateDocRelativePath(input.relPath)
  const abs = join(root, ...relPath.split('/'))
  assertTargetInsideRoot(root, abs)
  const before = statOrNull(abs)

  if (mode === 'create' && before) {
    throw fail('E_EXISTS', `文档已存在：${relPath}（改内容请用 mode=overwrite 并带 baseMtime）`)
  }
  if (mode === 'append' && !before) {
    throw fail('E_NOT_FOUND', `文档不存在，无法追加：${relPath}（新建请用 mode=create）`)
  }
  if (mode === 'overwrite' && !before) {
    throw fail('E_NOT_FOUND', `文档不存在，无法覆盖：${relPath}（新建请用 mode=create）`)
  }
  if (mode === 'overwrite') {
    const base = input.baseMtime
    if (typeof base !== 'number' || !Number.isFinite(base)) {
      throw fail('E_INVALID', 'overwrite 必须带 baseMtime（先用 read_doc 取当前 mtime）')
    }
    if (Math.abs(before.mtimeMs - base) > MTIME_TOLERANCE_MS) {
      throw fail(
        'E_CONFLICT',
        `文档已被修改（磁盘 mtime ${before.mtimeMs}，提交的 baseMtime ${base}）——先重新 read_doc 再写`,
      )
    }
  }

  // append 读既有内容：此时文件一定存在（上面已判空）
  const previous = mode === 'append' ? readExisting(abs) : ''
  const finalText = mode === 'append' ? `${previous}${text}` : text

  const bytes = Buffer.byteLength(finalText, 'utf8')
  if (bytes > DOC_WRITE_MAX_BYTES) {
    throw fail(
      'E_TOO_LARGE',
      `写入后超过 ${DOC_WRITE_MAX_BYTES / 1024 / 1024}MB 上限（当前 ${bytes} 字节）`,
    )
  }

  atomicWriteText(abs, finalText)

  const after = statOrNull(abs)
  if (!after) throw fail('E_IO', '写入后无法读取文件状态')
  return {
    status: mode === 'create' ? 'created' : mode === 'append' ? 'appended' : 'updated',
    relPath,
    mtime: after.mtimeMs,
    size: after.size,
    bytes,
  }
}

/** 追加模式读取既有内容 */
function readExisting(abs) {
  try {
    return readFileSync(abs, 'utf8')
  } catch {
    throw fail('E_IO', '追加模式无法读取现有内容')
  }
}
