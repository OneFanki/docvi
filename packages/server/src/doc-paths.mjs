/**
 * 文档路径规则（语料扫描与 MCP 写入共用一份）。
 *
 * 为什么必须共用：扫描器剔除的目录（node_modules、assets、点开头目录…）里的
 * 文件在树上根本不出现。若是写入侧另写一套规则，AI 就能把一个「写成功了、
 * 用户永远看不见」的文档写进去——这种不一致最难排查。
 */
import { isAbsolute } from 'node:path'

/** 扫描排除的目录名（与树、搜索索引口径一致） */
export const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  '.vitepress',
  'dist',
  '.idea',
  '.obsidian',
  'snippets',
  'assets',
])

/** 点开头一律排除（隐藏文件不进树）；点开头的**文件**是合法文档但同样不进树 */
export function isExcludedName(name) {
  return name.startsWith('.') || EXCLUDED_DIRS.has(name)
}

/** 允许写入的扩展名（小写比较） */
const DOC_EXTENSIONS = ['.md', '.markdown']

/**
 * 校验一个写入用的相对路径，返回规范化结果（POSIX 分隔、去掉 `./` 前缀）。
 *
 * 拒绝项与理由：
 *  - 绝对路径 / 盘符：写入目标必须相对工作区根，否则等于任意文件写权限；
 *  - `..` 段：跳出工作区根；
 *  - 非 .md：MCP 只写 Markdown，图片等二进制不在此工具职责内；
 *  - 点开头段 / 扫描排除目录：写进去用户在树上、搜索里都看不到；
 *  - 末段为空（`a/`）：那是目录不是文档。
 *
 * 抛出的错误带 `code: 'E_INVALID'`，由调用方转成可读说明。
 */
export function validateDocRelativePath(raw) {
  const fail = message => {
    throw Object.assign(new Error(message), { code: 'E_INVALID' })
  }
  if (typeof raw !== 'string' || !raw.trim()) fail('路径必须是非空字符串')

  const unified = raw.trim().replaceAll('\\', '/')
  if (isAbsolute(raw) || /^[A-Za-z]:/.test(unified))
    fail(`路径必须是相对工作区根的相对路径：${raw}`)

  const segments = unified.replace(/^\.\//, '').split('/')
  if (segments.some(segment => segment === '..')) fail(`路径不能包含 .. 段：${raw}`)
  const kept = segments.filter(segment => segment !== '' && segment !== '.')
  if (!kept.length) fail('路径不能为空')

  for (const segment of kept.slice(0, -1)) {
    if (isExcludedName(segment))
      fail(`路径不能位于被排除的目录中：${segment}（该目录不参与扫描，写进去看不见）`)
  }

  const name = kept[kept.length - 1]
  if (!name) fail('路径必须以文档文件名结尾')
  if (name.startsWith('.')) fail(`文件名不能以点开头：${name}`)
  const lower = name.toLowerCase()
  if (!DOC_EXTENSIONS.some(ext => lower.endsWith(ext))) {
    fail(`只允许写入 Markdown 文档（${DOC_EXTENSIONS.join(' / ')}）：${name}`)
  }
  if (/[<>:"|?*\0]/.test(name)) fail(`文件名包含非法字符：${name}`)

  return kept.join('/')
}
