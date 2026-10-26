#!/usr/bin/env node
/**
 * 文档链接与 AGENTS.md 体量校验（无第三方依赖）
 *
 * 检查项：
 *  1. docs/ 与根 AGENTS.md / SKILLS-INDEX.md 的 markdown 相对链接是否指向存在的文件
 *     （docs/archive/ 归档区只读，不参与校验）
 *  2. AGENTS.md / SKILLS-INDEX.md 中反引号包裹的仓库相对路径是否存在
 *     （含 `<...>` / `*` 占位符的视为模板跳过；`file:` 与 `/` 开头绝对路径跳过）
 *  3. AGENTS.md 体量：>15KB 警告，>20KB 失败
 *
 * 用法：node scripts/check-docs.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const AGENTS_SOFT_LIMIT = 15 * 1024
const AGENTS_HARD_LIMIT = 20 * 1024
const ROOT_FILES = ['AGENTS.md', 'SKILLS-INDEX.md']

function walkMd(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      // archive 只读历史；node_modules 与生成产物不扫
      if (['node_modules', 'archive', 'dist', 'dist-app', 'dist-viewer'].includes(entry.name)) {
        continue
      }
      walkMd(full, out)
    } else if (entry.name.toLowerCase().endsWith('.md')) {
      out.push(full)
    }
  }
  return out
}

function stripCodeBlocks(text) {
  return text.replace(/```[\s\S]*?```/g, '').replace(/~~~[\s\S]*?~~~/g, '')
}

function decode(target) {
  try {
    return decodeURIComponent(target)
  } catch {
    return target
  }
}

const problems = []

function checkLinks(file, content) {
  const text = stripCodeBlocks(content)
  const linkRe = /\[[^\]]*\]\(([^)\s]+)\)/g
  let match
  while ((match = linkRe.exec(text)) !== null) {
    const raw = match[1]
    if (/^(https?:|file:|mailto:|#)/.test(raw) || raw.startsWith('/')) continue
    const target = decode(raw.split('#')[0])
    if (!target) continue
    // 只校验像路径的：含分隔符或带扩展名；[uuid](uuid) 这类伪链接跳过
    if (!/[\\/.]/.test(target)) continue
    if (/[<>*]/.test(target)) continue
    const resolved = path.resolve(path.dirname(file), target)
    if (!fs.existsSync(resolved)) {
      problems.push(`${rel(file)}: 断链 [${raw}]`)
    }
  }
}

function checkInlineRefs(file, content) {
  const text = stripCodeBlocks(content)
  // 反引号内的仓库相对路径：只认顶层已知目录，避免误判命令与标识符
  const refRe = /`((?:docs|packages|scripts|deployer|plugins|tests)\/[^`\s]+)`/g
  let match
  while ((match = refRe.exec(text)) !== null) {
    const target = decode(match[1])
    if (/[<*]/.test(target) || /[.,;；）)]$/.test(target)) continue
    const resolved = path.resolve(repoRoot, target)
    if (!fs.existsSync(resolved)) {
      problems.push(`${rel(file)}: 引用路径不存在 \`${target}\``)
    }
  }
}

function rel(file) {
  return path.relative(repoRoot, file).replaceAll('\\', '/')
}

function checkAgentsSize() {
  const agentsPath = path.join(repoRoot, 'AGENTS.md')
  if (!fs.existsSync(agentsPath)) return
  const size = fs.statSync(agentsPath).size
  const kb = (size / 1024).toFixed(1)
  if (size > AGENTS_HARD_LIMIT) {
    problems.push(`AGENTS.md 体量 ${kb}KB 超过硬上限 20KB：必须先下沉再新增内容`)
  } else if (size > AGENTS_SOFT_LIMIT) {
    console.warn(`[warn] AGENTS.md 体量 ${kb}KB 超过 15KB 软上限：新增前先下沉旧内容`)
  } else {
    console.log(`AGENTS.md 体量 ${kb}KB（上限内）`)
  }
}

const files = [
  ...ROOT_FILES.map(name => path.join(repoRoot, name)),
  ...walkMd(path.join(repoRoot, 'docs')),
].filter(file => fs.existsSync(file))

for (const file of files) {
  const content = fs.readFileSync(file, 'utf8')
  checkLinks(file, content)
  if (ROOT_FILES.includes(path.basename(file))) checkInlineRefs(file, content)
}

checkAgentsSize()

if (problems.length > 0) {
  console.error(`\ncheck-docs 失败，共 ${problems.length} 处：`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log(`check-docs 通过：${files.length} 个 markdown 文件，链接与引用全部有效`)
