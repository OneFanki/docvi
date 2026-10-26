/**
 * 宿主能力标记。
 *
 * 渲染层只有两套宿主：Electron 桌面（完整宿主）与容器 / 浏览器（读者面）。
 * 缺省按桌面处理——老版本 preload 没有 hostKind 字段，行为保持不变。
 *
 * 为什么用模块常量而不是各处 `window.docvi.xxx()` 探测：能力面是**宿主类型**的
 * 属性，不是某次调用的结果。用探测写出来的判断会散落在几十个组件里，且每加一个
 * 接口就要多一处；这里一次判定，组件只问「我是不是读者面」。
 */
export const hostKind: 'electron' | 'web' = window.docvi?.hostKind ?? 'electron'

/** 容器版：没有本地磁盘、git、本地服务进程、插件安装与临时分享 */
export const isWebHost = hostKind === 'web'

/** 文档只读（容器版）：隐藏一切写操作入口 */
export const isReadOnlyHost = isWebHost
