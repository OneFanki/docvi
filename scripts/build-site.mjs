#!/usr/bin/env node
/**
 * 组装介绍页：把截图、图标与版本号装配成可直接托管的静态目录。
 *
 * 为什么要有这一步而不是把图直接放进 site/：
 *
 *  截图的事实源只有一处（`docs/screenshots/`，由 `pnpm screenshots` 生成），
 *  README 与介绍页都引用它。若在 `site/` 里再放一份副本，两处必然漂移——
 *  「README 更新了、介绍页还是旧图」这种问题没有任何门禁会报出来。所以
 *  发布时机械复制，仓库里不留第二份。
 *
 * 用法：node scripts/build-site.mjs [--out site-build]
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outIndex = process.argv.indexOf('--out')
const OUT = resolve(
  ROOT,
  outIndex >= 0 ? (process.argv[outIndex + 1] ?? 'site-build') : 'site-build',
)

const SITE = join(ROOT, 'site')
const SHOTS = join(ROOT, 'docs/screenshots')

function main() {
  if (!existsSync(join(SITE, 'index.html'))) {
    console.error('[site] 找不到 site/index.html')
    process.exit(1)
  }

  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(join(OUT, 'assets'), { recursive: true })
  mkdirSync(join(OUT, 'screenshots'), { recursive: true })

  // 1) 截图：单一来源 docs/screenshots/
  let shotCount = 0
  if (existsSync(SHOTS)) {
    for (const name of readdirSync(SHOTS)) {
      if (!name.endsWith('.png')) continue
      cpSync(join(SHOTS, name), join(OUT, 'screenshots', name))
      shotCount += 1
    }
  }

  // 2) 图标：docs/assets/logo.svg 是唯一来源（与安装包图标同源）
  const logo = join(ROOT, 'docs/assets/logo.svg')
  if (existsSync(logo)) cpSync(logo, join(OUT, 'assets/favicon.svg'))

  // 3) 版本号：替换占位符，避免页面上写着过期的版本
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
  const html = readFileSync(join(SITE, 'index.html'), 'utf8').replaceAll(
    '__VERSION__',
    `v${version}`,
  )
  writeFileSync(join(OUT, 'index.html'), html, 'utf8')

  // 4) 校验页面里引用的图都在——组装这一层就是最后一道，别把 404 发上线
  const referenced = [...html.matchAll(/(?:src|data-[a-z-]+src)="\.\/([\w./-]+)"/g)].map(
    match => match[1],
  )
  const missing = referenced.filter(rel => !existsSync(join(OUT, rel)))
  if (missing.length) {
    console.error(`[site] 页面引用了不存在的资源：\n  ${missing.join('\n  ')}`)
    process.exit(1)
  }

  console.log(`[site] 组装完成 → ${OUT}`)
  console.log(
    `[site] 截图 ${shotCount} 张 · 版本 v${version} · 引用资源 ${referenced.length} 项全部存在`,
  )
}

main()
