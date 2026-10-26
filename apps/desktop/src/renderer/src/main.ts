/*
 * 宿主注入必须在 App 之前求值（见 lib/boot-host.ts 的说明）：
 * ESM 按 import 声明顺序求值，所以这条要放在所有界面模块之前。
 */
import './lib/boot-host'

import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'

/**
 * 样式加载顺序（有依赖关系，不能乱）：
 *  1. renderer-core 的 theme.css：定义全局字号/圆角/动效、文档主题、组件角色 token
 *  2. renderer-core 的 doc.css：正文排版（消费第 1 步的变量）
 *  3. app 的 base.css：窗口级 reset 与滚动条（最后，可覆盖前者）
 *
 * ⚠️ 曾经漏掉 1 与 2：界面能显示但所有 `--dv-doc-*` / `--dv-c-*` 都是空值，
 * 表现为「文档主题切换无效果、组件取不到颜色」。样式表必须显式引入——
 * Vite 不会因为源码里写了 `var(--dv-...)` 就去打包对应 CSS。
 */
/**
 * ⚠️ 用相对路径而不是包名：别名把 `@docvi/renderer-core` 精确映射到了
 * `src/index.ts`，`@docvi/renderer-core/theme.css` 会被错误解析成
 * `src/index.ts/theme.css`（构建期 ENOENT）。
 */
import '../../../../../packages/renderer-core/src/styles/theme.css'
import '../../../../../packages/renderer-core/src/styles/doc.css'
import './styles/base.css'

import { vTooltip } from './lib/tooltip'

/*
 * 全局注册 v-tooltip：全应用禁止用原生 `title`（系统样式、延迟 1s、不换行、
 * 不跟主题）。指令挂到 body 上 fixed 定位，容器裁剪不会切掉气泡。
 */
createApp(App).use(createPinia()).directive('tooltip', vTooltip).mount('#app')
