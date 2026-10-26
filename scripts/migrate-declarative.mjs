#!/usr/bin/env node
/**
 * 声明式写法迁移工具（一次性，仅存量文档迁移时使用）：
 * 把「script setup 数据块 + 全局组件标签」的 md 迁移为「frontmatter components 段
 * + at-* 标签」（设计见 docs/design/平台自研壳与多宿主迁移.md）。
 *
 * 用法：node scripts/migrate-declarative.mjs <md文件...>
 *
 * 原理：script setup 数据块是纯数据声明——抽出求值（?raw import 内联为字符串），
 * 捕获全部顶层 const；正文组件标签解析属性（静态字面量求值 / :prop 引用 const），
 * 每个实例生成一条 { kind, ...数据 }，正文标签改写为 <at-kind data-key="键">。
 * 含 computed/reactive 等派生数据会报错退出，需人工处理。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { parse as yamlParse, stringify as yamlStringify } from 'yaml'

const toKebab = name => name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
const toCamel = s => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase())

function migrate(file) {
  const src = readFileSync(file, 'utf8')
  const scriptMatch = src.match(/<script setup lang="ts">\n([\s\S]*?)<\/script>\n?/)
  if (!scriptMatch) {
    console.log(`跳过（无 script setup）：${file}`)
    return
  }
  const dir = dirname(file)
  let code = scriptMatch[1]

  // ?raw import → 内联文件内容为字符串常量
  code = code.replace(
    /^import (\w+) from '([^']*\?raw)'\n/gm,
    (_, name, path) =>
      `const ${name} = ${JSON.stringify(readFileSync(resolve(dir, path.replace(/\?raw$/, '')), 'utf8'))}\n`,
  )
  // JSON import → 内联为对象字面量（数据文件，非运行时依赖）
  code = code.replace(
    /^import (\w+) from '([^']*\.json)'\n/gm,
    (_, name, path) => `const ${name} = ${readFileSync(resolve(dir, path), 'utf8').trim()}\n`,
  )
  // 其余 import 丢弃（vue 之类的运行时依赖；数据块不应引用它们）
  code = code.replace(/^import[^\n]*\n/gm, '')
  // TS 常量断言（数据块里唯一常见的 TS 语法）：] as const → ]
  code = code.replace(/\]\s+as const\b/g, ']')

  // 捕获顶层 const
  const captured = {}
  const evalCode = code.replace(/^const (\w+) =/gm, '__out.$1 =')
  try {
    new Function('__out', evalCode)(captured)
  } catch (error) {
    console.error(`✗ ${file}：数据块求值失败（含派生数据？需人工处理）——${error.message}`)
    process.exitCode = 1
    return
  }

  // 正文组件标签 → components 段条目 + at-* 标签
  const components = {}
  let body = src.replace(scriptMatch[0], '')
  let seq = 0
  body = body.replace(/<([A-Z]\w+)(\s[\s\S]*?)?\/>/g, (whole, tag, attrs = '') => {
    const kind = toKebab(tag)
    if (!(kind in captured) && !attrs.trim()) return whole // 非组件的自闭合标签，不动
    const data = { kind }
    for (const m of attrs.matchAll(/(?::|)([\w-]+)="([^"]*)"/g)) {
      const prop = toCamel(m[1])
      const raw = m[2]
      if (m[0].startsWith(':')) {
        // 动态绑定：引用捕获的 const，或内联字面量（数组/对象/标量）
        data[prop] = raw in captured ? captured[raw] : new Function(`return (${raw})`)()
      } else {
        data[prop] = raw
      }
    }
    const key = `${toCamel(kind)}${++seq}`
    components[key] = data
    return `<at-${kind} data-key="${key}"></at-${kind}>`
  })

  const fm = yamlStringify({ components })
  writeFileSync(file, `---\n${fm}---\n${body}`)
  console.log(`✓ ${file}：${Object.keys(components).length} 个组件实例 → frontmatter`)
}

const files = process.argv.slice(2)
if (!files.length) {
  console.error('用法: node scripts/migrate-declarative.mjs <md文件...>')
  process.exit(1)
}
// yaml 依赖检查（frontmatter 转储用）
try {
  yamlParse('a: 1')
} catch {
  console.error('✗ 需要 yaml 依赖：pnpm add yaml')
  process.exit(1)
}
for (const f of files) migrate(f)
