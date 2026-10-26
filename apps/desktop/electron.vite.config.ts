import { resolve } from 'node:path'
import vue from '@vitejs/plugin-vue'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

/**
 * 三段构建：main / preload / renderer。
 *
 * electron-vite 按约定识别入口（src/main/index.ts、src/preload/index.ts、
 * src/renderer/index.html），产物落在 out/{main,preload,renderer}。
 *
 * ⚠️ preload 必须产出 CommonJS：sandbox 渲染进程只加载 CJS preload，
 * ESM 会被静默忽略——窗口正常显示但 `window.docvi` 不存在（S0 实测踩到）。
 * 5.0.0 的类型未声明 `build.lib`，运行时支持，故断言绕过（升级后删除）。
 *
 * renderer 需要能解析同仓 workspace 包（renderer-core / shared）与 plugins/* 源码，
 * 因此别名显式指向源码入口；plugins 下的组件由 Vite 直接编译（它们是 SFC）。
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

export default defineConfig({
  main: {
    // 服务进程要用 renderer-core 的 Markdown 管线渲染分享页：workspace 包必须打进产物，
    // 不能 external——打包后的 app 里没有 pnpm 的 workspace 软链
    // yaml 也内联：安装包里不带 node_modules（pnpm workspace 软链进 asar 既大又脆弱），
    // 主进程/服务进程运行期依赖必须是零外部包
    plugins: [
      externalizeDepsPlugin({ exclude: ['@docvi/shared', '@docvi/renderer-core', 'yaml'] }),
    ],
    resolve: { alias: aliases },
    // 服务进程是 main 构建的第二个入口：产物 out/main/service.js，由 utilityProcess.fork 拉起，
    // 也可独立运行（--service 档）。electron-vite 5.0 的类型按 Vite 7 声明，本仓锁在 Vite 5，
    // 运行时支持 rollupOptions，故与 preload 的 lib 同样用断言绕过类型。
    build: {
      rollupOptions: {
        input: { index: resolve('src/main/index.ts'), service: resolve('src/service/index.ts') },
      },
    } as never,
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ['@docvi/shared'] })],
    resolve: { alias: aliases },
    build: { lib: { formats: ['cjs'] } } as never,
  },
  renderer: {
    root: resolve('src/renderer'),
    resolve: { alias: aliases },
    plugins: [vue()],
    server: {
      // plugins/ 与 packages/ 在本应用根目录之外，需放行
      fs: { allow: [resolve('../..')] },
    },
  },
})
