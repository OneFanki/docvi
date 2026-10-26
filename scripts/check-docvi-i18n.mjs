#!/usr/bin/env node
/**
 * docvi i18n 门禁：键集合两侧必须完全一致，且模板里用到的键必须存在。
 *
 * 为什么不是「统计词条数」：真正会坏的是三类漂移——
 *  1. zh 有、en 没有（英文界面露出中文或直接显示 key）；
 *  2. en 有、zh 没有（中文界面显示 key）；
 *  3. 模板里写了 `t('foo.bar')`，词典里没这个 key（运行期显示 key，用户可见）。
 * 三类都能在静态阶段查出来，不需要跑界面。
 *
 * 用法：node scripts/check-docvi-i18n.mjs
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const RENDERER = join(ROOT, 'apps/desktop/src/renderer/src')
const DICT_FILE = join(RENDERER, 'lib/i18n.ts')

const problems = []

/** 从 i18n.ts 里抓出 zh / en 两个对象的所有 key */
function dictionaryKeys() {
  const source = readFileSync(DICT_FILE, 'utf8')
  const zhStart = source.indexOf('const zh: Dict = {')
  const enStart = source.indexOf('const en: Dict = {')
  if (zhStart < 0 || enStart < 0) {
    problems.push('i18n.ts 中找不到 zh / en 词典声明')
    return { zh: new Set(), en: new Set() }
  }
  const zhBlock = source.slice(zhStart, source.indexOf('\n}', zhStart))
  const enBlock = source.slice(enStart, source.indexOf('\n}', enStart))
  const extract = block => new Set([...block.matchAll(/^\s*'([^']+)':/gm)].map(match => match[1]))
  return { zh: extract(zhBlock), en: extract(enBlock) }
}

/** 递归收集渲染层源码文件 */
function collect(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'out'].includes(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) collect(full, out)
    else if (/\.(ts|vue)$/.test(entry.name) && full !== DICT_FILE) out.push(full)
  }
  return out
}

/** 模板/脚本里出现的 t('xxx') 调用 */
function usedKeys(file) {
  const source = readFileSync(file, 'utf8')
  return [...source.matchAll(/\bt\(\s*'([a-zA-Z][\w.-]*)'/g)].map(match => match[1])
}

const { zh, en } = dictionaryKeys()

for (const key of zh) {
  if (!en.has(key)) problems.push(`en 缺少词条：${key}`)
}
for (const key of en) {
  if (!zh.has(key)) problems.push(`zh 缺少词条：${key}`)
}

const files = collect(RENDERER)
const used = new Map()
for (const file of files) {
  for (const key of usedKeys(file)) {
    if (!used.has(key)) used.set(key, [])
    used.get(key).push(relative(ROOT, file).replaceAll('\\', '/'))
  }
}

for (const [key, where] of used) {
  if (!zh.has(key)) problems.push(`模板引用了不存在的键「${key}」（${where[0]}）`)
}

/** 未被任何模板引用的词条：可能是遗留，也可能是留给下一步 —— 只提示不失败 */
const unused = [...zh].filter(key => !used.has(key))

if (problems.length) {
  console.error(`[docvi-i18n] 发现 ${problems.length} 个问题：`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

console.log(`[docvi-i18n] 通过：${zh.size} 条词条，zh/en 键集合一致，${used.size} 个键被模板引用`)
if (unused.length) {
  console.log(
    `[docvi-i18n] 提示：${unused.length} 条词条暂未被引用（${unused.slice(0, 6).join('、')}${unused.length > 6 ? ' …' : ''}）`,
  )
}
