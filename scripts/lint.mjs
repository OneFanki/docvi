#!/usr/bin/env node
/**
 * lint 基线棘轮：错误必须为 0；警告（存量 any）不得高于基线，只能减少。
 *
 * 为什么不用 `eslint --max-warnings=N`：数字散在 package.json 里，没人知道
 * 基线怎么来的、改了没有。这里把基线落成文件（scripts/lint-baseline.json），
 * 允许下降，新增即失败——与类型基线同一套思路。
 *
 * 用法：
 *   node scripts/lint.mjs            # 校验
 *   node scripts/lint.mjs --update   # 收敛后更新基线（只在警告数下降时允许）
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const BASELINE_FILE = join(ROOT, 'scripts', 'lint-baseline.json')
const update = process.argv.includes('--update')

const eslintBin = join(ROOT, 'node_modules', 'eslint', 'bin', 'eslint.js')
if (!existsSync(eslintBin)) {
  console.error('[lint] 找不到 eslint，请先 pnpm install')
  process.exit(1)
}

const result = spawnSync(process.execPath, [eslintBin, '.', '--format', 'json'], {
  cwd: ROOT,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})

if (result.error) {
  console.error(`[lint] 执行失败：${result.error.message}`)
  process.exit(1)
}

let report
try {
  report = JSON.parse(result.stdout || '[]')
} catch {
  console.error('[lint] 无法解析 eslint 输出：')
  console.error(result.stdout?.slice(0, 2000))
  process.exit(1)
}

const errors = []
const warnings = []
for (const file of report) {
  for (const message of file.messages) {
    const item = {
      file: file.filePath.replace(`${ROOT}\\`, '').replace(`${ROOT}/`, '').replaceAll('\\', '/'),
      line: message.line,
      rule: message.ruleId,
      text: message.message,
    }
    if (message.severity === 2) errors.push(item)
    else warnings.push(item)
  }
}

const baseline = existsSync(BASELINE_FILE)
  ? JSON.parse(readFileSync(BASELINE_FILE, 'utf8'))
  : { warnings: 0 }

function print(items, limit = 40) {
  for (const item of items.slice(0, limit)) {
    console.error(`  ${item.file}:${item.line}  [${item.rule}]  ${item.text}`)
  }
  if (items.length > limit) console.error(`  …另有 ${items.length - limit} 条`)
}

console.log(
  `[lint] 错误 ${errors.length} 项，警告 ${warnings.length} 项（基线 ${baseline.warnings}）`,
)
if (warnings.length > 0) {
  console.log('[lint] 警告分布：')
  const byRule = new Map()
  for (const item of warnings) byRule.set(item.rule, (byRule.get(item.rule) ?? 0) + 1)
  for (const [rule, count] of [...byRule].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${count.toString().padStart(3)}  ${rule}`)
  }
}

if (errors.length > 0) {
  console.error('\n[lint] 错误清单：')
  print(errors)
  process.exitCode = 1
}

if (warnings.length > baseline.warnings) {
  console.error(
    `\n[lint] 警告数 ${warnings.length} 超过基线 ${baseline.warnings}：本次改动引入了新的告警，请修掉后再提交`,
  )
  // 超出基线时直接展示全部警告，由人自行比对定位
  print(warnings)
  process.exitCode = 1
} else if (warnings.length < baseline.warnings) {
  if (update) {
    writeFileSync(
      BASELINE_FILE,
      `${JSON.stringify({ warnings: warnings.length }, null, 2)}\n`,
      'utf8',
    )
    console.log(`[lint] 基线已收敛：${baseline.warnings} → ${warnings.length}`)
  } else {
    console.log(
      `[lint] 警告已降至 ${warnings.length}（低于基线 ${baseline.warnings}），可跑 --update 收敛基线`,
    )
  }
}

if (process.exitCode) process.exit(process.exitCode)
console.log('[lint] 通过')
