/**
 * 主题契约校验：把「组件只能消费语义 token」变成可执行检查。
 *
 * 为什么需要它：组件渲染在正文流里，一旦写死颜色（比如直接 `#e04040`），
 * 用户切到另一个文档主题就会得到「红卡片配蓝正文」的割裂观感。
 * 光靠文档约定挡不住，必须能在构建期拦下来。
 *
 * 检查三类：
 *  1. **禁止字面量颜色**：`#rgb` / `#rrggbb` / `rgb()` / `hsl()` 只允许出现在
 *     theme.css 里；组件与页面样式必须走 var(--dv-c-* / --dv-doc-* / --dv-ui-*)。
 *  2. **禁止旧命名**：新代码不得再写 `--at-*`（兼容别名只服务存量组件）。
 *  3. **禁止未定义变量**：引用的 `--dv-*` 必须在本包 theme.css 或宿主 tokens 里定义，
 *     拼错变量名会静默失效成透明/继承色，这是最难查的一类问题。
 *
 * 纯 Node 脚本模块（不进浏览器包）：渲染进程不需要它，构建期与 CI 使用。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, extname } from 'node:path'

const STYLE_EXTS = new Set(['.css', '.vue', '.scss', '.less'])
const LITERAL_COLOR = /#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\(\s*[0-9]/g
const LEGACY_VAR = /var\(\s*--at-[\w-]+/g
const DV_VAR = /var\(\s*(--dv-[\w-]+)/g

/** 允许写颜色字面量的文件（主题定义本身） */
const LITERAL_ALLOW = [/theme\.css$/, /tokens\.css$/, /tokens\.mjs$/]

function walk(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'out') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (STYLE_EXTS.has(extname(entry.name))) out.push(full)
  }
  return out
}

/** 从 CSS 文本里抽取已定义的变量名 */
export function collectDefinedVars(cssText) {
  const defined = new Set()
  const re = /^\s*(--dv-[\w-]+)\s*:/gm
  let m
  while ((m = re.exec(cssText)) !== null) {
    if (m[1]) defined.add(m[1])
  }
  return defined
}

/**
 * @param {{ root: string, definedVars: Set<string>, allowLiteral?: RegExp[] }} options
 * @returns {Array<{ file: string, line: number, kind: string, detail: string }>}
 */
export function lintThemeUsage(options) {
  const issues = []
  const allowLiteral = [...LITERAL_ALLOW, ...(options.allowLiteral ?? [])]

  for (const file of walk(options.root)) {
    if (allowLiteral.some(pattern => pattern.test(file))) continue
    const rel = relative(options.root, file).replaceAll('\\', '/')
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    // 只看 <style> 段：<script> 里的颜色字符串可能是数据（不是样式）
    const styleOnly = file.endsWith('.vue')
      ? [...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n')
      : text

    const lines = styleOnly.split(/\r?\n/)
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? ''
      LITERAL_COLOR.lastIndex = 0
      if (LITERAL_COLOR.test(line)) {
        issues.push({
          file: rel,
          line: i + 1,
          kind: 'literal-color',
          detail: line.trim().slice(0, 120),
        })
      }
      LEGACY_VAR.lastIndex = 0
      if (LEGACY_VAR.test(line)) {
        issues.push({
          file: rel,
          line: i + 1,
          kind: 'legacy-var',
          detail: line.trim().slice(0, 120),
        })
      }
      DV_VAR.lastIndex = 0
      let m
      while ((m = DV_VAR.exec(line)) !== null) {
        const name = m[1]
        if (name && !options.definedVars.has(name)) {
          issues.push({ file: rel, line: i + 1, kind: 'unknown-var', detail: `${name} 未定义` })
        }
      }
    }
  }
  return issues
}

/** 汇总多个 CSS 文件的变量定义 */
export function definedVarsFromFiles(files) {
  const all = new Set()
  for (const file of files) {
    try {
      for (const name of collectDefinedVars(readFileSync(file, 'utf8'))) all.add(name)
    } catch {
      // 文件不存在时跳过：调用方保证路径正确
    }
  }
  return all
}
