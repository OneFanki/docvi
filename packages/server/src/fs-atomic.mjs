/**
 * 文本文件的原子写（桌面编辑保存与 MCP 写文档共用）。
 *
 * 为什么必须原子：直接 `writeFile` 覆盖，中途崩溃或断电会留下半截文件——
 * 用户手写的文档变成一堆残字，比写失败严重得多。临时文件 + `rename` 在同一
 * 文件系统上是原子的：要么是完整的新内容，要么还是完整的旧内容。
 *
 * 为什么 rename 之前要 `fsync`：POSIX 只保证「目录项替换」原子，不保证数据
 * 已落盘。不 fsync 时断电可能 rename 成功但文件是空的。
 *
 * Windows 上 `rename` 覆盖已存在文件是允许的（与 POSIX 语义一致），不需要
 * 先 unlink——先删再改名会制造一个「文件不存在」的窗口，监视器与并发读都可能撞上。
 */
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'

/**
 * 原子写入文本。
 *
 * 父目录不存在时自动创建（MCP 写嵌套新文档时常见）；临时文件与目标同目录，
 * 否则跨文件系统的 rename 会退化成复制、失去原子性。
 *
 * @param {string} file 目标绝对路径
 * @param {string} text 完整内容（UTF-8）
 */
export function atomicWriteText(file, text) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = join(dirname(file), `.${randomUUID()}.docvi-tmp`)
  let fd = null
  try {
    fd = openSync(tmp, 'w')
    const buffer = Buffer.from(text, 'utf8')
    let written = 0
    while (written < buffer.length) {
      written += writeSync(fd, buffer, written, buffer.length - written)
    }
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    renameSync(tmp, file)
  } catch (error) {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        // 已在异常路径上，关闭失败不再掩盖原始错误
      }
    }
    try {
      unlinkSync(tmp)
    } catch {
      // 临时文件可能根本没建出来；清理失败不影响错误上报
    }
    throw error
  }
}
