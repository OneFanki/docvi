/*
 * 服务进程也吃 Vite 的 `?raw` 导入（分享页把 theme.css / doc.css 当字符串内联
 * 进页面）。这两个入口由 electron-vite 的 main 构建处理，和渲染层是同一个
 * 打包器；但 tsconfig.node.json 只声明了 node 类型，缺 `*?raw` 的模块声明，
 * 所以这里补一份 vite/client。
 *
 * 只影响类型：运行期没有 vite 依赖。
 */
/// <reference types="vite/client" />
