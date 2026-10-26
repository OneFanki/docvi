/** 波形峰值：把任意长度的峰值数组重采样到目标长度（每个目标点取源区间最大值） */
export function resamplePeaks(peaks: number[], targetCount: number): number[] {
  if (!peaks.length || targetCount <= 0) return []
  const result: number[] = []
  for (let i = 0; i < targetCount; i++) {
    const start = Math.floor((i / targetCount) * peaks.length)
    const end = Math.max(start + 1, Math.ceil(((i + 1) / targetCount) * peaks.length))
    let max = 0
    for (let j = start; j < Math.min(end, peaks.length); j++) {
      if ((peaks[j] ?? 0) > max) max = peaks[j] ?? 0
    }
    result.push(Math.min(1, Math.max(0, max)))
  }
  return result
}
