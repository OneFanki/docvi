/**
 * 视图切换时的「阅读位置」与「编辑器状态」保管（纯逻辑，不碰 DOM / Vue）。
 *
 * 用户报过两个直接相关的问题：
 *  1. **切视图会重置文档位置**——正在看的内容被甩走；
 *  2. **切视图后没法撤销**——未保存的改动还在缓冲区里，但撤销栈跟着编辑器
 *     实例一起没了。
 *
 * 两条根因都在「切换」这一步：
 *  - 位置若用 `scrollTop` 绝对值搬运，两视图排版高度完全不同（源码里一行表格
 *    渲染后可能是几十行），必然落错地方 → 必须用**源行**这种内容坐标；
 *  - `EditorState` 是撤销栈的唯一载体，随视图销毁就丢了 → 必须在卸载前取走、
 *    挂载时带回。
 *
 * 抽成纯函数是为了能锁住「什么时候该记、什么时候该清」这类时序契约：
 * 锚点用一次就清，否则下一次普通渲染会被它带偏。
 */

/** 编辑器能提供的两种「位置读数」：源行（跨视图可用）与像素（仅同视图内可用） */
export interface ViewPosition {
  /** 视口顶部的 0-based 源行 */
  topLine: number
  /** 滚动像素（仅同视图内有意义） */
  scrollTop: number
}

/** 视图切换需要保管的两样东西 */
export interface ViewHandoff {
  /** 待恢复的源行；null = 没有待恢复的锚点 */
  anchor: number | null
  /** 编辑器状态快照（含撤销栈），按文档绝对路径存 */
  editorStates: Map<string, unknown>
}

export function createHandoff(): ViewHandoff {
  return { anchor: null, editorStates: new Map() }
}

/**
 * 离开一个视图：记下锚点。
 *
 * 只认源行——像素值在这里没有跨视图意义，存下来只会制造「好像恢复了但其实
 * 偏了几屏」的假象。
 */
export function leaveView(handoff: ViewHandoff, position: ViewPosition | null): void {
  handoff.anchor = position ? Math.max(0, Math.round(position.topLine)) : null
}

/**
 * 进入一个视图：取走锚点（**取完即清**）。
 *
 * 为什么必须清：视图渲染完成会多次触发「渲染完毕」回调（高亮、Mermaid、
 * 组件挂载各一次）。锚点若留着重放，后面的回调会把已经恢复正常滚动的页面
 * 又拽回锚点位置，表现为「滚不动 / 一直弹回去」。
 */
export function takeAnchor(handoff: ViewHandoff): number | null {
  const anchor = handoff.anchor
  handoff.anchor = null
  return anchor
}

/**
 * 只读当前锚点（不消费）。
 *
 * 编辑器挂载时用这个：它在 `onMounted` 里读一次，「消费」的那一刻由宿主在
 * 编辑器报告已落位后调 `takeAnchor`。这样同一帧内多次重渲染不会被重复触发。
 */
export function peekAnchor(handoff: ViewHandoff): number | null {
  return handoff.anchor
}

/**
 * 保存编辑器状态。
 *
 * 只接受非空快照：编辑器已销毁或从未挂载时 `getState()` 返回 null，
 * 把 null 存进去会让下次挂载误以为「有快照可复用」，从而退回空状态。
 */
export function rememberState(handoff: ViewHandoff, absolutePath: string, state: unknown): void {
  if (!absolutePath || !state) return
  handoff.editorStates.set(absolutePath, state)
}

/** 取某文档的编辑器状态（没有则 null） */
export function stateOf(handoff: ViewHandoff, absolutePath: string): unknown | null {
  return handoff.editorStates.get(absolutePath) ?? null
}

/**
 * 保存成功后作废快照。
 *
 * 快照里的撤销栈还记着「保存前」的每一步：留着它，用户切走再切回来按 Ctrl+Z，
 * 会一路撤回**已经落盘的内容**，而界面上的脏标记又从「已保存」变成「未保存」
 * ——正是用户报的「切视图后有时变回未保存」。保存后重建撤销基线才是正确语义
 * （与所有编辑器一致：保存不切断撤销历史，但这里没有更细的粒度可用，
 * 宁可让撤销从当前内容重新起算，也不能让用户以为改动丢了又回来了）。
 */
export function invalidateState(handoff: ViewHandoff, absolutePath: string): void {
  if (!absolutePath) return
  handoff.editorStates.delete(absolutePath)
}

/** 关闭标签时释放（撤销栈没有跨会话保留的价值，留着只是内存泄漏） */
export function forgetDocument(handoff: ViewHandoff, absolutePath: string): void {
  handoff.editorStates.delete(absolutePath)
  handoff.anchor = null
}
