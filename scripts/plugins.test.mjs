/**
 * 插件包协议一致性守卫（预设包 = 协议的活样例）：
 * 1. plugins/<name>/plugin.json 通过协议必填校验（readManifest，与构建脚本同源）；
 * 2. 清单 components[] 与 src/index.ts 的 KINDS 表逐项一致（kind/title/description
 *    三字段、同序）——两处漂移会在 MCP / 技能聚合 / 文档渲染间产生静默分歧；
 * 3. dist 已构建时：entry 文件存在、保留 vue external、无相对 chunk 引用
 *    （单文件产物约束；未构建时该组断言跳过——构建守卫在 build-plugins.mjs）。
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { readManifest } from './build-plugins.mjs'

const dirname = fileURLToPath(new URL('.', import.meta.url))
const pluginsDir = join(dirname, '../plugins')

const packages = existsSync(pluginsDir)
  ? readdirSync(pluginsDir).filter(name => existsSync(join(pluginsDir, name, 'plugin.json')))
  : []

/** 从 src/index.ts 提取 KINDS 条目（kind/title/description 三元组，保持源序） */
function kindsFromSource(pkgDir) {
  const source = readFileSync(join(pkgDir, 'src', 'index.ts'), 'utf8')
  const entries = [
    ...source.matchAll(/kind:\s*'([\w-]+)',\s*title:\s*'([^']*)',\s*description:\s*'([^']*)'/g),
  ]
  return entries.map(m => ({ kind: m[1], title: m[2], description: m[3] }))
}

/** 本地化字段取中文解析值（string 原样；{lang: string} 取 zh，其次 en） */
function zhOf(value) {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') return value.zh ?? value.en ?? ''
  return ''
}

test('plugins/ 下至少有一个预设包', () => {
  assert.ok(packages.length > 0, 'plugins/ 下没有插件包——预设包是协议的最小活样例')
})

for (const name of packages) {
  const pkgDir = join(pluginsDir, name)

  test(`${name}：plugin.json 通过协议必填校验`, () => {
    const manifest = readManifest(pkgDir)
    assert.ok(manifest.name.match(/^[a-z0-9-]+$/), 'name 必须为 [a-z0-9-]')
    // docs 是 AI 用法文档（MCP 聚合原料），新协议下可选；声明了就必须存在
    if (manifest.docs) {
      assert.ok(
        existsSync(join(pkgDir, manifest.docs)),
        `docs 文件不存在：${manifest.docs}（AI 用法文档是 MCP 聚合原料）`,
      )
    }
  })

  test(`${name}：components[] 与入口源码的注册表逐项一致`, () => {
    const manifest = readManifest(pkgDir)
    const fromManifest = manifest.components.map(item => ({
      kind: item.kind,
      title: zhOf(item.title),
      description: zhOf(item.description),
    }))
    const fromSource = kindsFromSource(pkgDir)

    if (!fromSource.length) {
      // 新协议入口（activate + registerComponent）：没有 KINDS 表，
      // 校验「清单里的每个 kind 都在入口里注册过」，反向多注册也报出来
      const source = readFileSync(join(pkgDir, 'src', 'index.ts'), 'utf8')
      const registered = [
        ...source.matchAll(/register(?:Component|Kind)\(\s*['"]([\w-]+)['"]/g),
      ].map(m => m[1])
      assert.deepEqual(
        [...registered].sort(),
        fromManifest.map(item => item.kind).sort(),
        'plugin.json components[] 与入口注册的 kind 漂移',
      )
      return
    }

    // 旧协议入口（KINDS 表）：kind/中文 title/中文 description 逐项同序比对；
    // example 为清单侧元数据，不参与比对
    assert.deepEqual(
      fromManifest,
      fromSource,
      'plugin.json components[] 与 src/index.ts KINDS 表漂移——两处必须逐项一致（kind/中文 title/中文 description、同序）',
    )
  })

  test(`${name}：声明的组件示例文件存在（协议 v1.1 example，可选字段）`, () => {
    const manifest = readManifest(pkgDir)
    for (const item of manifest.components) {
      if (!item.example) continue
      assert.ok(
        existsSync(join(pkgDir, item.example)),
        `组件 ${item.kind} 声明了 example=${item.example} 但文件不存在`,
      )
    }
  })

  test(`${name}：dist 产物约束（entry 存在 + vue external + 单文件）`, t => {
    const manifest = readManifest(pkgDir)
    const entryFile = join(pkgDir, manifest.entry)
    if (!existsSync(entryFile)) {
      t.skip('未构建 dist——先运行 node scripts/build-plugins.mjs')
      return
    }
    const bundle = readFileSync(entryFile, 'utf8')
    assert.ok(
      /from\s*["']vue["']/.test(bundle) || /import\s*["']vue["']/.test(bundle),
      '产物必须保留对 vue 的外部导入（内置 Vue 副本 = 双实例故障源）',
    )
    assert.ok(!/from\s*["']\.\//.test(bundle), '产物不得引用相对 chunk（协议要求单文件入口）')
    assert.ok(
      !/import\(\s*["']\.\//.test(bundle),
      '产物不得含相对动态 import（协议要求单文件入口）',
    )
  })
}
