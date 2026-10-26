#!/usr/bin/env node
/**
 * 全链校验入口（`pnpm verify`）。
 *
 * 设计取舍：
 * - **串行执行**：串行日志按序可读、定位最直接。
 * - **非 fail-fast**：每步独立收集 exit code 与输出尾部，全部跑完统一出报告——
 *   一次 verify 就能看到全部欠账，而不是修一项、跑一轮、再暴露下一项。
 * - **只读为主**：绝大多数步骤只扫描不写盘。唯一例外是「插件产物构建」——它必须
 *   在单元测试之前跑，否则 `plugins.test.mjs` 的 dist 约束会因为「文件不存在」而
 *   静默 skip（CI 上实测跳过 2 项，等于没验）。产物目录已 gitignore，不影响工作区。
 */
import { spawn } from 'node:child_process'

const checks = [
  { name: '格式检查', args: ['run', 'format:check'] },
  { name: '代码检查', args: ['run', 'lint'] },
  { name: '组件类型检查', args: ['run', 'typecheck'] },
  { name: 'docvi 类型检查', args: ['run', 'docvi:typecheck'] },
  { name: 'docvi 构建', args: ['run', 'docvi:build'] },
  // 写盘步骤（产物在 plugins/*/dist，已 gitignore）：不跑它，下面的单测会 skip 掉
  // 插件产物约束
  { name: '插件产物构建', args: ['run', 'build:plugins'] },
  { name: '单元测试', args: ['run', 'test'] },
  { name: '服务层测试', args: ['--filter', '@docvi/server', 'run', 'test'] },
  { name: 'docvi 服务测试', args: ['--filter', '@docvi/desktop', 'run', 'test'] },
  { name: '部署器单元测试', args: ['--dir', 'deployer', 'run', 'test'] },
  { name: 'docvi 文案校验', args: ['run', 'docvi:i18n:check'] },
  { name: '文档校验', args: ['run', 'docs:check'] },
  { name: '技能治理校验', args: ['run', 'skills:check'] },
  { name: '依赖方向校验', args: ['run', 'check:boundaries'] },
  { name: '开源敏感内容扫描', args: ['run', 'scan:open-source'] },
]

const TAIL_LINES_PASS = 8
const TAIL_LINES_FAIL = 120

function runOne(check) {
  return new Promise(resolve => {
    const startedAt = Date.now()
    // win32 下 .cmd 必须走 shell；参数全部来自本文件静态字面量，无注入面
    const isWin32 = process.platform === 'win32'
    const command = `pnpm${isWin32 ? '.cmd' : ''} ${check.args.join(' ')}`
    const child = spawn(command, {
      cwd: process.cwd(),
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
    })

    let output = ''
    let settled = false
    const finish = (exitCode, extra = '') => {
      if (settled) return
      settled = true
      resolve({ exitCode, output: output + extra, durationMs: Date.now() - startedAt })
    }

    child.stdout?.on('data', chunk => {
      output += chunk
    })
    child.stderr?.on('data', chunk => {
      output += chunk
    })
    child.on('error', error => finish(1, `\n[verify] 启动失败：${error.message}\n`))
    child.on('close', code => finish(code ?? 1))
  })
}

function tail(text, maxLines) {
  const lines = text.split('\n').filter(line => line.trim() !== '')
  if (lines.length === 0) return ''
  const kept = lines.slice(-maxLines)
  const prefix = lines.length > maxLines ? `…（前 ${lines.length - maxLines} 行省略）\n` : ''
  return prefix + kept.map(line => `  │ ${line}`).join('\n') + '\n'
}

const seconds = ms => `${(ms / 1000).toFixed(1)}s`

const startedAtAll = Date.now()
const results = []
for (const [index, check] of checks.entries()) {
  try {
    const result = await runOne(check)
    results.push({ check, ...result })
    const mark = result.exitCode === 0 ? '✓' : '✗'
    // 进度写 stderr：stdout 留给最终分项报告，便于整体重定向到日志
    process.stderr.write(
      `[verify] [${index + 1}/${checks.length}] ${mark} ${check.name} (${seconds(result.durationMs)})\n`,
    )
  } catch (error) {
    results.push({ check, exitCode: 1, output: '', durationMs: 0, crash: error.message })
    process.stderr.write(`[verify] [${index + 1}/${checks.length}] ✗ ${check.name}（执行器异常）\n`)
  }
}

const failures = []
process.stdout.write('\n========== [verify] 分项报告 ==========\n')
for (const { check, exitCode, output, durationMs, crash } of results) {
  const failed = exitCode !== 0
  process.stdout.write(
    `\n[verify] ${check.name} — ${failed ? `失败(exit ${exitCode})` : '通过'} ${seconds(durationMs)}\n`,
  )
  if (crash) process.stdout.write(`  │ 执行器异常：${crash}\n`)
  if (output.trim() !== '') {
    process.stdout.write(tail(output, failed ? TAIL_LINES_FAIL : TAIL_LINES_PASS))
  }
  if (failed) failures.push({ name: check.name, exitCode })
}

process.stdout.write(`\n[verify] 墙钟总耗时 ${seconds(Date.now() - startedAtAll)}\n`)

if (failures.length > 0) {
  const summary = failures.map(failure => `${failure.name}(exit ${failure.exitCode})`).join('、')
  process.stderr.write(`\n[verify] ${failures.length} 项失败：${summary}\n`)
  process.exitCode = 1
} else {
  process.stdout.write('\n[verify] 全部校验通过\n')
}
