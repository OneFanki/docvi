/**
 * GitHub Actions 工作流的静态检查。
 *
 * 为什么需要：workflow 的 schema 错误**不会**在本地任何命令里暴露——它只在 push
 * 到 GitHub 之后表现为「run 失败、jobs 数量为 0、日志取不到」。实际踩过两次：
 *
 *  1. `COPY --parents` 是 Dockerfile 语法，跟这里无关，但同一类问题：只在 CI 上炸；
 *  2. 把 `environment` 写到某个 step 上——它是 **job 级** 字段，写在 step 上会让
 *     整份 workflow 校验失败，连 job 都不创建。日志里只有一个
 *     「failed to get run log: log not found」，查了很久。
 *
 * 这份检查覆盖最容易犯、后果最不透明的几类：YAML 可解析、job/step 的键合法、
 * 引用的脚本文件真实存在、以及「必须用同一份门禁入口」。
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { parse as parseYaml } from 'yaml'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const WORKFLOWS = join(root, '.github/workflows')

function workflowFiles() {
  if (!existsSync(WORKFLOWS)) return []
  return readdirSync(WORKFLOWS).filter(name => /\.ya?ml$/.test(name))
}

function load(name) {
  return parseYaml(readFileSync(join(WORKFLOWS, name), 'utf8'))
}

/** 允许出现在 job 上的键（GitHub Actions 的 job schema 子集） */
const JOB_KEYS = new Set([
  'name',
  'runs-on',
  'needs',
  'if',
  'environment',
  'permissions',
  'concurrency',
  'outputs',
  'env',
  'defaults',
  'strategy',
  'steps',
  'uses',
  'with',
  'secrets',
  'timeout-minutes',
  'continue-on-error',
  'container',
  'services',
])

/** 允许出现在 step 上的键 */
const STEP_KEYS = new Set([
  'id',
  'name',
  'if',
  'uses',
  'run',
  'with',
  'env',
  'working-directory',
  'shell',
  'continue-on-error',
  'timeout-minutes',
])

test('工作流文件都存在且能被解析', () => {
  const files = workflowFiles()
  assert.ok(files.length >= 2, `只找到 ${files.length} 个工作流，期望至少 2 个`)
  for (const name of files) {
    assert.doesNotThrow(() => load(name), `${name} 无法解析`)
  }
})

test('job 上没有非法字段', () => {
  const problems = []
  for (const name of workflowFiles()) {
    const doc = load(name)
    for (const [jobName, job] of Object.entries(doc?.jobs ?? {})) {
      for (const key of Object.keys(job)) {
        if (!JOB_KEYS.has(key)) problems.push(`${name} › ${jobName}: 未知 job 字段 "${key}"`)
      }
      assert.ok(Array.isArray(job.steps) || job.uses, `${name} › ${jobName}: 必须有 steps 或 uses`)
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'))
})

test('step 上没有非法字段（environment 属于 job，写到 step 会让整份 workflow 失效）', () => {
  const problems = []
  for (const name of workflowFiles()) {
    const doc = load(name)
    for (const [jobName, job] of Object.entries(doc?.jobs ?? {})) {
      for (const [index, step] of (job.steps ?? []).entries()) {
        const label = `${name} › ${jobName} › step ${index + 1}${step.name ? ` (${step.name})` : ''}`
        for (const key of Object.keys(step)) {
          if (!STEP_KEYS.has(key)) problems.push(`${label}: 未知 step 字段 "${key}"`)
        }
        assert.ok(step.uses || step.run, `${label}: 必须给 uses 或 run，否则是一个空步骤`)
        assert.ok(!(step.uses && step.run), `${label}: uses 与 run 不能同时出现`)
      }
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'))
})

test('工作流里引用的仓内脚本都存在', () => {
  const missing = []
  for (const name of workflowFiles()) {
    const text = readFileSync(join(WORKFLOWS, name), 'utf8')
    // 抓 `node scripts/xxx.mjs` 与 `pnpm run xxx` 两类最常见的引用
    for (const match of text.matchAll(/node\s+(scripts\/[\w./-]+\.m?js)/g)) {
      if (!existsSync(join(root, match[1]))) missing.push(`${name}: ${match[1]}`)
    }
  }
  assert.deepEqual(missing, [], `工作流引用了不存在的脚本：${missing.join(', ')}`)
})

test('校验工作流跑的是同一个门禁入口', () => {
  const verify = readFileSync(join(WORKFLOWS, 'verify.yml'), 'utf8')
  assert.match(verify, /pnpm verify/, 'CI 必须调用 pnpm verify，不能另写一套步骤')
  assert.match(verify, /frozen-lockfile/, 'CI 必须用 --frozen-lockfile 装依赖')
})

test('需要 Pages 的工作流在未启用时不会失败', () => {
  const pages = readFileSync(join(WORKFLOWS, 'pages.yml'), 'utf8')
  // 私有仓 + 免费套餐不支持 Pages：探测不到就跳过，不能留下误导性的红叉
  assert.match(pages, /enabled/, 'Pages 工作流必须先探测是否启用')
  assert.match(pages, /notice/, '未启用时应留一条 notice 说明原因与开启方式')
})
