#!/usr/bin/env node
/**
 * 桌面打包的插件产物组装：把仓库 `plugins/*`（作者工作目录）转成服务层期望的
 * `<root>/<包名>/<版本>/` 视图，供开发态与安装包共用。
 *
 * 为什么需要这一步：作者目录是 `plugins/base/`（目录名≠包名、无版本段），
 * 而插件注册表按 `plugin.json` 的 name + version 定位——两个视图不能混。
 *
 * 输出：缺省 `apps/desktop/build/plugins/`（打包产物，已被 gitignore；由
 * electron-builder 的 extraResources 收进安装包），`--out` 可改到任意目录。
 *
 * 复制内容：plugin.json / dist / docs / examples（README 与源码不进包）。
 *
 * 用法：node scripts/assemble-plugins.mjs [--out <目录>]
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE_DIR = join(ROOT, 'plugins')
const DEFAULT_OUT = join(ROOT, 'apps', 'desktop', 'build', 'plugins')
const COPY_ITEMS = ['plugin.json', 'dist', 'docs', 'examples']

function parseArgs(argv) {
  const options = { out: DEFAULT_OUT }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') options.out = resolve(argv[++i] ?? DEFAULT_OUT)
  }
  return options
}

/** 读取包清单（缺必填字段直接失败——产物不全会让运行期静默少组件） */
function readManifest(dir) {
  const file = join(dir, 'plugin.json')
  if (!existsSync(file)) return null
  const manifest = JSON.parse(readFileSync(file, 'utf8'))
  const missing = ['name', 'version', 'apiVersion', 'entry'].filter(key => !manifest[key])
  if (missing.length) {
    throw new Error(`${dir}/plugin.json 缺必填字段：${missing.join(' / ')}`)
  }
  return manifest
}

const options = parseArgs(process.argv.slice(2))
rmSync(options.out, { recursive: true, force: true })
mkdirSync(options.out, { recursive: true })

if (!existsSync(SOURCE_DIR)) {
  console.log('[plugins] 没有 plugins/ 目录，跳过')
  process.exit(0)
}

const assembled = []
for (const entry of readdirSync(SOURCE_DIR, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const source = join(SOURCE_DIR, entry.name)
  const manifest = readManifest(source)
  if (!manifest) continue
  const target = join(options.out, manifest.name, manifest.version)
  mkdirSync(target, { recursive: true })
  for (const item of COPY_ITEMS) {
    const from = join(source, item)
    if (!existsSync(from)) continue
    cpSync(from, join(target, item), { recursive: true })
  }
  if (!existsSync(join(target, 'dist'))) {
    throw new Error(
      `${entry.name} 缺少 dist/——先运行 node scripts/build-plugins.mjs（build:app 已串联）`,
    )
  }
  assembled.push(`${manifest.name}@${manifest.version}`)
}

/*
 * 市场清单**不再**收进安装包。
 *
 * 市场现在是远端配置文件（GitHub 上的 `plugins/market.json`），客户端开面板时
 * 拉取并缓存到 userData——它描述的是「别人可以装什么」，跟本机装了哪些内置包
 * 没有关系，放进安装包只会让「拉取失败 → 用安装包里的旧清单」掩盖网络问题。
 * 仓库里这份文件仍是权威副本（发布时同步到 GitHub），只是不再参与打包。
 */

console.log(`[plugins] 组装 ${assembled.length} 个插件包 → ${options.out}`)
for (const item of assembled) console.log(`  · ${item}`)
