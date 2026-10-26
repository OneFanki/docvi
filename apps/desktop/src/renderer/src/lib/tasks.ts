import { reactive } from 'vue'

/**
 * 后台任务进度（底栏显示）。
 *
 * 为什么需要它：索引构建、仓库同步这类长任务此前是**阻塞式**的——打开工作区
 * 要等整库读完，期间界面没有任何反馈，用户点完就以为「没反应」。做进度显示
 * 的前提是任务本身不阻塞打开：先给树与首篇文档，索引在后台补。
 *
 * 设计取舍：
 * - **单任务槽位**：同一时刻只展示一件后台任务。多个任务并行时抢同一块底栏
 *   会变成滚动字幕，反而看不出在做什么；后来的任务接手槽位，先前的任务
 *   继续跑完但不再占据显示（用 key 判断归属，不会互相改状态）。
 * - **不进 store**：纯展示状态，与会话恢复、持久化都无关，用 `reactive`
 *   单例即可，不必为一个进度条引入 Pinia store。
 * - **可取消**：索引是纯计算，取消 = 丢弃结果；由任务在检查点自行感知。
 */

export interface TaskProgress {
  /** 任务标识：`index:<workspaceId>` 之类，用于判断「槽位还是不是自己的」 */
  key: string
  /** 展示文案（已 i18n） */
  label: string
  /** 0–1；null = 不确定进度（底栏显示活动态） */
  ratio: number | null
  /** 细节：如「第 3/8 个仓库」 */
  detail?: string
}

export interface TaskHandle {
  /** 更新进度；`done: true` 收尾（清空槽位并显示完成提示） */
  update(next: Partial<Omit<TaskProgress, 'key'>> & { done?: boolean }): void
  /** 任务是否已被用户取消（长循环里逐段检查） */
  isCancelled(): boolean
}

interface TaskState {
  current: TaskProgress | null
  /** 最近完成的任务（短暂保留，避免进度条「闪一下就没了」） */
  finished: { label: string; at: number } | null
  cancel: (() => void) | null
}

export const taskState = reactive<TaskState>({
  current: null,
  finished: null,
  cancel: null,
})

/** 完成提示保留时长：够看清一行字，又不至于长期占着底栏 */
const FINISHED_TTL = 4000
let finishedTimer: ReturnType<typeof setTimeout> | null = null

export function startTask(
  progress: TaskProgress,
  options: { cancellable?: boolean } = {},
): TaskHandle {
  let cancelled = false
  taskState.current = { ...progress }
  taskState.finished = null
  if (finishedTimer) {
    clearTimeout(finishedTimer)
    finishedTimer = null
  }
  taskState.cancel = options.cancellable
    ? () => {
        cancelled = true
      }
    : null

  return {
    update(next) {
      if (next.done) {
        // 只收自己的尾：槽位已被后来的任务接手时不动它
        if (taskState.current?.key !== progress.key) return
        taskState.current = null
        taskState.cancel = null
        if (cancelled) return
        taskState.finished = { label: progress.label, at: Date.now() }
        finishedTimer = setTimeout(() => {
          taskState.finished = null
          finishedTimer = null
        }, FINISHED_TTL)
        return
      }
      if (taskState.current?.key !== progress.key) return
      taskState.current = { ...taskState.current, ...next, key: progress.key }
    },
    isCancelled: () => cancelled,
  }
}

/** 手动结束（异常路径，不显示完成提示） */
export function clearTask(key: string): void {
  if (taskState.current?.key !== key) return
  taskState.current = null
  taskState.cancel = null
}
