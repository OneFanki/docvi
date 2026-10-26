/**
 * 内建组件清单一致性守卫：
 * - 通用清单页（courses/component-showcase/index.md）必须列全预设插件包的**通用**组件；
 * - 通用组件必须在通用演示章节（courses/component-showcase/chapters）里至少出现一次。
 *
 * 注册名单以 plugins/base/plugin.json 的 components[] 为准（插件协议 v1 的 kind
 * 权威清单，与 plugins/base/src/index.ts 的 KINDS 表由 plugins.test.mjs 一致性守卫）。
 * **业务组件**（plugins/audio 等场景包的组件，与特定领域绑定、故意不进通用清单）
 * 自动排除。
 * 增删组件时同步更新清单页与演示章节，否则本测试失败。
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const dirname = fileURLToPath(new URL('.', import.meta.url))
const coursesDir = join(dirname, '../courses')
const pluginsDir = join(dirname, '../plugins')

/** kebab → PascalCase（tutorial-shell → TutorialShell），兼容旧标签写法判定 */
function toPascal(kind) {
  return kind.replace(/(^|-)([a-z])/g, (_, _s, c) => c.toUpperCase())
}

/** 从插件包的 plugin.json 提取 kind 清单 */
function packageKinds(pkgDirName) {
  const file = join(pluginsDir, pkgDirName, 'plugin.json')
  if (!existsSync(file)) return new Set()
  const manifest = JSON.parse(readFileSync(file, 'utf8'))
  return new Set((manifest.components ?? []).map(item => item.kind))
}

/** 场景包（非 base）的 kind 集——不进通用清单 */
function sceneKinds() {
  if (!existsSync(pluginsDir)) return new Set()
  const scenePackages = readdirSync(pluginsDir).filter(name => name !== 'base')
  const kinds = new Set()
  for (const name of scenePackages) {
    for (const kind of packageKinds(name)) kinds.add(kind)
  }
  return kinds
}

function commonKinds() {
  const scene = sceneKinds()
  return [...packageKinds('base')].filter(kind => !scene.has(kind))
}

function readChapters(dir) {
  return readdirSync(dir)
    .filter(name => name.endsWith('.md'))
    .map(name => readFileSync(join(dir, name), 'utf8'))
    .join('\n')
}

/**
 * 组件的「出现」判定。
 *
 * 绝大多数组件靠 `<at-<kind>` 标签引用；但**结构化块类**组件（目前只有
 * `merged-table`）不走标签，数据写在 `::: <syntax>` 容器里——语法名与 kind 不是
 * 同一个词（`::: merged` → `merged-table`），所以要从 plugin.json 的
 * `contributes.markdownSyntax` 反查：声明了 container 语法的组件，容器名也算出现。
 */
function syntaxNamesFor(pkgDirName) {
  const file = join(pluginsDir, pkgDirName, 'plugin.json')
  if (!existsSync(file)) return new Map()
  const manifest = JSON.parse(readFileSync(file, 'utf8'))
  const map = new Map()
  for (const item of manifest.contributes?.markdownSyntax ?? []) {
    if (typeof item?.name === 'string' && typeof item?.component === 'string') {
      map.set(item.component, item.name)
    }
  }
  return map
}

const containerSyntax = syntaxNamesFor('base')

/** 某组件是否在给定文本里出现过（标签写法或容器语法写法） */
function mentions(text, kind) {
  if (text.includes(`<at-${kind}`)) return true
  const syntax = containerSyntax.get(kind)
  if (syntax && new RegExp(`^:::\\s*${syntax}\\b`, 'm').test(text)) return true
  return false
}

test('通用清单页列出全部注册组件', () => {
  const kinds = commonKinds()
  assert.ok(kinds.length > 0, '未从 plugins/base/plugin.json 解析到组件')

  const listing = readFileSync(join(coursesDir, 'component-showcase/index.md'), 'utf8')
  // 三种写法都算：清单表里的 <PascalCase>、声明式 <at-kebab>、容器语法 ::: name
  const missing = kinds.filter(
    kind =>
      !listing.includes(`<at-${kind}`) &&
      !listing.includes(`<${toPascal(kind)}>`) &&
      !listing.includes(`::: ${containerSyntax.get(kind) ?? '\u0000'}`),
  )
  assert.deepEqual(
    missing,
    [],
    `清单页缺少组件：${missing.join(', ')}（同步 courses/component-showcase/index.md）`,
  )
})

test('每个通用组件在通用演示章节中至少出现一次', () => {
  const kinds = commonKinds()
  const corpus = readChapters(join(coursesDir, 'component-showcase/chapters'))
  const undemoed = kinds.filter(kind => !mentions(corpus, kind))
  assert.deepEqual(
    undemoed,
    [],
    `未演示组件：${undemoed.join(', ')}（在 courses/component-showcase/chapters 中补一段演示）`,
  )
})
