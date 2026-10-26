<script setup lang="ts">
/**
 * MessageFlow —— 可步进的消息时序图（参与者泳道 + 消息箭头 + 单步高亮）。
 *
 * 适合「谁在什么时候给谁发了什么」的叙述（请求链路、事件流、调度时序）：
 * 上一步/下一步逐条高亮消息，也可直接点击某一行跳到该步。
 * 通用组件，不绑定业务域。
 *
 * 用法（Markdown）：页面 script setup 里定义 participants / messages，正文写
 *
 * <MessageFlow title="一次请求的处理时序" :participants="participants" :messages="messages" />
 *
 * 数据协议见 types.ts：
 *   MessageParticipant = { id, label, note? }
 *   MessageItem        = { from, to, label, note?, kind?: 'call'|'return'|'async' }
 *   （return 以虚线渲染；from = to 渲染为自调用标记）
 */
import { computed, ref, watch } from 'vue'
import type { MessageItem, MessageParticipant } from './types'

const props = withDefaults(
  defineProps<{
    /** 参与者（列，从左到右） */
    participants: MessageParticipant[]
    /** 消息序列（按时间顺序） */
    messages: MessageItem[]
    /** 标题（可选） */
    title?: string
  }>(),
  { title: '' },
)

const stepIndex = ref(0)

watch(
  () => props.messages.length,
  length => {
    if (stepIndex.value >= length) stepIndex.value = Math.max(0, length - 1)
  },
)

const colCount = computed(() => Math.max(1, props.participants.length))

function indexOf(id: string): number {
  const index = props.participants.findIndex(item => item.id === id)
  return index < 0 ? 0 : index
}

interface RowGeometry {
  /** 起点列索引（0 基） */
  from: number
  /** 终点列索引（0 基） */
  to: number
  /** 连线左缘（%） */
  left: number
  /** 连线宽度（%） */
  width: number
  /** 标签中点（%） */
  mid: number
  /** 反向（终点在起点左侧） */
  reverse: boolean
  /** 自调用（from = to） */
  self: boolean
}

const geometry = computed<RowGeometry[]>(() =>
  props.messages.map(message => {
    const from = indexOf(message.from)
    const to = indexOf(message.to)
    const cols = colCount.value
    const low = Math.min(from, to)
    const high = Math.max(from, to)
    return {
      from,
      to,
      reverse: to < from,
      self: from === to,
      left: ((low + 0.5) / cols) * 100,
      width: ((high - low) / cols) * 100,
      mid: (((low + high) / 2 + 0.5) / cols) * 100,
    }
  }),
)

const active = computed(() => props.messages[stepIndex.value])

/** 消息与几何配对：模板里逐项取用，避免 `geometry[index]` 的可空下标 */
const rows = computed(() =>
  props.messages.map((message, index) => {
    const geo = geometry.value[index]
    return geo ? { message, index, geo } : null
  }),
)

function stepBy(delta: number) {
  stepIndex.value = Math.min(props.messages.length - 1, Math.max(0, stepIndex.value + delta))
}
</script>

<template>
  <section class="at-msgflow">
    <header v-if="title" class="at-msgflow__title">{{ title }}</header>
    <div class="at-msgflow__stage">
      <div class="at-msgflow__parts" :style="{ '--at-msgflow-cols': colCount }">
        <span v-for="participant in participants" :key="participant.id" class="at-msgflow__part">
          {{ participant.label }}
        </span>
      </div>
      <div class="at-msgflow__rows" :style="{ '--at-msgflow-cols': colCount }">
        <div class="at-msgflow__lifelines" aria-hidden="true">
          <span
            v-for="participant in participants"
            :key="participant.id"
            class="at-msgflow__lifeline"
          />
        </div>
        <div
          v-for="row in rows"
          v-show="row"
          :key="row?.index"
          class="at-msgflow__row"
          :class="{
            'is-active': row?.index === stepIndex,
            'is-past': (row?.index ?? 0) < stepIndex,
          }"
          role="button"
          :tabindex="0"
          :aria-label="`第 ${(row?.index ?? 0) + 1} 步：${row?.message.label}`"
          @click="stepIndex = row?.index ?? 0"
          @keydown.enter="stepIndex = row?.index ?? 0"
        >
          <template v-if="row && !row.geo.self">
            <span
              class="at-msgflow__liner"
              :class="{
                'is-reverse': row.geo.reverse,
                'is-return': row.message.kind === 'return',
              }"
              :style="{ left: `${row.geo.left}%`, width: `${row.geo.width}%` }"
            />
            <span class="at-msgflow__label" :style="{ left: `${row.geo.mid}%` }">{{
              row.message.label
            }}</span>
          </template>
          <span
            v-else-if="row"
            class="at-msgflow__label is-self"
            :style="{ left: `${row.geo.mid}%` }"
            >↻ {{ row.message.label }}</span
          >
        </div>
      </div>
    </div>
    <footer class="at-msgflow__foot">
      <div class="at-msgflow__controls">
        <button
          type="button"
          class="at-msgflow__btn"
          :disabled="stepIndex <= 0"
          @click="stepBy(-1)"
        >
          上一步
        </button>
        <span class="at-msgflow__step">第 {{ stepIndex + 1 }} / {{ messages.length }} 步</span>
        <button
          type="button"
          class="at-msgflow__btn"
          :disabled="stepIndex >= messages.length - 1"
          @click="stepBy(1)"
        >
          下一步
        </button>
      </div>
      <p class="at-msgflow__cap">
        {{ active ? `${active.label}：${active.note ?? '（无补充说明）'}` : '' }}
      </p>
    </footer>
  </section>
</template>

<style scoped>
.at-msgflow {
  margin: 1rem 0;
  border: 1px solid var(--at-border);
  border-radius: var(--at-radius-lg);
  background: var(--at-surface);
  overflow: hidden;
}

.at-msgflow__title {
  padding: 0.5rem 0.9rem;
  border-bottom: 1px solid var(--at-border);
  color: var(--at-text-muted);
  font-size: 0.85rem;
  font-weight: 600;
  letter-spacing: 0.02em;
}

.at-msgflow__stage {
  overflow-x: auto;
  padding: 0.4rem 0.9rem 0.6rem;
  scrollbar-width: thin;
}

.at-msgflow__parts,
.at-msgflow__rows {
  display: grid;
  grid-template-columns: repeat(var(--at-msgflow-cols), minmax(7rem, 1fr));
  min-width: calc(var(--at-msgflow-cols) * 7rem);
}

.at-msgflow__parts {
  border-bottom: 1px solid var(--at-border);
}

.at-msgflow__part {
  padding: 0.45rem 0.3rem;
  color: var(--at-text-2);
  font-size: 0.8rem;
  font-weight: 600;
  text-align: center;
}

.at-msgflow__rows {
  position: relative;
}

.at-msgflow__lifelines {
  position: absolute;
  inset: 0;
  display: grid;
  grid-template-columns: repeat(var(--at-msgflow-cols), minmax(7rem, 1fr));
  pointer-events: none;
}

.at-msgflow__lifeline {
  position: relative;
}

.at-msgflow__lifeline::before {
  content: '';
  position: absolute;
  left: 50%;
  top: 0;
  bottom: 0;
  border-left: 1px dashed var(--at-border-strong);
}

.at-msgflow__row {
  position: relative;
  grid-column: 1 / -1;
  min-height: 2.3rem;
  border-radius: var(--at-radius-sm);
  cursor: pointer;
}

/* 鼠标点击聚焦不画 UA 默认焦点框；键盘导航用 :focus-visible 高亮 */
.at-msgflow__row:focus,
.at-msgflow__row:focus-visible {
  outline: none;
}

.at-msgflow__row:focus-visible {
  background: var(--at-highlight);
}

.at-msgflow__row:hover {
  background: var(--at-highlight);
}

/* ⚠️ 不再把未高亮的行压到 0.55：团队演示时没人会挨个点「下一步」，默认状态本身
   就必须可读（2026-10-19 用户反馈）。强调当前步改用「已走过的行变淡 + 当前步高亮连线」，
   未到的行保持满对比度。 */
.at-msgflow__row.is-past .at-msgflow__liner {
  color: var(--at-border);
}

.at-msgflow__liner {
  position: absolute;
  top: 50%;
  margin-top: -1px;
  border-top: 2px solid currentColor;
  color: var(--at-border-strong);
}

/* 箭头：用 CSS 三角画在线的末端（原实现把三角放在 border 外但没定位到端点，
   且箭头尺寸 8px 在 2px 线上几乎看不见；这里放大到 10px 并贴在端点边缘） */
.at-msgflow__liner::after,
.at-msgflow__liner::before {
  content: '';
  position: absolute;
  top: -6px;
  border: 5px solid transparent;
}

.at-msgflow__liner::after {
  right: -2px;
  border-left-color: currentColor;
}

.at-msgflow__liner::before {
  display: none;
}

.at-msgflow__liner.is-reverse::after {
  display: none;
}

.at-msgflow__liner.is-reverse::before {
  display: block;
  left: -2px;
  border-right-color: currentColor;
}

.at-msgflow__liner.is-return {
  border-top-style: dashed;
}

.at-msgflow__row.is-active .at-msgflow__liner {
  color: var(--at-accent);
}

.at-msgflow__label {
  position: absolute;
  top: 50%;
  transform: translate(-50%, -50%);
  padding: 0.1rem 0.45rem;
  border: 1px solid var(--at-border);
  border-radius: 999px;
  background: var(--at-bg);
  color: var(--at-text-2);
  font-size: 0.74rem;
  line-height: 1.4;
  white-space: nowrap;
}

.at-msgflow__label.is-self {
  border-style: dashed;
  color: var(--at-text-muted);
}

.at-msgflow__row.is-active .at-msgflow__label {
  border-color: var(--at-accent);
  color: var(--at-accent-strong);
  font-weight: 600;
}

.at-msgflow__foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.6rem;
  padding: 0.5rem 0.9rem;
  border-top: 1px solid var(--at-border);
}

.at-msgflow__controls {
  display: inline-flex;
  align-items: center;
  gap: 0.6rem;
}

.at-msgflow__btn {
  padding: 0.2rem 0.6rem;
  border: 1px solid var(--at-border);
  border-radius: var(--at-radius-sm);
  background: var(--at-bg);
  color: var(--at-text-2);
  font-size: 0.78rem;
  cursor: pointer;
  transition:
    border-color 0.12s ease,
    color 0.12s ease;
}

.at-msgflow__btn:hover:not(:disabled) {
  border-color: var(--at-accent);
  color: var(--at-accent);
}

.at-msgflow__btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.at-msgflow__step {
  color: var(--at-text-muted);
  font-size: 0.78rem;
  font-variant-numeric: tabular-nums;
}

.at-msgflow__cap {
  flex-basis: 100%;
  min-height: 1.3em;
  margin: 0 !important;
  color: var(--at-text-muted);
  font-size: 0.78rem;
}
</style>
