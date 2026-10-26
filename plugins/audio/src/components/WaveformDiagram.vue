<script setup lang="ts">
/**
 * WaveformDiagram —— 时域波形教学图（静态 SVG）。
 *
 * 把「音频峰值包络」沉淀为一张静态教学图：对称柱状包络 + 中轴线 +
 * 可选时间刻度与播放头。与 AudioSpectrumDiagram（频域）互补，本图讲时域。
 *
 * 注意：数据由作者静态给定（0..1 峰值数组），不是实时音频。
 *
 * 用法（Markdown）：在页面 script setup 里定义 peaks / position，正文写：
 *
 * <WaveformDiagram title="波形包络" :peaks="peaks" :position="0.35" duration="3.2" />
 *
 * 数据协议见 ./types.ts（WaveformProps.peaks: number[]）。
 */
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    /** 峰值数组（0..1，按时间顺序；建议 60–240 个） */
    peaks: number[]
    /** 卡片标题（缺省「波形」） */
    title?: string
    /** 总时长（秒，可选：显示时间刻度） */
    duration?: number
    /** 播放头位置（0..1，可选：画一条竖线） */
    position?: number
  }>(),
  { title: '', duration: 0, position: -1 },
)

const PL = 10
const PR = 10
const MID = 84
const AMP = 64

const N = computed(() => props.peaks.length)

/** 第 i 个峰值的横坐标（柱中心） */
function peakX(i: number): number {
  return PL + ((i + 0.5) / N.value) * (640 - PL - PR)
}

/** 单柱宽（留 1px 缝） */
function barW(): number {
  return Math.max(0.8, (640 - PL - PR) / N.value - 1)
}

const hasDuration = computed(() => props.duration > 0)
const ticks = computed(() => {
  if (!hasDuration.value) return []
  const total = props.duration
  const step = total <= 2 ? 0.5 : total <= 8 ? 1 : Math.ceil(total / 8)
  const out: number[] = []
  for (let t = 0; t <= total + 1e-6; t += step) out.push(Number(t.toFixed(2)))
  return out
})

const headVisible = computed(() => props.position >= 0 && props.position <= 1)
</script>

<template>
  <section class="at-waveform">
    <header class="at-waveform__head">
      <span class="at-waveform__title">{{ title || '波形' }}</span>
      <span class="at-waveform__meta"
        >{{ N }} 点包络{{ hasDuration ? ` · ${duration}s` : '' }}</span
      >
    </header>
    <div class="at-waveform__stage">
      <svg
        v-if="N > 0"
        class="at-waveform__svg"
        viewBox="0 0 640 168"
        role="img"
        aria-label="音频波形包络教学示意图"
      >
        <rect
          v-for="(peak, i) in peaks"
          :key="i"
          class="at-waveform__bar"
          :x="peakX(i)"
          :y="MID - peak * AMP"
          :width="barW()"
          :height="peak * AMP * 2"
          rx="1"
        />
        <line class="at-waveform__axis" :x1="PL" :x2="640 - PR" :y1="MID" :y2="MID" />
        <g v-if="hasDuration">
          <template v-for="(t, i) in ticks" :key="i">
            <line
              class="at-waveform__tick"
              :x1="PL + (t / duration) * (640 - PL - PR)"
              :x2="PL + (t / duration) * (640 - PL - PR)"
              :y1="MID + AMP + 6"
              :y2="MID + AMP + 10"
            />
            <text
              class="at-waveform__tick-text"
              :x="PL + (t / duration) * (640 - PL - PR)"
              :y="MID + AMP + 22"
              text-anchor="middle"
            >
              {{ t }}s
            </text>
          </template>
        </g>
        <line
          v-if="headVisible"
          class="at-waveform__head-line"
          :x1="PL + position * (640 - PL - PR)"
          :x2="PL + position * (640 - PL - PR)"
          :y1="MID - AMP - 6"
          :y2="MID + AMP + 6"
        />
      </svg>
      <p v-else class="at-waveform__empty">（未提供 peaks 数据）</p>
      <div v-if="N > 0" class="at-waveform__legend">
        <span v-if="headVisible" class="at-waveform__chip at-waveform__chip-accent"
          >播放头 {{ Math.round(position * 100) }}%</span
        >
        <span class="at-waveform__chip">对称包络 · 中轴 0</span>
      </div>
    </div>
  </section>
</template>

<style scoped>
.at-waveform {
  margin: 1rem 0;
  border: 1px solid var(--at-border);
  border-radius: var(--at-radius-lg);
  background: var(--at-surface);
}

.at-waveform__head {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.5rem 0.9rem;
  border-bottom: 1px solid var(--at-border);
}

.at-waveform__title {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--at-text-muted);
  letter-spacing: 0.02em;
}

.at-waveform__meta {
  margin-left: auto;
  color: var(--at-text-muted);
  font-size: 0.76rem;
  font-variant-numeric: tabular-nums;
}

.at-waveform__stage {
  padding: 0.7rem 0.95rem 0.75rem;
}

.at-waveform__svg {
  display: block;
  width: 100%;
  height: auto;
}

.at-waveform__bar {
  fill: var(--at-accent);
}

.at-waveform__axis {
  stroke: var(--at-border-strong);
  stroke-width: 1;
}

.at-waveform__tick {
  stroke: var(--at-border-strong);
  stroke-width: 1;
}

.at-waveform__tick-text {
  fill: var(--at-text-muted);
  font-family: var(--at-font-mono);
  font-size: 10px;
}

.at-waveform__head-line {
  stroke: var(--at-warn);
  stroke-width: 2;
  stroke-linecap: round;
}

.at-waveform__empty {
  margin: 0 !important;
  padding: 2rem 0;
  text-align: center;
  color: var(--at-text-muted);
  font-size: 0.85rem;
}

.at-waveform__legend {
  display: flex;
  flex-wrap: wrap;
  gap: 0.45rem;
  margin-top: 0.5rem;
}

.at-waveform__chip {
  padding: 0.2rem 0.6rem;
  border-radius: 999px;
  background: var(--at-surface-2);
  color: var(--at-text-muted);
  font-size: 0.76rem;
  font-variant-numeric: tabular-nums;
}

.at-waveform__chip-accent {
  background: color-mix(in srgb, var(--at-warn) 14%, transparent);
  color: var(--at-warn);
}
</style>
