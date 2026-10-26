<script setup lang="ts">
/**
 * PianoRoll —— 音符卷帘教学图（静态 SVG）。
 *
 * 把「MIDI 音符序列」画成钢琴卷帘：纵轴为音高（白键/黑键行交替 + 左侧音名），
 * 横轴为拍；每个音符 = 一条矩形（velocity 决定不透明度）。
 *
 * 注意：数据由作者静态给定，不是实时编曲界面。
 *
 * 用法（Markdown）：在页面 script setup 里定义 notes，正文写：
 *
 * <PianoRoll title="鼓组片段" :notes="notes" :beats="8" />
 *
 * 数据协议见 ./types.ts：
 *   PianoNote = { pitch: number（MIDI） | string（科学音名如 'C4'）, start: number（拍）, length: number（拍）, velocity?, label? }
 *   音高范围自动按 notes 计算（含上下留 1 键）。
 */
import { computed } from 'vue'
import type { PianoNote } from './types'

const props = withDefaults(
  defineProps<{
    /** 音符序列 */
    notes: PianoNote[]
    /** 卡片标题（缺省「钢琴卷帘」） */
    title?: string
    /** 总拍数（缺省按最后一个音符自动） */
    beats?: number
    /** 每小节拍数（缺省 4：加粗小节线并高亮第一拍） */
    beatsPerBar?: number
  }>(),
  { title: '', beats: 0, beatsPerBar: 4 },
)

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

/** 音名 ↔ MIDI（'C4' = 60 标准） */
function nameToMidi(name: string): number {
  const match = name.trim().match(/^([A-Ga-g])(#|b)?(-?\d+)$/)
  if (!match) return 60
  const letter = match[1] ?? 'C'
  const accidental = match[2]
  const base = NAMES.indexOf(letter.toUpperCase())
  const delta = accidental === '#' ? 1 : accidental === 'b' ? -1 : 0
  return (Number(match[3] ?? 4) + 1) * 12 + base + delta
}

function toMidi(pitch: number | string): number {
  return typeof pitch === 'number' ? pitch : nameToMidi(pitch)
}

function midiName(midi: number): string {
  return `${NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`
}

const resolved = computed(() =>
  props.notes
    .map(note => ({
      midi: toMidi(note.pitch),
      start: note.start,
      length: Math.max(note.length, 0.12),
      velocity: note.velocity ?? 0.8,
      label: note.label,
    }))
    .sort((a, b) => a.midi - b.midi),
)

const totalBeats = computed(() => {
  if (props.beats > 0) return props.beats
  return Math.max(...resolved.value.map(n => n.start + n.length), 1)
})

const PAD = 1
const lowest = computed(() => Math.min(...resolved.value.map(n => n.midi), 60) - PAD)
const highest = computed(() => Math.max(...resolved.value.map(n => n.midi), 72) + PAD)
const rows = computed(() => highest.value - lowest.value + 1)

/** 布局：左侧 34px 音名列 + 右侧网格 */
const LABEL_W = 34
const PLOT_W = 640 - LABEL_W - 10
const ROW_H = computed(() => Math.min(18, Math.max(9, 300 / rows.value)))
const plotH = computed(() => rows.value * ROW_H.value)

function yOf(midi: number): number {
  return (highest.value - midi) * ROW_H.value
}

function xOf(beat: number): number {
  return LABEL_W + (beat / totalBeats.value) * PLOT_W
}

function isBlack(midi: number): boolean {
  return (NAMES[((midi % 12) + 12) % 12] ?? '').includes('#')
}

/** 显示哪些音名：白键 + 每 12 键的 C 特殊强调 */
function labelOf(midi: number): string {
  return isBlack(midi) ? '' : midiName(midi)
}

const beatLines = computed(() => {
  const out: number[] = []
  for (let beat = 0; beat <= totalBeats.value + 1e-6; beat += 1) out.push(Number(beat.toFixed(2)))
  return out
})

const svgHeight = computed(() => plotH.value + 24)
</script>

<template>
  <section class="at-pianoroll">
    <header class="at-pianoroll__head">
      <span class="at-pianoroll__title">{{ title || '钢琴卷帘' }}</span>
      <span class="at-pianoroll__meta"
        >{{ resolved.length }} 音符 · {{ totalBeats }} 拍{{
          beatsPerBar > 1 ? ` · ${beatsPerBar}/4` : ''
        }}</span
      >
    </header>
    <div class="at-pianoroll__stage">
      <svg
        v-if="resolved.length"
        class="at-pianoroll__svg"
        :viewBox="`0 0 640 ${svgHeight}`"
        role="img"
        aria-label="MIDI 音符序列的钢琴卷帘教学示意图"
      >
        <!-- 行背景：黑键行深色 -->
        <rect
          v-for="midi in rows"
          :key="`row${midi}`"
          :x="LABEL_W"
          :y="yOf(lowest + midi - 1)"
          :width="PLOT_W"
          :height="ROW_H"
          :class="
            isBlack(lowest + midi - 1) ? 'at-pianoroll__row-black' : 'at-pianoroll__row-white'
          "
        />
        <!-- 左侧音名 -->
        <text
          v-for="midi in rows"
          :key="`label${midi}`"
          :x="LABEL_W - 6"
          :y="yOf(lowest + midi - 1) + ROW_H - 2"
          text-anchor="end"
          class="at-pianoroll__label"
        >
          {{ labelOf(lowest + midi - 1) }}
        </text>
        <!-- 拍线 -->
        <line
          v-for="(beat, i) in beatLines"
          :key="`beat${i}`"
          :x1="xOf(beat)"
          :x2="xOf(beat)"
          :y1="0"
          :y2="plotH"
          :class="
            Number.isInteger(beat) && Math.round(beat) % beatsPerBar === 0
              ? 'at-pianoroll__barline'
              : 'at-pianoroll__beatline'
          "
        />
        <!-- 音符 -->
        <g v-for="(note, i) in resolved" :key="`note${i}`">
          <rect
            :x="xOf(note.start) + 1"
            :y="yOf(note.midi) + 1"
            :width="Math.max(3, xOf(note.start + note.length) - xOf(note.start) - 2)"
            :height="ROW_H - 2"
            rx="2"
            class="at-pianoroll__note"
            :style="{ opacity: String(0.42 + note.velocity * 0.58) }"
          />
          <title>
            {{ midiName(note.midi) }} · 第 {{ note.start }} 拍起 · 长 {{ note.length }} 拍{{
              note.label ? ` · ${note.label}` : ''
            }}
          </title>
        </g>
        <!-- 底部拍号 -->
        <text
          v-for="(beat, i) in beatLines"
          :key="`tick${i}`"
          :x="xOf(beat)"
          :y="plotH + 14"
          text-anchor="middle"
          class="at-pianoroll__tick-text"
        >
          {{ Number.isInteger(beat) ? beat : '' }}
        </text>
      </svg>
      <p v-else class="at-pianoroll__empty">（未提供 notes 数据）</p>
      <div v-if="resolved.length" class="at-pianoroll__legend">
        <span class="at-pianoroll__chip">纵轴 = 音高（左白键名）· 横轴 = 拍</span>
        <span class="at-pianoroll__chip">矩形不透明度 = velocity</span>
      </div>
    </div>
  </section>
</template>

<style scoped>
.at-pianoroll {
  margin: 1rem 0;
  border: 1px solid var(--at-border);
  border-radius: var(--at-radius-lg);
  background: var(--at-surface);
  overflow: hidden;
}

.at-pianoroll__head {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.5rem 0.9rem;
  border-bottom: 1px solid var(--at-border);
}

.at-pianoroll__title {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--at-text-muted);
  letter-spacing: 0.02em;
}

.at-pianoroll__meta {
  margin-left: auto;
  color: var(--at-text-muted);
  font-size: 0.76rem;
  font-variant-numeric: tabular-nums;
}

.at-pianoroll__stage {
  padding: 0.7rem 0.95rem 0.75rem;
  overflow-x: auto;
  scrollbar-width: thin;
}

.at-pianoroll__svg {
  display: block;
  width: 100%;
  min-width: 420px;
  height: auto;
}

.at-pianoroll__row-white {
  fill: var(--at-bg);
}

.at-pianoroll__row-black {
  fill: var(--at-surface-2);
}

.at-pianoroll__label {
  fill: var(--at-text-muted);
  font-family: var(--at-font-mono);
  font-size: 9px;
}

.at-pianoroll__beatline {
  stroke: var(--at-border);
  stroke-width: 1;
}

.at-pianoroll__barline {
  stroke: var(--at-border-strong);
  stroke-width: 1.4;
}

.at-pianoroll__tick-text {
  fill: var(--at-text-muted);
  font-family: var(--at-font-mono);
  font-size: 9px;
}

.at-pianoroll__note {
  fill: var(--at-accent);
}

.at-pianoroll__empty {
  margin: 0 !important;
  padding: 2rem 0;
  text-align: center;
  color: var(--at-text-muted);
  font-size: 0.85rem;
}

.at-pianoroll__legend {
  display: flex;
  flex-wrap: wrap;
  gap: 0.45rem;
  margin-top: 0.5rem;
}

.at-pianoroll__chip {
  padding: 0.2rem 0.6rem;
  border-radius: 999px;
  background: var(--at-surface-2);
  color: var(--at-text-muted);
  font-size: 0.76rem;
  font-variant-numeric: tabular-nums;
}
</style>
