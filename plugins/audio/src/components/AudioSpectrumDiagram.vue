<script setup lang="ts">
/**
 * AudioSpectrumDiagram —— AnalyserNode / bin / 对数像素 / 峰值引擎教学图。
 *
 * 把真实频谱引擎的「bin 电平 → 对数频率轴 → 选中频段 → 峰值保持」沉淀为一张
 * 静态教学 SVG：横轴是对数频率刻度（人耳感知），柱子按 bin 均匀排布但频率标注
 * 按对数映射——正好呈现「对数像素」的换算直觉；可叠加选中频段覆盖层与峰值保持线。
 *
 * 注意：这是「教学示意图」，数据由教程作者静态给定（0..1 电平），不是实时音频。
 *
 * 用法（Markdown）：在页面顶部的 script setup 块里定义 bins / scale / band / peak，
 * 正文写：
 *
 * <AudioSpectrumDiagram
 *   title="频谱引擎：bin → 对数像素"
 *   :bins="bins" :frequency-scale="scale" :selected-band="band" :peak-state="peak"
 * />
 *
 * 数据协议见 types.ts：
 *   bins:     SpectrumBin[] = { value?, peak?, label? }
 *   frequency-scale: SpectrumScale = { mode: 'log'|'linear', min?, max?, ticks? }
 *   selected-band:   SpectrumBand = { start, end, label? }
 *   peak-state:      SpectrumPeak = { enabled?, decayPerSec? }
 */
import { computed } from 'vue'
import type { SpectrumBand, SpectrumBin, SpectrumPeak, SpectrumScale } from './types'

const props = withDefaults(
  defineProps<{
    /** 卡片标题（缺省「频谱分析」） */
    title?: string
    /** 各 bin 电平（0..1；可选 peak 高度） */
    bins: SpectrumBin[]
    /** 频率刻度配置（缺省 20–20k Hz 对数） */
    frequencyScale?: SpectrumScale
    /** 选中频段（可选覆盖层） */
    selectedBand?: SpectrumBand
    /** 峰值引擎状态（可选） */
    peakState?: SpectrumPeak
  }>(),
  {
    frequencyScale: () => ({ mode: 'log' as const, min: 20, max: 20000 }),
    selectedBand: undefined,
    peakState: undefined,
  },
)

const N = computed(() => props.bins.length)

/** 画布几何（viewBox 640 × 196） */
const PL = 10
const PR = 10
const PT = 18
const PB = 148
const plotW = 640 - PL - PR
const plotH = PB - PT

const MIN = props.frequencyScale?.min ?? 20
const MAX = props.frequencyScale?.max ?? 20000
const LOG_TICKS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]

const ticks = computed<number[]>(() => {
  if (props.frequencyScale?.ticks?.length) return props.frequencyScale.ticks
  if (props.frequencyScale?.mode === 'linear') {
    const out: number[] = []
    for (let i = 0; i <= 6; i += 1) out.push(MIN + (i / 6) * (MAX - MIN))
    return out
  }
  return LOG_TICKS
})

/** 频率 → 横坐标（log 用 ln 比、linear 线性插值） */
function freqToX(f: number): number {
  if (props.frequencyScale?.mode === 'linear') {
    return PL + ((f - MIN) / (MAX - MIN)) * plotW
  }
  return PL + (Math.log(f / MIN) / Math.log(MAX / MIN)) * plotW
}

/** bin i 的左缘横坐标（柱按 bin 均匀排布） */
function binX(i: number): number {
  return PL + (i / N.value) * plotW
}

/** 单柱宽（留 1px 缝） */
function barW(): number {
  return Math.max(1, plotW / N.value - 1)
}

/** 电平值（0..1）→ 柱顶纵坐标 */
function valueY(v: number | undefined): number {
  return PB - Math.max(0, Math.min(1, v ?? 0)) * plotH
}

/** 频率刻度数字：1000 起显示为 xk */
function fmt(f: number): string {
  return f >= 1000 ? `${Math.round(f / 1000)}k` : `${Math.round(f)}`
}

/** 选中频段几何（用于覆盖层与柱体暗化） */
const bandGeom = computed(() => {
  const b = props.selectedBand
  if (!b || N.value === 0) return null
  const start = Math.max(0, Math.min(N.value - 1, b.start))
  const end = Math.max(start, Math.min(N.value - 1, b.end))
  const x = binX(start)
  const w = binX(end + 1) - x
  return { x0: x, w, cx: x + w / 2, start, end, label: b.label ?? `bin ${start}–${end}` }
})

/** bin i 是否落在选中频段之外（在外则暗化） */
function isDim(i: number): boolean {
  const g = bandGeom.value
  if (!g) return false
  return i < g.start || i > g.end
}

const peakEnabled = computed(() => Boolean(props.peakState?.enabled))
</script>

<template>
  <section class="at-spectrum">
    <header class="at-spectrum__head">
      <svg
        viewBox="0 0 24 24"
        width="15"
        height="15"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M3 17V6" />
        <path d="M7 17V9" />
        <path d="M11 17V4" />
        <path d="M15 17v-6" />
        <path d="M19 17v-3" />
        <path d="M3 17h18" />
      </svg>
      {{ title || '频谱分析' }}
    </header>

    <div class="at-spectrum__stage">
      <svg
        v-if="N > 0"
        class="at-spectrum__svg"
        viewBox="0 0 640 196"
        role="img"
        aria-label="频谱教学示意图：bin 电平柱 + 对数频率刻度 + 峰值保持"
      >
        <rect
          v-if="bandGeom"
          class="at-spectrum__band"
          :x="bandGeom.x0"
          :y="PT"
          :width="bandGeom.w"
          :height="plotH"
          rx="2"
        />
        <text
          v-if="bandGeom"
          class="at-spectrum__band-label"
          :x="bandGeom.cx"
          :y="PT - 5"
          text-anchor="middle"
        >
          {{ bandGeom.label }}
        </text>

        <rect
          v-for="(b, i) in bins"
          :key="i"
          class="at-spectrum__bar"
          :class="{ 'is-dim': isDim(i) }"
          :x="binX(i)"
          :y="valueY(b.value)"
          :width="barW()"
          :height="PB - valueY(b.value)"
          rx="1"
        />

        <g v-if="peakEnabled">
          <line
            v-for="(b, i) in bins"
            :key="`p${i}`"
            class="at-spectrum__peak"
            :x1="binX(i) + 1"
            :x2="binX(i) + barW() - 1"
            :y1="valueY(b.peak)"
            :y2="valueY(b.peak)"
          />
        </g>

        <line class="at-spectrum__axis" :x1="PL" :x2="640 - PR" :y1="PB" :y2="PB" />
        <g v-for="(t, i) in ticks" :key="i">
          <line class="at-spectrum__tick" :x1="freqToX(t)" :x2="freqToX(t)" :y1="PB" :y2="PB + 4" />
          <text class="at-spectrum__tick-text" :x="freqToX(t)" :y="PB + 16" text-anchor="middle">
            {{ fmt(t) }}
          </text>
        </g>
      </svg>

      <p v-else class="at-spectrum__empty">（未提供 bins 数据）</p>

      <div class="at-spectrum__legend">
        <span v-if="N > 0" class="at-spectrum__meta"
          >{{ N }} bins · {{ fmt(MIN) }}–{{ fmt(MAX) }} Hz ·
          {{ frequencyScale?.mode === 'linear' ? '线性' : '对数' }}轴</span
        >
        <span v-if="bandGeom" class="at-spectrum__meta at-spectrum__meta-band"
          >选中 {{ bandGeom.label }}</span
        >
        <span v-if="peakEnabled" class="at-spectrum__meta at-spectrum__meta-peak"
          >峰值保持{{
            peakState?.decayPerSec != null ? ` ${peakState.decayPerSec} dB/s` : ''
          }}</span
        >
      </div>
    </div>
  </section>
</template>

<style scoped>
.at-spectrum {
  margin: 1rem 0;
  border: 1px solid var(--at-border);
  border-radius: var(--at-radius-lg);
  background: var(--at-surface);
}

.at-spectrum__head {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.6rem 0.9rem;
  border-bottom: 1px solid var(--at-border);
  color: var(--at-text-muted);
  font-size: 0.8rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  text-transform: uppercase;
}

.at-spectrum__stage {
  padding: 0.85rem 0.95rem 0.8rem;
}

.at-spectrum__svg {
  display: block;
  width: 100%;
  height: auto;
}

.at-spectrum__band {
  fill: var(--at-accent-soft);
}

.at-spectrum__band-label {
  fill: var(--at-accent-strong);
  font-size: 11px;
  font-weight: 600;
}

.at-spectrum__bar {
  fill: var(--at-accent);
}

.at-spectrum__bar.is-dim {
  fill: color-mix(in srgb, var(--at-accent) 26%, transparent);
}

.at-spectrum__peak {
  stroke: var(--at-accent-strong);
  stroke-width: 2;
  stroke-linecap: round;
}

.at-spectrum__axis,
.at-spectrum__tick {
  stroke: var(--at-border-strong);
  stroke-width: 1;
}

.at-spectrum__tick-text {
  fill: var(--at-text-muted);
  font-family: var(--at-font-mono);
  font-size: 10px;
}

.at-spectrum__empty {
  margin: 0 !important;
  padding: 2rem 0;
  text-align: center;
  color: var(--at-text-muted);
  font-size: 0.85rem;
}

.at-spectrum__legend {
  display: flex;
  flex-wrap: wrap;
  gap: 0.45rem;
  margin-top: 0.6rem;
}

.at-spectrum__meta {
  padding: 0.2rem 0.6rem;
  border-radius: 999px;
  background: var(--at-surface-2);
  color: var(--at-text-muted);
  font-size: 0.76rem;
  font-variant-numeric: tabular-nums;
}

.at-spectrum__meta-band {
  background: color-mix(in srgb, var(--at-accent) 12%, transparent);
  color: var(--at-accent-strong);
}

.at-spectrum__meta-peak {
  background: color-mix(in srgb, var(--at-warn) 14%, transparent);
  color: var(--at-warn);
}
</style>
