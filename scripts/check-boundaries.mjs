#!/usr/bin/env node
/**
 * 包依赖方向校验：把 AGENTS.md 的架构边界变成可执行检查。
 *
 * 规则（依赖只能单向）：
 *  - server   不得 import 桌面应用或 electron（它与宿主解耦，容器与 app 共用）
 *  - renderer 只经 preload 白名单访问宿主，禁止 Node 与 electron
 *  - main     可用 Node，但不得 import preload 与渲染层
 *  - preload  只做桥接
 *  - service  可读 Node 与渲染核心的文本管线，不得 import 窗口层
 *  - shared   是纯契约层，零运行时依赖
 *  - plugins  只允许 vue
 *  - deployer 可 import packages/server 与 scripts/lib（复用），不得反向被依赖
 *
 * 只检查存在的目录：某个层被整体删除时规则自动失效，不需要同步改脚本。
 *
 * 用法：node scripts/check-boundaries.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const problems = []
const SCAN_EXT = new Set(['.ts', '.tsx', '.mjs', '.js', '.vue'])

/** 各层允许的 import 目标（前缀匹配，`*` 表示任意） */
const RULES = [
  {
    layer: 'server',
    root: 'packages/server',
    forbidden: [
      { pattern: /apps\/desktop/, why: '服务层必须与宿主解耦（容器与 app 共用同一份）' },
      {
        pattern: /^electron$/,
        why: '服务层跑在纯 Node（utilityProcess / 容器），禁止依赖 Electron',
      },
    ],
  },
  {
    // 容器部署器：允许复用服务层与内容模型（ADR-0003），不得依赖桌面应用
    layer: 'deployer',
    root: 'deployer',
    exclude: [/\/test\//],
    forbidden: [{ pattern: /apps\/desktop/, why: '部署器是服务端，禁止依赖桌面应用' }],
  },
  {
    layer: 'plugins',
    root: 'plugins',
    forbidden: [
      { pattern: /packages\/|scripts\/|deployer\//, why: '插件包只允许依赖 vue' },
      { pattern: /^(node:|electron$)/, why: '插件包只允许依赖 vue' },
    ],
  },
  {
    // docvi 新架构：渲染进程是纯 web 代码，禁止 Node 与 electron
    layer: 'docvi-renderer',
    root: 'apps/desktop/src/renderer',
    forbidden: [
      {
        pattern: /^(node:|fs$|path$|os$|child_process$|electron$)/,
        why: '渲染进程只经 preload 白名单访问宿主，禁止 Node 与 electron',
      },
      { pattern: /apps\/desktop\/src\/main\//, why: '渲染进程禁止 import 主进程代码' },
    ],
  },
  {
    // 主进程可用 Node，但不得 import preload 与渲染层
    layer: 'docvi-main',
    root: 'apps/desktop/src/main',
    forbidden: [
      { pattern: /apps\/desktop\/src\/renderer\//, why: '主进程禁止 import 渲染层' },
      { pattern: /apps\/desktop\/src\/preload\//, why: '主进程禁止 import preload' },
    ],
  },
  {
    // preload 只做桥接
    layer: 'docvi-preload',
    root: 'apps/desktop/src/preload',
    forbidden: [
      {
        pattern: /apps\/desktop\/src\/(main|renderer)\//,
        why: 'preload 只做桥接，禁止引入主进程或渲染层实现',
      },
    ],
  },
  {
    // 服务进程：可读 Node，但只能复用渲染核心（无 DOM 的 Markdown 管线），
    // 不得 import 主进程或窗口层——它要能在无窗口的 --service 档独立运行
    layer: 'docvi-service',
    root: 'apps/desktop/src/service',
    forbidden: [
      {
        pattern: /apps\/desktop\/src\/(main|renderer|preload)\//,
        why: '服务进程独立于窗口：禁止 import 主进程 / 渲染层 / preload',
      },
      {
        pattern: /\/(components|highlight|mermaid)\.ts$/,
        why: '服务进程只复用 Markdown 文本管线，不引入依赖 DOM 的渲染模块',
      },
    ],
  },
  {
    // shared 是契约层：零运行时依赖，不得反向依赖上层
    layer: 'docvi-shared',
    root: 'packages/shared',
    forbidden: [
      {
        pattern: /^(node:|electron$|vue$)/,
        why: 'shared 是纯类型与常量，禁止依赖 Node / Electron / Vue',
      },
      { pattern: /apps\//, why: 'shared 不得反向依赖应用层' },
    ],
  },
]

/** 递归收集源码文件 */
function collect(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'target', '.git'].includes(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) collect(full, out)
    else if (SCAN_EXT.has(path.extname(entry.name))) out.push(full)
  }
  return out
}

/** 提取 import / from / require 的模块标识符 */
function extractSpecifiers(text) {
  const specs = []
  const patterns = [
    /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g,
    /require\(\s*['"]([^'"]+)['"]\s*\)/g,
    /import\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const re of patterns) {
    let match
    while ((match = re.exec(text)) !== null) specs.push(match[1])
  }
  return specs
}

for (const rule of RULES) {
  const rootDir = path.join(repoRoot, rule.root)
  for (const file of collect(rootDir)) {
    const relFile = path.relative(repoRoot, file).replaceAll('\\', '/')
    if (rule.exclude?.some(pattern => pattern.test(relFile))) continue
    const text = fs.readFileSync(file, 'utf8')
    for (const spec of extractSpecifiers(text)) {
      /*
       * 相对路径先解析成「仓内路径」再匹配：规则里写的是 `apps/desktop/src/main/`
       * 这类绝对位置，而源码里写的是 `../../main/index.ts`。只匹配原始字符串会让
       * 相对 import 全部漏检——这条曾真实存在（服务层引主进程未被拦住）。
       * 裸模块名（node:/electron/vue）保持原样匹配。
       */
      const resolved = spec.startsWith('.')
        ? path.relative(repoRoot, path.resolve(path.dirname(file), spec)).replaceAll('\\', '/')
        : spec
      for (const forbid of rule.forbidden) {
        if (!forbid.pattern.test(spec) && !forbid.pattern.test(resolved)) continue
        problems.push(
          `${relFile}: [${rule.layer}] 非法依赖「${resolved === spec ? spec : `${spec} → ${resolved}`}」— ${forbid.why}`,
        )
      }
    }
  }
}

if (problems.length > 0) {
  console.error(`\ncheck-boundaries 失败，共 ${problems.length} 处：`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log('check-boundaries 通过：包依赖方向符合约束')
