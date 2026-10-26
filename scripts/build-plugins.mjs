#!/usr/bin/env node
/**
 * 预设插件包构建（plugins/<name>/ → plugins/<name>/dist/）。
 *
 * 与「第三方插件包在作者 CI 预构建」同一产物形态：ESM 单入口 + 独立 style.css，
 * external vue（运行时经宿主 import map 解析到壳的单一 Vue 实例）。
 * 构建完成后做协议必填字段与产物存在性校验——本地预设包是协议的活样例，
 * 契约破坏在构建期就报错。
 *
 * 用法：node scripts/build-plugins.mjs
 * 被根 package.json 的 build / build:app 链路与 Dockerfile 调用。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import vue from '@vitejs/plugin-vue'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const PLUGINS_DIR = join(ROOT, 'plugins')

/** 协议 v1 必填字段（与 packages/plugin-runtime/src/manifest.ts 的校验保持一致） */
const REQUIRED_FIELDS = ['name', 'displayName', 'version', 'apiVersion', 'entry']

/**
 * 读取并归一化包清单。
 *
 * 两代形状并存：早期预设包把 `components` 挂在顶层，新协议放进 `contributes`。
 * 归一化只在这里做一次——下游（构建 / 测试 / 组装）永远读 `manifest.components`，
 * 免得每个消费点各自判断形状。
 */
export function readManifest(pkgDir) {
  const raw = JSON.parse(readFileSync(join(pkgDir, 'plugin.json'), 'utf8'))
  const manifest = {
    ...raw,
    components: raw.contributes?.components ?? raw.components ?? [],
  }
  const missing = REQUIRED_FIELDS.filter(key => !manifest[key])
  if (missing.length) {
    throw new Error(`${pkgDir}/plugin.json 缺必填字段：${missing.join(' / ')}`)
  }
  if (!Array.isArray(manifest.components) || !manifest.components.length) {
    throw new Error(`${pkgDir}/plugin.json 的 components[] 必须为非空数组`)
  }
  for (const item of manifest.components) {
    for (const key of ['kind', 'title', 'description']) {
      if (!item[key]) throw new Error(`${pkgDir}/plugin.json 组件 ${item.kind ?? '?'} 缺 ${key}`)
    }
  }
  return manifest
}

export function listPackages() {
  return readdirSync(PLUGINS_DIR).filter(name => existsSync(join(PLUGINS_DIR, name, 'plugin.json')))
}

/**
 * 构建全部预设包。作为模块导入时（测试读 readManifest）不执行——
 * 仅当本文件被直接运行时才构建。
 */
export async function buildAll() {
  const packages = listPackages()
  if (!packages.length) {
    console.log('[build-plugins] plugins/ 下没有插件包，跳过')
    return
  }

  for (const name of packages) {
    const pkgDir = join(PLUGINS_DIR, name)
    const manifest = readManifest(pkgDir)
    console.log(`[build-plugins] 构建 ${manifest.name}@${manifest.version}（${name}）…`)
    await build({
      configFile: false,
      root: pkgDir,
      logLevel: 'warn',
      plugins: [
        vue({ template: { compilerOptions: { isCustomElement: tag => tag.startsWith('at-') } } }),
      ],
      build: {
        target: 'es2022',
        lib: {
          entry: join(pkgDir, 'src', 'index.ts'),
          formats: ['es'],
          fileName: () => 'index.js',
          cssFileName: 'style',
        },
        outDir: join(pkgDir, 'dist'),
        emptyOutDir: true,
        // 单文件产物：dist/index.js + dist/style.css（无额外 chunk）。
        // SFC 内的动态 import 也必须内联（单文件产物不允许额外 chunk）。
        rollupOptions: {
          external: ['vue'],
          output: { inlineDynamicImports: true },
        },
      },
    })

    // 产物校验：入口存在 + 保留对 vue 的 external 导入（符号被 minify 后可能改名，
    // 但 import 来源 'vue' 不变）——防止误把 Vue 打进包（双实例的直接原因）
    const entryFile = join(pkgDir, manifest.entry)
    if (!existsSync(entryFile) || !statSync(entryFile).isFile()) {
      throw new Error(`[build-plugins] ${manifest.name} 的 entry 不存在：${manifest.entry}`)
    }
    const bundle = readFileSync(entryFile, 'utf8')
    if (!/from\s*["']vue["']/.test(bundle) && !/import\s*["']vue["']/.test(bundle)) {
      throw new Error(
        `[build-plugins] ${manifest.name} 的产物没有对 'vue' 的外部导入——vue 未 external？`,
      )
    }
    console.log(`[build-plugins] ✓ ${manifest.name} → ${manifest.entry} + 样式`)
  }

  console.log(`[build-plugins] 完成：${packages.length} 个包`)
}

// 直接执行（node scripts/build-plugins.mjs）才构建；被 import 只暴露函数
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildAll()
}
