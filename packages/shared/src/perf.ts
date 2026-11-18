/**
 * 编辑器性能埋点（渲染层采样 → 主进程落盘）。
 *
 * ## 为什么不是「一直记日志」
 *
 * 性能数据的价值只在**出问题时**才兑现：用户说「卡」，我们要能立刻拿出
 * 那一刻的现场。平时持续写盘除了制造磁盘噪音、让用户疑惑「这东西一直在写
 * 什么」，没有任何用途。所以：

 *  - **采集在内存里**：环形缓冲，固定容量，不触盘；
 *  - **只在真有卡顿时上报**：长任务（>50ms）或掉帧超阈值才发一次；
 *  - **落盘有硬上限**：主进程再套一层环形缓冲 + 字节上限，越界即丢最旧的。
 *
 * 净效果：一次会话内绝大多数时间磁盘是安静的；真卡了才有几条记录。
 *
 * ## 为什么上限写在共享层
 *
 * 渲染层的缓冲容量与主进程的保留条数必须**同源**。两处各写一个数字，
 * 早晚会漂移成「渲染层攒 200 条、主进程只留 50 条」，白费采集中间那段。
 */

/** 单条采样能带的最大文本长度：防止超长文档标题把一条记录撑成几十 KB */
export const PERF_TEXT_MAX = 120

/** 渲染层内存缓冲的条数上限（约 8KB 量级） */
export const PERF_BUFFER_LIMIT = 200

/** 主进程保留的条数上限 */
export const PERF_KEPT_LIMIT = 500

/** 落盘文件的字节上限（超过就按条数比例裁剪最旧的） */
export const PERF_FILE_MAX_BYTES = 128 * 1024

/**
 * 判定「这次值得上报」的长任务阈值（毫秒）。
 *
 * 50ms 是 Chrome 的 long task 口径：一帧 16.7ms，超过 3 帧的主线程阻塞
 * 人就能感觉到。低于这个值记下来只会淹没真问题。
 */
export const PERF_LONG_TASK_MS = 50

/** 一次切换 / 渲染超过这个时长就上报：它比单次长任务更能反映「点了没反应」 */
export const PERF_SLOW_OP_MS = 200

/** 埋点的种类。字符串而非枚举：落盘后要能人工读懂 */
export type PerfKind =
  /** 主线程长任务（PerformanceObserver longtask） */
  | 'longtask'
  /** 一次文档渲染 / 视图切换 */
  | 'render'
  /** 一次视图切换（阅读 ↔ 预览 ↔ 源码 ↔ 分屏） */
  | 'switch'
  /** 一次输入造成的主线程阻塞 */
  | 'input'

/**
 * 一条采样记录。
 *
 * 字段刻意压到最少：每条都要能写进 128KB 的预算里，多余的字段
 * （UA、GPU、屏幕分辨率）在应用版本固定时没有区分度。
 */
export interface PerfSample {
  /** 采集时刻（epoch ms） */
  at: number
  kind: PerfKind
  /** 这次操作/任务持续了多久 */
  ms: number
  /** 场景标识，如 `switch:read`、`render:451blocks` */
  scene: string
  /**
   * 补充信息。**不能放路径**——埋点文件可能被用户贴到 issue 里，
   * 绝对路径会泄露本机目录结构。只放规模、模式这类中性量。
   */
  detail?: Record<string, number | string>
}

/** 截断过长文本，避免单条记录被超长标题撑爆 */
export function clampText(value: string, max = PERF_TEXT_MAX): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

/**
 * 把一条采样压成定长摘要（去掉可变长字段）。
 *
 * 主进程用它做最后一道防线：即使渲染层发来超长 detail，落盘前也一定被削平。
 * detail 最多保留 6 个键，值只允许数字或短字符串——防止被塞进整篇文档。
 */
export function normalizeSample(raw: PerfSample): PerfSample {
  const detail: Record<string, number | string> = {}
  if (raw.detail) {
    for (const [key, value] of Object.entries(raw.detail).slice(0, 6)) {
      const safeKey = clampText(key, 24)
      if (typeof value === 'number') {
        // 非有限数（NaN / Infinity）会让 JSON 序列化出 null，统一归零
        detail[safeKey] = Number.isFinite(value) ? Math.round(value * 10) / 10 : 0
      } else {
        detail[safeKey] = clampText(String(value), 40)
      }
    }
  }
  const sample: PerfSample = {
    at: Number.isFinite(raw.at) ? Math.round(raw.at) : 0,
    kind: raw.kind,
    ms: Number.isFinite(raw.ms) ? Math.round(raw.ms) : 0,
    scene: clampText(String(raw.scene), 60),
  }
  if (Object.keys(detail).length > 0) sample.detail = detail
  return sample
}

/**
 * 往环形缓冲里追加，超出上限就丢最旧的。
 *
 * 用 `splice(0, overflow)` 而不是维护读写下标：条数上限只有几百，
 * 每次多一次数组搬移可以忽略，换来的是「数组永远就是当前全部内容」这一
 * 简单不变量——不会出现「下标绕了圈但忘了清旧值」的经典环形缓冲 bug。
 */
export function pushBounded<T>(buffer: T[], item: T, limit: number): void {
  buffer.push(item)
  if (buffer.length > limit) buffer.splice(0, buffer.length - limit)
}

/**
 * 合并历史与新增，再按上限裁剪。
 *
 * `incoming` 在后（更新的在后），结果保留最新的 `limit` 条。
 */
export function mergeBounded<T>(history: readonly T[], incoming: readonly T[], limit: number): T[] {
  if (limit <= 0) return []
  const combined = [...history, ...incoming]
  return combined.length <= limit ? combined : combined.slice(combined.length - limit)
}

/**
 * 按字节预算裁剪：从**最旧的一端**开始丢，直到序列化后不超过上限。
 *
 * 为什么要真序列化一次而不是估算：`JSON.stringify` 才是最终写进文件的东西，
 * 用字段数乘常数估出来的大小在中文 detail 上会偏小一半。这里只在落盘前调用
 * 一次，成本可接受。
 */
export function trimToBytes<T>(
  items: readonly T[],
  maxBytes: number,
  serialize: (items: T[]) => string = items => JSON.stringify(items),
): T[] {
  if (items.length === 0) return []
  let kept = [...items]
  // 二分不掉的原因：每次至少丢 1 条，最多 items.length 次，循环必然终止
  while (kept.length > 1 && serialize(kept).length > maxBytes) {
    // 丢掉大约 1/8，既快又不会丢掉过多
    const drop = Math.max(1, Math.floor(kept.length / 8))
    kept = kept.slice(drop)
  }
  return kept.length === 1 && serialize(kept).length > maxBytes ? [] : kept
}
