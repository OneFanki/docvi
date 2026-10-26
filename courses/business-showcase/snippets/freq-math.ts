// ===== 坐标 ↔ 频率（对数轴互逆映射）=====

export function freqToX(
  freq: number,
  width: number,
  minFreq: number,
  maxFreq: number,
): number {
  const f = Math.max(freq, 1)              // 防 log(0)
  const logMin = Math.log10(minFreq)
  const logMax = Math.log10(maxFreq)
  return ((Math.log10(f) - logMin) / (logMax - logMin)) * width
}

export function xToFreq(
  x: number,
  width: number,
  minFreq: number,
  maxFreq: number,
): number {
  const t = Math.min(1, Math.max(0, x / width))   // 钳制到 [0, 1]
  const logMin = Math.log10(minFreq)
  const logMax = Math.log10(maxFreq)
  return Math.pow(10, logMin + (logMax - logMin) * t)
}
