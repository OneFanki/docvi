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
import { sameDocumentPath } from './external-change.ts'

/** 编辑器能提供的两种「位置读数」：源行（跨视图可用）与像素（仅同视图内可用） */
export interface ViewPosition {
  /** 视口顶部的 0-based 源行 */
  topLine: number
  /** 滚动像素（仅同视图内有意义） */
  scrollTop: number
}

/** 待恢复的锚点：**绑定到具体文档**，不是全局游标 */
export interface ViewAnchor {
  /** 文档绝对路径（锚点只在它自己那篇重渲染时有效） */
  path: string
  /** 视口顶部的 0-based 源行 */
  line: number
}

/** 视图切换需要保管的两样东西 */
export interface ViewHandoff {
  /** 待恢复的锚点；null = 没有待恢复的锚点 */
  anchor: ViewAnchor | null
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
 *
 * ⚠️ 负数是「读不到源行」的哨兵（见 ReaderView.getTopLine）。**不能**用
 * `Math.max(0, …)` 把它压成 0：0 是合法坐标（用户在最顶部），压成 0 等于
 * 谎称「他当时看着开头」，恢复时会把文档拽回顶部。这是「切标签回顶」的最后
 * 一层成因——文件监视回调在阅读视图刚重新挂载、还没排版完时读位置，拿到 -1，
 * 被压成 0 存进锚点，随后 onRendered 拿它去 `scrollToSourceLine(0)`。
 *
 * ⚠️ 锚点必须带 `path`。曾经它是全局单槽：外部改动记下 A 的视口行，紧接着
 * 渲染的却是 B（切标签、连点两篇都会这样），于是 B 被滚到 A 的行号；反过来
 * B 在顶部时记下的 0 又会在切回 A 时把 A 拉回开头。2026-11-24 审查实测：
 * 长文滚到 900px，切走再切回，落点 0。
 */
export function leaveView(handoff: ViewHandoff, path: string, position: ViewPosition | null): void {
  if (!position || !path) {
    handoff.anchor = null
    return
  }
  const line = Math.round(position.topLine)
  handoff.anchor = line >= 0 ? { path, line } : null
}

/** 读锚点：只对锚点所属的那篇返回行号，别的文档视为「没有锚点」 */
function anchorLineOf(handoff: ViewHandoff, path: string): number | null {
  const anchor = handoff.anchor
  if (!anchor || !path) return null
  return sameDocumentPath(anchor.path, path) ? anchor.line : null
}

/**
 * 进入一个视图：取走锚点（**取完即清**）。
 *
 * 为什么必须清：视图渲染完成会多次触发「渲染完毕」回调（高亮、Mermaid、
 * 组件挂载各一次）。锚点若留着重放，后面的回调会把已经恢复正常滚动的页面
 * 又拽回锚点位置，表现为「滚不动 / 一直弹回去」。
 *
 * 只清自己那一篇的：另一篇的锚点还没被消费，不能顺手丢掉。
 */
export function takeAnchor(handoff: ViewHandoff, path: string): number | null {
  const line = anchorLineOf(handoff, path)
  if (line !== null) handoff.anchor = null
  return line
}

/**
 * 只读当前锚点（不消费）。
 *
 * 编辑器挂载时用这个：它在 `onMounted` 里读一次，「消费」的那一刻由宿主在
 * 编辑器报告已落位后调 `takeAnchor`。这样同一帧内多次重渲染不会被重复触发。
 */
export function peekAnchor(handoff: ViewHandoff, path: string): number | null {
  return anchorLineOf(handoff, path)
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
