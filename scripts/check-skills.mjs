#!/usr/bin/env node
/**
 * skill 治理校验：让「治理规则」变成可执行的检查。
 *
 * 检查项（任一失败即退出 1）：
 *  1. frontmatter 只含 name + description 两字段
 *  2. name 与目录名一致且为小写 kebab-case
 *  3. description ≤ 80 字符，且不以句号以外的结论式描述堆叠（只做长度与存在性硬校验）
 *  4. 每个 skill 目录都有 SKILL.md；每个 SKILL.md 都在 SKILLS-INDEX.md 里登记
 *  5. SKILLS-INDEX.md 登记的路径真实存在（防改名后漏改）
 *
 * 用法：node scripts/check-skills.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SKILLS_DIR = path.join(repoRoot, '.agents', 'skills')
const INDEX_FILE = path.join(repoRoot, 'SKILLS-INDEX.md')
const DESCRIPTION_MAX = 80
const NAME_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/

const problems = []

/** 解析 SKILL.md 的 frontmatter（只支持本仓用到的两字段形态） */
function parseFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!match) return null
  const fields = {}
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim()) continue
    const idx = line.indexOf(':')
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim()
    fields[key] = value
  }
  return fields
}

if (!fs.existsSync(SKILLS_DIR)) {
  console.error('check-skills 失败：.agents/skills/ 不存在')
  process.exit(1)
}

const dirs = fs
  .readdirSync(SKILLS_DIR, { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => entry.name)
  .sort()

const indexText = fs.existsSync(INDEX_FILE) ? fs.readFileSync(INDEX_FILE, 'utf8') : ''

for (const dir of dirs) {
  const skillFile = path.join(SKILLS_DIR, dir, 'SKILL.md')
  if (!fs.existsSync(skillFile)) {
    problems.push(`${dir}: 缺少 SKILL.md`)
    continue
  }
  const text = fs.readFileSync(skillFile, 'utf8')
  const fields = parseFrontmatter(text)
  if (!fields) {
    problems.push(`${dir}: 缺少 frontmatter`)
    continue
  }

  const keys = Object.keys(fields)
  const extra = keys.filter(key => key !== 'name' && key !== 'description')
  if (extra.length)
    problems.push(`${dir}: frontmatter 只允许 name / description，多出 ${extra.join(', ')}`)

  if (!fields.name) {
    problems.push(`${dir}: frontmatter 缺 name`)
  } else {
    if (fields.name !== dir) problems.push(`${dir}: name「${fields.name}」与目录名不一致`)
    if (!NAME_RE.test(fields.name)) problems.push(`${dir}: name 必须是小写 kebab-case`)
  }

  if (!fields.description) {
    problems.push(`${dir}: frontmatter 缺 description`)
  } else {
    const length = [...fields.description].length
    if (length > DESCRIPTION_MAX) {
      problems.push(`${dir}: description ${length} 字符，超过 ${DESCRIPTION_MAX} 上限`)
    }
  }

  if (!indexText.includes(`.agents/skills/${dir}/`)) {
    problems.push(`${dir}: 未在 SKILLS-INDEX.md 登记`)
  }
}

// 索引里登记的路径必须真实存在（防改名后漏改）
const refRe = /`\.agents\/skills\/([^/]+)\/`/g
let match
while ((match = refRe.exec(indexText)) !== null) {
  const name = match[1]
  if (!fs.existsSync(path.join(SKILLS_DIR, name, 'SKILL.md'))) {
    problems.push(`SKILLS-INDEX.md 登记的 ${name} 不存在`)
  }
}

if (problems.length > 0) {
  console.error(`\ncheck-skills 失败，共 ${problems.length} 处：`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log(`check-skills 通过：${dirs.length} 个 skill，frontmatter 与索引一致`)
