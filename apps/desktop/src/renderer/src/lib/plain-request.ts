/**
 * 传给宿主的参数必须先变成纯对象。
 *
 * ## 为什么这件事必须发生在渲染层，而不是 preload
 *
 * `contextBridge` 暴露的方法在**渲染侧→preload 的第一次跨上下文传递**时就会做
 * 一次结构化克隆。Vue 的响应式对象是 Proxy，克隆直接失败并抛
 * `An object could not be cloned.`——**在此之前 preload 里的任何代码都还没执行**，
 * 所以「在 preload 里剥 Proxy」是无效的（实测过：同步方法 `pathsForFiles`
 * 同样抛错，它根本没走 IPC，证明卡点在 contextBridge 边界）。
 *
 * 症状极难查：异常抛在 Electron 内部，渲染层只拿到一个 rejected promise；
 * 若调用点没接 `catch`，界面就是「点了按钮没反应」，控制台一行不打。
 * 2026-11-18 用户报「应用内更新一直失败」，就是关于页把
 * `about.update.asset`（ref 里的响应式对象）直接传给了 `appUpdateDownload`。
 *
 * ## 为什么不用 `structuredClone` 判定
 *
 * 它对 Proxy 也抛错，但抛错**不代表**参数本身有问题——一个正常的普通对象
 * 里嵌了一个 Proxy 同样会抛。用 JSON 往返是更贴合的判据：它只保留可序列化
 * 的数据，正好就是 IPC 能传的东西。
 *
 * 注意 JSON 往返会丢弃 `undefined` 与函数，对 IPC 参数来说是正确行为——
 * 那些本来也传不过去。
 */
export function toPlain<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  try {
    return JSON.parse(JSON.stringify(value)) as T
  } catch {
    /*
     * 循环引用或含 BigInt 之类：交回原值让主进程按自己的校验报错。
     * 在这里抛会让所有调用点都必须处理一个几乎不可能发生的分支。
     */
    return value
  }
}

/**
 * 剥掉 Vue 的响应式包装（等价于 `toRaw` 的浅层版，但本模块不依赖 vue）。
 *
 * 只处理**一层**：IPC 参数几乎都是「一个扁平对象」，嵌多层响应式对象的写法
 * 极少见，而递归剥离开销不小。真要嵌套，调用点自己展开——见 UpdateDialog。
 */
export function plainRequest<T extends Record<string, unknown>>(value: T): T {
  return toPlain(value)
}
