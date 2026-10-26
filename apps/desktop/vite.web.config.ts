import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

/**
 * 容器版（浏览器）构建：把同一套渲染层打成站点静态产物。
 *
 * 与 electron.vite.config.ts 的 renderer 段共用同一组别名——两个宿主跑的是
 * **同一份 UI 源码**，差别只在 `window.docvi` 由谁提供（preload 还是 HTTP 适配层）。
 * 分成两份配置而不是一个多目标构建，是因为 Electron 那套产物要 base `./`
 * （file:// 加载），站点必须是 base `/`（history 路由与 /assets 绝对路径）。
 *
 * 产物 dist-web/index.html + assets/，由部署器伺服；`window.docvi` 在运行时由
 * src/renderer/src/lib/web-host.ts 注入。
 */
const aliases = {
  '@docvi/shared': resolve('../../packages/shared/src/index.ts'),
  // 顺序敏感：更具体的入口必须排在包根之前（alias 是前缀匹配）
  '@docvi/renderer-core/markdown': resolve('../../packages/renderer-core/src/markdown.ts'),
  '@docvi/renderer-core': resolve('../../packages/renderer-core/src/index.ts'),
  '@docvi/editor': resolve('../../packages/editor/src/index.ts'),
  '@plugins': resolve('../../plugins'),
  '@renderer': resolve('src/renderer/src'),
}

/**
 * 开发 / 预览时的 API 代理目标。
 *
 * 容器版前端是纯静态产物 + 同源 HTTP 接口，本地要跑起来就需要一个「同源」的
 * API 后端：dev 与 preview 都把这些路径转发到已经在跑的部署器（默认本机 8080）。
 * 生产环境同源直连，不需要代理——这里只是开发便利。
 *
 * 键必须写成「带尾斜杠的正则」：vite 的代理键默认按**前缀**匹配，`'/s'`
 * 会连 `/showcase/...`（仓库路由）一起吞掉，表现是刷新文档页拿到旧壳 HTML。
 */
const API_TARGET = process.env.DOCVI_API_TARGET ?? 'http://127.0.0.1:8080'

/**
 * 版本号：与桌面端同源（读 apps/desktop/package.json）。
 *
 * 容器版没有 preload，`appInfo` 拿不到 `app.getVersion()`；「关于」面板要显示
 * 同一个版本号，只能在构建期注进来——运行期再去请求接口会多一个失败点。
 */
const VERSION =
  (JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version?: string }).version ??
  '0.0.0'

const proxy = {
  '^/api/': { target: API_TARGET, changeOrigin: true },
  '^/docs/': { target: API_TARGET, changeOrigin: true },
  '^/plugins/': { target: API_TARGET, changeOrigin: true },
  '^/s/': { target: API_TARGET, changeOrigin: true },
}

export default defineConfig({
  root: resolve('src/renderer'),
  base: '/',
  resolve: { alias: aliases },
  plugins: [vue()],
  define: { __DOCVI_VERSION__: JSON.stringify(VERSION) },
  server: {
    port: 5320,
    // plugins/ 与 packages/ 在本应用根目录之外，需放行
    fs: { allow: [resolve('../..')] },
    proxy,
  },
  preview: { port: 5321, proxy },
  build: {
    outDir: resolve('dist-web'),
    emptyOutDir: true,
    // 容器部署在局域网/内网，可能遇到较旧的浏览器：不假设顶层 await 等新语法
    target: 'es2020',
    rollupOptions: {
      output: {
        // 依赖与业务代码分开：依赖几乎不变，更新只让业务 chunk 的 hash 变
        manualChunks: {
          vendor: ['vue', 'pinia', 'minisearch', 'markdown-it', 'yaml'],
        },
      },
    },
  },
})
