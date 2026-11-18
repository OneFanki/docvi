#!/usr/bin/env node
/**
 * 分享页运行时资产构建（`apps/desktop/build/share-assets/`）。
 *
 * 分享页是服务进程直出的静态 HTML，页面上要跑几段脚本才能补齐。三份产物按
 * 「页面里有什么才下什么」拆开，任何一篇文档都不该为另外两种付出首屏等待：
 *
 *  - `share-runtime.js`：mermaid 渲染 + 复制按钮。唯一必下的那份。
 *  - `share-highlight.js`：Shiki 高亮。3.2MB（gzip ~600KB），只有页面含代码块
 *    时 `runtime.js` 才注入它。
 *  - `mermaid.min.js`：mermaid 官方独立浏览器构建，3.4MB（gzip ~940KB），
 *    同理只在页面含图表时才注入。
 *
 * 三份都复用 renderer-core 的实现（**不抄第二份**），所以必须过一遍打包。
 *
 * 为什么产物落在 `build/` 而不是 `out/`：`out/` 由 electron-vite 每次构建清空，
 * 而这份产物只依赖源码与 node_modules，单独一份更省事。
 *
 * 用法：node apps/desktop/scripts/build-share-assets.mjs
 */
import { copyFileSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = resolve(APP, '..', '..')
const OUT = join(APP, 'build', 'share-assets')

/*
 * renderer-core 的源码路径 alias。用绝对路径而不是包名：esbuild 读不到
 * Vite 那套 alias 配置，而 workspace 包的 exports 指向 .ts（esbuild 能处理，
 * 但 `@docvi/renderer-core/mermaid-theme` 这种子路径不在 exports 里）。
 */
const alias = {
  '@docvi/renderer-core/mermaid-theme': join(REPO, 'packages/renderer-core/src/mermaid-theme.ts'),
  '@docvi/renderer-core/mermaid': join(REPO, 'packages/renderer-core/src/mermaid.ts'),
  '@docvi/renderer-core': join(REPO, 'packages/renderer-core/src/index.ts'),
}

const common = {
  bundle: true,
  // iife + 无 splitting：页面用普通 `<script>` 加载，`/share-assets/` 后面只有
  // 我们注册的那几个文件名，多出来的 chunk 一定 404。
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  minify: true,
  legalComments: 'none',
  alias,
}

mkdirSync(OUT, { recursive: true })

await build({
  ...common,
  entryPoints: [join(APP, 'src/share-page/runtime.ts')],
  outfile: join(OUT, 'share-runtime.js'),
})
await build({
  ...common,
  entryPoints: [join(APP, 'src/share-page/highlight.ts')],
  outfile: join(OUT, 'share-highlight.js'),
})

copyFileSync(
  join(REPO, 'node_modules', 'mermaid', 'dist', 'mermaid.min.js'),
  join(OUT, 'mermaid.min.js'),
)

const size = name => (statSync(join(OUT, name)).size / 1048576).toFixed(2)
console.log(
  `[share-assets] share-runtime.js ${size('share-runtime.js')}MB · ` +
    `share-highlight.js ${size('share-highlight.js')}MB · ` +
    `mermaid.min.js ${size('mermaid.min.js')}MB → ${OUT}`,
)
