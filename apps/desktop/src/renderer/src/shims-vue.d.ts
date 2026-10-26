// `*.vue` 通配声明必须放在无 import/export 的脚本文件里才生效；
// 放进 env.d.ts 会因该文件已是模块而退化为「模块增强」，无法匹配任何裸模块。
declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}
