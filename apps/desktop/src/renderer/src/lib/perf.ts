/**
 * 编辑器性能埋点（渲染层）。
 *
 * ## 设计：默认关闭 + 只在卡顿时上报
 *
 * 用户明确要求「不要因为这个疯狂写盘，用户会疑惑怎么一直在写东西」。
 * 所以这里做两层收敛：
 *
 *  1. **默认不采集**。设置项 `perfTracing` 默认 `false`；关闭时这个模块
 *     连 PerformanceObserver 都不建，运行时开销严格为零。
 *  2. **采集了也不常写盘**。开启后，采样先进内存环形缓冲；
 *     只有**触发阈值**的那一条（以及它前后几条现场）才会推给主进程，
 *     由主进程做 200ms 攒批后写一次。
 *
 * 净效果：开着埋点时，一次正常使用可能一条都不会写；只有真卡了才留痕。
 *
 * ## 为什么不直接用 PerformanceObserver 的 longtask 就够
 *
 * longtask 只覆盖「主线程被占满」，捕捉不到「渲染完了但很慢」这类
 * 用户同样会抱怨的情况（比如 1351 块的文档切视图要 100ms）。所以除了
 * longtask，还显式计时几个关键路径（视图切换、文档渲染）。
 */
import {
  PERF_BUFFER_LIMIT,
  PERF_LONG_TASK_MS,
  PERF_SLOW_OP_MS,
  normalizeSample,
  pushBounded,
  type PerfKind,
  type PerfSample,
} from '@docvi/shared'

/** 内存环形缓冲：即使不触发上报，也能在用户手动导出时拿到最近现场 */
const buffer: PerfSample[] = []

let enabled = false
let observer: PerformanceObserver | null = null
/** 一次 flush 最多带多少条：防止长时间卡顿后一次推几百条 */
const FLUSH_BATCH = 40

/**
 * 已上报过的记录（用引用相等判断，不占内存不占序列化）。
 *
 * 声明位置在 flushPending 之前——函数提升能拿到，但先写在这里读起来更顺。
 */
const reported = new WeakSet<PerfSample>()

/**
 * 把「本次会话还没上报过」的记录推给主进程。
 *
 * 只推一次：推过的会打标记。这样同一个卡顿不会因为后续调用被重复上报，
 * 主进程也不必做去重。
 */
function flushPending(): void {
  if (!enabled) return
  const fresh = buffer.filter(sample => !reported.has(sample))
  if (fresh.length === 0) return
  for (const sample of fresh) reported.add(sample)
  // 只推最新的若干条：更旧的现场对诊断帮助有限，反而撑爆 IPC 消息
  const batch = fresh.slice(-FLUSH_BATCH).map(normalizeSample)
  void window.docvi.perfReport(batch).catch(() => {
    /*
     * 上报失败不重试：埋点是诊断手段，不能因为它失败而反复占用主线程。
     * 记录本身已经留在内存缓冲里，用户在设置里手动导出时还能拿到。
     */
  })
}

/**
 * 记一条采样。
 *
 * 无论是否上报，都会进环形缓冲——这样手动导出能看到阈值以下的记录，
 * 判断「是不是普遍偏慢」时有用。
 */
export function recordPerf(
  kind: PerfKind,
  ms: number,
  scene: string,
  detail?: Record<string, number | string>,
): void {
  if (!enabled) return
  const sample: PerfSample = {
    at: Date.now(),
    kind,
    ms: Math.round(ms),
    scene,
    ...(detail ? { detail } : {}),
  }
  pushBounded(buffer, sample, PERF_BUFFER_LIMIT)

  const threshold = kind === 'longtask' ? PERF_LONG_TASK_MS : PERF_SLOW_OP_MS
  if (ms >= threshold) flushPending()
}

/**
 * 计时包装：返回的函数调用时记一条。
 *
 * 用法：
 * ```ts
 * const done = startPerfTimer('switch', 'switch:read')
 * // ... 做完
 * done()
 * ```
 *
 * `detail` 传函数而不是对象：它是收尾时才求值的，可以读那时才存在的状态
 * （如已挂载的 DOM 规模）。
 */
export function startPerfTimer(
  kind: PerfKind,
  scene: string,
  detail?: () => Record<string, number | string>,
): () => void {
  if (!enabled) return () => {}
  const started = performance.now()
  return () => {
    recordPerf(kind, performance.now() - started, scene, detail?.())
  }
}

/**
 * 打开/关闭采集。
 *
 * 由设置项驱动。关闭时必须断开 observer 并清空缓冲——否则用户关掉开关后
 * 内存里还留着一批采样，下次打开会看到「关闭期间」根本不存在的旧数据。
 */
export function setPerfTracing(value: boolean): void {
  if (value === enabled) return
  enabled = value
  if (!enabled) {
    observer?.disconnect()
    observer = null
    buffer.length = 0
    return
  }
  try {
    observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        recordPerf('longtask', entry.duration, 'longtask', {
          start: Math.round(entry.startTime),
        })
      }
    })
    observer.observe({ entryTypes: ['longtask'] })
  } catch {
    /*
     * 不支持 longtask 的环境（旧内核 / 某些平台）不该让整个功能失效：
     * 显式计时的那几条（switch / render）仍然工作。
     */
    observer = null
  }
}
