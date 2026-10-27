/**
 * 从 CHANGELOG.md 抽取某个版本的说明，供发版工作流当 Release 正文用。
 *
 *   node scripts/release-notes.mjs 0.2.2 notes.md
 *   node scripts/release-notes.mjs 0.2.2 -        # 写 stdout
 *
 * 抽不到小节时**非零退出**：没有写说明的版本不该被发出去，这正是这个脚本存在的
 * 理由。调用方（工作流）据此直接失败，而不是发出一个只有一串提交标题的 Release。
 *
 * 为什么单独成为一个脚本而不是内联在 workflow 里：这段匹配逻辑要能被单测覆盖。
 * 版本号是 `0.2.2` 这种带点的字符串，写成宽泛的正则会误匹配 `0.2.20`、
 * 或跨过 `## [0.2.2]` 去匹配正文里提到的版本号——发错正文比发不出去更糟。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 正则元字符转义：版本号里的 `.` 必须按字面量匹配 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 取 `## [<version>]` 这一节的正文（不含标题），到下一个 `## [` 为止。
 *
 * 标题允许带日期（`## [0.2.2] - 2026-10-27`）。找不到或正文为空时返回
 * undefined——两者都算「没写说明」，调用方一视同仁地拒绝发版。
 */
export function extractReleaseNotes(markdown, version) {
  if (!version) return undefined
  /*
   * 锚定行首且精确到版本号：0.2 不能匹配 0.2.0，也不能匹配 0.2.21。
   *
   * ⚠️ 日期段与行尾只能用**水平空白** `[ \t]`，不能用 `\s`：`\s` 会跨过换行，
   * 于是 `## [0.4.0]` 后面紧跟的第一个列表项会被当成「日期」吃掉，正文变空、
   * 整个版本被判为「没写说明」。带日期的标题恰好不会触发（`-` 在前面先匹配了），
   * 所以这个坑只会在「标题不写日期」时静默出现。
   */
  const heading = new RegExp(
    `^## \\[${escapeRegExp(version)}\\](?:[ \\t]+-[ \\t]+[^\\n]*)?[ \\t]*$`,
    'm',
  )
  const match = heading.exec(markdown)
  if (!match) return undefined

  const rest = markdown.slice(match.index + match[0].length)
  const next = /^## \[/m.exec(rest)
  const body = (next ? rest.slice(0, next.index) : rest).trim()
  return body.length > 0 ? body : undefined
}

/** 是否被直接执行（被 import 时不应该跑 CLI 逻辑） */
const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  const [, , version, outArg] = process.argv
  if (!version) {
    console.error('用法：node scripts/release-notes.mjs <版本号> [输出文件|-]')
    process.exit(2)
  }
  const changelog = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'CHANGELOG.md')
  const notes = extractReleaseNotes(readFileSync(changelog, 'utf8'), version)
  if (!notes) {
    console.error(`CHANGELOG.md 里没有 ${version} 的小节。先补「## [${version}] - <日期>」。`)
    process.exit(1)
  }
  if (outArg && outArg !== '-') {
    writeFileSync(outArg, `${notes}\n`)
  } else {
    process.stdout.write(`${notes}\n`)
  }
}
