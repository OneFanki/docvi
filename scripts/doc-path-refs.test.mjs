/**
 * 文档内「源码路径引用」有效性守卫。
 *
 * 课程与设计文档里大量写着 `src/components/business/`、`packages/desktop/src/…`
 * 这类路径。仓库重构（自研壳退役、组件迁入 plugins）后这些路径全部失效，
 * 但没有任何构建会因此失败——读者照着做才发现「目录不存在」。这类腐烂只能靠
 * 断言锁住：文档里出现的**仓内路径**必须真实存在。
 *
 * 判定口径（避免误报）：
 *  - 只认形如 `foo/bar/` 或 `foo/bar.ts` 的相对路径，且第一段是仓库里真实存在的
 *    顶层目录（apps / packages / plugins / scripts / deployer / courses / docs）；
 *  - 以 `/` 结尾按目录检查存在性，否则按文件或目录检查；
 *  - 行内含 `scan-allow` 标记的跳过（用于刻意举例「旧路径长什么样」的历史叙述）；
 *  - 排除代码块内的 shell 命令（`cd` 之类由命令检查管，不由本测试管）。
 */
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')

/** 顶层目录白名单：只检查这些前缀，避免把外部文档路径当成本仓路径 */
const TOP_DIRS = ['apps', 'packages', 'plugins', 'scripts', 'deployer', 'courses', 'docs'].filter(
  name => existsSync(join(root, name)),
)

/** 递归收集 markdown 文件（课程与设计文档是腐烂高发区） */
function walkMarkdown(dir, out = []) {
  const abs = join(root, dir)
  if (!existsSync(abs)) return out
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue
      walkMarkdown(rel, out)
    } else if (entry.name.endsWith('.md')) {
      out.push(rel)
    }
  }
  return out
}

/** 抽出反引号里形如仓内路径的片段 */
function extractPaths(line) {
  const found = []
  for (const match of line.matchAll(/`([^`\n]+)`/g)) {
    const text = match[1].trim()
    if (!/^(?:apps|packages|plugins|scripts|deployer|courses|docs)\//.test(text)) continue
    // 去掉通配与占位：只检查确定的字面前缀
    if (/[*<>{}[\]$?]/.test(text)) continue
    found.push(text)
  }
  return found
}

/** 修掉引用路径里的锚点与行号后缀 */
function normalize(text) {
  return text.replace(/[#:].*$/, '').replace(/[.,;:)]+$/, '')
}

/**
 * 合法例外：路径确实不指向本仓现有文件，但原因明确。
 *
 * 只登记**已退役/未实现/外部仓库**三类；每一条都写清为什么，新增条目必须同样
 * 说明理由——否则这条门禁会慢慢退化成「一律放行」。
 */
const ALLOW = [
  { path: 'packages/reactivity', why: '引用的是 Vue 源码目录结构，不是本仓' },
  { path: 'packages/shell', why: '仅见于「已退役」说明（该文档开头即声明不再存在）' },
  { path: 'packages/desktop', why: 'ADR 与踩坑记录中的历史宿主，已退役' },
  { path: 'packages/ui', why: '设计稿里待拍板的目标结构，尚未实现' },
  { path: 'apps/web', why: '设计稿里待拍板的目标结构，尚未实现' },
  { path: 'docs/SKILL.md', why: '插件包内的相对路径（plugins/*/docs/SKILL.md）' },
  { path: 'docs/archive/', why: '文档规范规定的归档目录，尚未创建' },
  { path: 'scripts/bundle-server.mjs', why: '已删除的构建脚本，仅作为踩坑记录引用' },
  { path: 'apps/desktop/dist-web', why: '构建产物（vite 生成），干净克隆里本来就不存在' },
  { path: 'apps/desktop/release', why: '打包产物（electron-builder 生成），同上' },
  { path: 'apps/desktop/out', why: '构建产物（electron-vite 生成），同上' },
]

function allowed(path) {
  return ALLOW.find(item => path === item.path || path.startsWith(`${item.path}/`))
}

/** 存在性判定：文档里的站内链接可以不带 .md（渲染层自动补），检查时两种都试 */
function resolves(path) {
  if (existsSync(join(root, path))) return true
  return !/\.[a-z0-9]+$/i.test(path) && existsSync(join(root, `${path}.md`))
}

test('课程与文档里引用的仓内路径必须真实存在', () => {
  const files = [...walkMarkdown('courses'), ...walkMarkdown('docs')]
  const missing = []

  for (const file of files) {
    const lines = readFileSync(join(root, file), 'utf8').split('\n')
    let inFence = false
    for (const [index, line] of lines.entries()) {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence
        continue
      }
      if (inFence) continue
      if (line.includes('scan-allow')) continue
      for (const raw of extractPaths(line)) {
        const path = normalize(raw)
        if (allowed(path)) continue
        // 目录形态（以 / 结尾）与文件形态都要能落地
        if (!resolves(path)) {
          missing.push(`${file}:${index + 1}  ${raw}`)
        } else if (raw.endsWith('/')) {
          const abs = join(root, path)
          if (!statSync(abs).isDirectory()) missing.push(`${file}:${index + 1}  ${raw}（应为目录）`)
        }
      }
    }
  }

  assert.deepEqual(missing, [], `以下文档引用了不存在的仓内路径：\n${missing.join('\n')}`)
})

test('课程里不再出现插件化之前的老源码路径', () => {
  const legacy = ['src/components/', 'src/components/business/', 'src/components/ce/']
  const offenders = []
  for (const file of walkMarkdown('courses')) {
    const text = readFileSync(join(root, file), 'utf8')
    for (const bad of legacy) {
      if (text.includes(`\`${bad}`)) offenders.push(`${file} 含 \`${bad}\``)
    }
  }
  assert.deepEqual(offenders, [], `课程里仍有旧源码路径：\n${offenders.join('\n')}`)
})

test('顶层目录白名单自身有效（防止守卫静默失效）', () => {
  assert.ok(TOP_DIRS.length >= 5, `只找到 ${TOP_DIRS.length} 个顶层目录，路径检查可能整段空转`)
  assert.ok(TOP_DIRS.includes('plugins'), '白名单应包含 plugins')
})
