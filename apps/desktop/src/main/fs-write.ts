import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { DraftPayload, WriteDocRequest, WriteDocResult } from '@docvi/shared'

import { atomicWriteText } from '../../../../packages/server/src/fs-atomic.mjs'

import { dataDir } from './paths.ts'

/**
 * 文档写入层。
 *
 * 三条硬约束：
 *  1. **原子写**：先写同目录临时文件再 rename。直接覆盖写在中途崩溃时会留下
 *     半截文件，rename 在同一文件系统上是原子的，要么旧要么新。
 *     实现复用 `packages/server/src/fs-atomic.mjs`——MCP 的 write_doc 走同一份，
 *     两处若各写一套，早晚会在 fsync / 临时文件命名上漂移。
 *  2. **冲突判定在写之前**：比较载入时的 mtime 与当前磁盘 mtime，不同就返回
 *     conflict，由渲染层让用户选「覆盖 / 放弃 / 看差异」——绝不静默覆盖别人的改动。
 *     这条判定与 MCP 的 overwrite 语义相同（同一个 1ms 容差口径）。
 *  3. **写入前 fsync**：由 atomicWriteText 内部完成（POSIX 上 rename 只保证
 *     目录项原子，不保证数据落盘）。
 */

const MAX_WRITE_BYTES = 20 * 1024 * 1024

function ioError(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: 'E_IO' })
}

function statOrNull(path: string): { mtimeMs: number; size: number } | null {
  try {
    const stat = statSync(path)
    return stat.isFile() ? { mtimeMs: stat.mtimeMs, size: stat.size } : null
  } catch {
    return null
  }
}

export function writeDoc(request: WriteDocRequest): WriteDocResult {
  const { absolutePath, text, baseMtime, force } = request
  if (text.length > MAX_WRITE_BYTES) {
    throw Object.assign(new Error('文档超过 20MB 上限'), { code: 'E_TOO_LARGE' })
  }

  const before = statOrNull(absolutePath)
  if (!before) {
    throw Object.assign(new Error('文件不存在'), { code: 'E_NOT_FOUND' })
  }

  // mtime 精度在不同文件系统上差异很大（FAT 2 秒、ext4 纳秒），
  // 用 1ms 容差比较，避免「刚保存完再保存」被误判为冲突
  if (!force && Math.abs(before.mtimeMs - baseMtime) > 1) {
    return { status: 'conflict', mtime: before.mtimeMs, size: before.size }
  }

  try {
    atomicWriteText(absolutePath, text)
  } catch (error) {
    throw ioError(error instanceof Error ? error.message : '写入失败')
  }

  const after = statOrNull(absolutePath)
  if (!after) throw ioError('写入后无法读取文件状态')
  return { status: 'saved', mtime: after.mtimeMs, size: after.size }
}

/* ---------- 草稿 ---------- */

/**
 * 草稿路径：数据目录 drafts/ 下按绝对路径的哈希命名。
 *
 * 用哈希而不是把路径编进文件名：Windows 路径含 `:` 与 `\`，直接拼会把目录结构
 * 带进 drafts/，且长路径容易超文件名上限。
 */
function draftPath(absolutePath: string): string {
  let hash = 5381
  const normalized = absolutePath.replaceAll('\\', '/').toLowerCase()
  for (let i = 0; i < normalized.length; i += 1) {
    hash = ((hash << 5) + hash + normalized.charCodeAt(i)) | 0
  }
  return join(dataDir(), 'drafts', `${(hash >>> 0).toString(16)}-${normalized.length}.json`)
}

export function readDraft(absolutePath: string): DraftPayload | null {
  const file = draftPath(absolutePath)
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<DraftPayload> & {
      path?: string
    }
    // 哈希可能碰撞：确认草稿属于同一个文件，否则丢弃
    if (parsed.path !== absolutePath || typeof parsed.text !== 'string') return null
    return { text: parsed.text, updatedAt: Number(parsed.updatedAt) || 0 }
  } catch {
    return null
  }
}

export function writeDraft(absolutePath: string, text: string): void {
  const file = draftPath(absolutePath)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ path: absolutePath, text, updatedAt: Date.now() }), 'utf8')
}

export function clearDraft(absolutePath: string): void {
  const file = draftPath(absolutePath)
  try {
    if (existsSync(file)) unlinkSync(file)
  } catch {
    // 草稿清理失败不阻塞保存流程
  }
}
