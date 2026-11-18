/**
 * 性能埋点落盘（主进程侧）。
 *
 * ## 三条硬约束（用户明确要求）
 *
 *  1. **不能一直写盘**。用户会疑惑「怎么一直在写东西」。所以这个模块**不主动
 *     写任何东西**：只有渲染层判定「这次真卡了」并推过来时才触发一次写入。
 *     没有定时器、没有后台心跳。
 *  2. **大小有硬上限**。文件最大 `PERF_FILE_MAX_BYTES`（128KB），内存里最多
 *     `PERF_KEPT_LIMIT` 条。越界从**最旧的一端**丢——诊断卡顿要看最近发生了什么，
 *     昨天的记录没有价值。
 *  3. **写盘要合并**。同一次卡顿可能连续推几十条（一帧里多个长任务），若每条
 *     都写一次盘，用户会在几秒内看到几十次磁盘活动。所以攒到一个短窗口再写一次。
 *
 * ## 文件位置
 *
 * `<dataDir>/cache/perf.json`。放 `cache/` 而不是数据根：这是可随时删除的
 * 运行现场，不是需要备份的用户数据；用户清理缓存目录不会丢任何东西。
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

import {
  PERF_FILE_MAX_BYTES,
  PERF_KEPT_LIMIT,
  mergeBounded,
  normalizeSample,
  trimToBytes,
  type PerfSample,
} from '@docvi/shared'

import { atomicWriteText } from '../../../../packages/server/src/fs-atomic.mjs'

import { perfFile } from './paths.ts'

/**
 * 内存镜像：已落盘的记录常驻这里。
 *
 * 为什么要在内存里留一份：写盘要合并（见上），合并后的结果需要与历史
 * 拼接再裁剪。每次写盘前把文件读回来重解析，比留一份内存镜像贵得多。
 */
let history: PerfSample[] | null = null

/** 攒批写入的窗口。200ms 足够把一次卡顿的连发记录并成一笔，又不至于丢失现场 */
const FLUSH_DELAY_MS = 200

let pending: PerfSample[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 首次访问时读盘。文件不存在 / 损坏 / 结构不对都当作空历史——
 * 埋点数据损坏绝不能让应用报错，它本来就是可选诊断信息。
 */
function loadHistory(): PerfSample[] {
  if (history) return history
  try {
    const path = perfFile()
    if (!existsSync(path)) {
      history = []
      return history
    }
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!Array.isArray(parsed)) {
      history = []
      return history
    }
    // 逐条重新规范化：文件可能是旧版本写的，字段集合不一定与当前契约一致
    history = parsed
      .filter((item): item is PerfSample => Boolean(item) && typeof item === 'object')
      .map(item => normalizeSample(item))
    history = mergeBounded([], history, PERF_KEPT_LIMIT)
  } catch {
    history = []
  }
  return history
}

/**
 * 把攒下的记录并进历史并落盘。
 *
 * 失败只吞掉：埋点是诊断手段，它写不进去不能影响用户正在做的事。
 * 但内存里的历史要保留——下一次上报还能再试。
 */
function flush(): void {
  flushTimer = null
  if (pending.length === 0) return
  const incoming = pending
  pending = []
  const merged = mergeBounded(loadHistory(), incoming.map(normalizeSample), PERF_KEPT_LIMIT)
  // 按字节预算再裁一轮：条数在上限内也可能因为 detail 太多而超字节
  const kept = trimToBytes(merged, PERF_FILE_MAX_BYTES)
  history = kept
  try {
    const path = perfFile()
    mkdirSync(dirname(path), { recursive: true })
    atomicWriteText(path, `${JSON.stringify(kept, null, 0)}\n`)
  } catch (error) {
    console.warn('[perf] 埋点写入失败（不影响使用）:', error)
  }
}

/**
 * 接收一批采样。
 *
 * 调用方是 IPC handler，已经做过类型校验；这里只再做一次兜底规范化。
 */
export function reportPerfSamples(samples: PerfSample[]): void {
  if (!Array.isArray(samples) || samples.length === 0) return
  for (const sample of samples.slice(0, 50)) {
    pending.push(normalizeSample(sample))
  }
  /*
   * 攒批窗口。已在等待中就不重置——用固定窗口而不是防抖：
   * 持续卡顿时防抖会一直推迟，反而永远不落盘。
   */
  if (flushTimer) return
  flushTimer = setTimeout(flush, FLUSH_DELAY_MS)
}

/** 退出前把还没落盘的记录写出去（App 的 before-quit 调用） */
export function flushPerfSamples(): void {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  flush()
}
