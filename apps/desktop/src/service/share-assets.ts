import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { SHARE_ASSET_PREFIX } from './share.ts'

/**
 * 分享页运行时资产的读取。
 *
 * 分享页要自己渲染 mermaid、给代码块挂复制按钮，这些脚本必须是独立可执行的文件
 * （页面是服务端直出的静态 HTML，没有渲染进程）。两份资产都由
 * `scripts/build-share-assets.mjs` 产出：
 *
 *  - `share-runtime.js`：`src/share-page/runtime.ts` 的浏览器端 bundle；
 *  - `mermaid.min.js`：mermaid 官方独立构建（3.4MB，只在页面含图表时才加载）。
 *
 * 为什么不从 node_modules 现读：打包后的安装包里没有 node_modules（见
 * electron-builder.yml），构建期拷进产物是唯一在 dev 与打包态都成立的做法。
 *
 * 两种落点的原因：dev 下服务产物在 `out/main/`，资产在 `build/share-assets/`；
 * 打包态服务产物是 asar.unpacked 里的 `out/main/`，资产按 extraResources 落到
 * `resources/share-assets/`。两条路径都试一遍，谁存在用谁。
 */

/** 只允许这几份：这个前缀是公开的，不能变成任意文件读取入口 */
const FILES: Record<string, string> = {
  'runtime.js': 'share-runtime.js',
  'share-highlight.js': 'share-highlight.js',
  'mermaid.min.js': 'mermaid.min.js',
}

function assetDirs(): string[] {
  const here = dirname(fileURLToPath(import.meta.url))
  return [
    // 打包态：assets 按 extraResources 落到 resources/share-assets。
    // service 在 resources/app.asar.unpacked/out/main，上溯三级即 resources。
    join(here, '..', '..', '..', 'share-assets'),
    // dev / 直接跑 out：apps/desktop/out/main 上溯两级到 apps/desktop，再接 build
    join(here, '..', '..', 'build', 'share-assets'),
  ]
}

export function createRuntimeAssets(): (name: string) => Buffer | null {
  const candidates = assetDirs()
  return name => {
    const file = FILES[name]
    if (!file) return null
    for (const dir of candidates) {
      const full = join(dir, file)
      if (!existsSync(full)) continue
      try {
        return readFileSync(full)
      } catch {
        // 继续试下一个落点
      }
    }
    return null
  }
}

/** 供页面引用：运行时脚本的公开地址 */
export const RUNTIME_SCRIPT = `${SHARE_ASSET_PREFIX}runtime.js`
