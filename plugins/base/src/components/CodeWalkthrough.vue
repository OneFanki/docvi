<script setup lang="ts">
/**
 * CodeWalkthrough —— 教学代码片段（讲解重点）。
 *
 * 给定代码明文与若干「讲解步骤」，以带行号的代码逐行展示：
 * - 每步高亮 1..N 行（含区间），并显示该步讲解文字；
 * - 上一步 /下一步 按钮与步骤条导航；
 * - 轻量语法着色（highlight.ts），P2 可换 Shiki。
 *
 * 用法（Markdown）：在页面顶部的 script setup 块里用 `?raw` 导入代码片段，
 * 并定义 steps 数组，正文直接写：
 *
 * <CodeWalkthrough title="effect 与依赖收集" language="ts" :code="code" :steps="steps" />
 */
import { computed, ref } from 'vue'
import { highlightLineHtml } from './highlight'
import type { WalkStep } from './types'

interface Props {
  title?: string
  language?: string
  /** 代码明文（建议用 `import x from './snippets/xx.ts?raw'` 引入） */
  code: string
  /** 讲解步骤（按阅读顺序） */
  steps: WalkStep[]
  /** 建议文件路径 / 文件名（mono 显示，可选） */
  filename?: string
  /** 出处徽标文案，如「真实项目：xxx.ts」（可选） */
  source?: string
}

const props = withDefaults(defineProps<Props>(), {
  title: '',
  language: 'ts',
  filename: '',
  source: '',
})

const active = ref(0)

const lineTexts = computed(() => props.code.replace(/\r\n/g, '\n').split('\n'))
const step = computed(() => props.steps[active.value])

interface Range {
  start: number
  end: number
}

/** 当前步需要高亮的行区间集合（1-based，含端点） */
const activeRanges = computed<Range[]>(() => {
  const s = step.value
  if (!s) return []
  return (s.lines ?? []).flatMap((r): Range[] => {
    if (Array.isArray(r)) return [{ start: r[0], end: r[1] }]
    return [{ start: r, end: r }]
  })
})

function lineActive(lineNo: number): boolean {
  return activeRanges.value.some(r => lineNo >= r.start && lineNo <= r.end)
}

function lineIsStepStart(lineNo: number): boolean {
  return activeRanges.value.some(r => lineNo === r.start)
}

function go(offset: number): void {
  const next = active.value + offset
  if (next >= 0 && next < props.steps.length) active.value = next
}

function lineHtml(index: number): string {
  return highlightLineHtml(lineTexts.value[index] ?? '', props.language)
}
</script>

<template>
  <figure class="at-walk">
    <header class="at-walk__head">
      <span class="at-walk__title">{{ title || '代码讲解' }}</span>
      <div class="at-walk__stepper" v-if="steps.length">
        <button
          class="at-walk__btn"
          type="button"
          :disabled="active === 0"
          :aria-label="'上一步'"
          @click="go(-1)"
        >
          ←
        </button>
        <span class="at-walk__count">{{ active + 1 }} / {{ steps.length }}</span>
        <button
          class="at-walk__btn"
          type="button"
          :disabled="active === steps.length - 1"
          :aria-label="'下一步'"
          @click="go(1)"
        >
          →
        </button>
      </div>
    </header>

    <div v-if="filename || source" class="at-walk__cap">
      <span v-if="filename" class="at-walk__file">{{ filename }}</span>
      <span v-if="source" class="at-walk__src">{{ source }}</span>
    </div>

    <ol class="at-walk__steps" :aria-label="'讲解步骤'">
      <li v-for="(s, i) in steps" :key="i">
        <button
          type="button"
          class="at-walk__step"
          :class="{ 'is-active': i === active }"
          @click="active = i"
        >
          <span class="at-walk__step-index">{{ i + 1 }}</span>
          {{ s.title }}
        </button>
      </li>
    </ol>

    <div class="at-walk__panel">
      <pre class="at-walk__code" :aria-label="title || '代码'"><code
        v-for="(_, i) in lineTexts"
        :key="i"
        class="at-walk__line"
        :class="{ 'is-active': lineActive(i + 1) }"
      ><span class="at-walk__gutter" :class="{ 'is-step': lineIsStepStart(i + 1) }">{{ i + 1 }}</span><span class="at-walk__text" v-html="lineHtml(i)" /></code></pre>

      <div v-if="step" class="at-walk__note">
        <span class="at-walk__note-label">{{ active + 1 }} · {{ step.title }}</span>
        <p v-if="step.note">{{ step.note }}</p>
      </div>
    </div>
  </figure>
</template>

<style scoped>
.at-walk {
  margin: 1rem 0;
  border: 1px solid var(--at-border);
  border-radius: var(--at-radius-lg);
  overflow: hidden;
  background: var(--at-surface);
}

.at-walk__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.55rem 0.9rem;
  border-bottom: 1px solid var(--at-border);
}

.at-walk__title {
  font-weight: 600;
  font-size: 0.92rem;
  color: var(--at-text);
}

.at-walk__cap {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.8rem;
  flex-wrap: wrap;
  padding: 0.45rem 0.9rem;
  border-bottom: 1px solid var(--at-border);
  font-size: 0.78rem;
}

.at-walk__file {
  font-family: var(--at-font-mono);
  color: var(--at-accent-strong);
}

.at-walk__src {
  color: var(--at-text-muted);
}

.at-walk__stepper {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

.at-walk__btn {
  width: 1.7rem;
  height: 1.7rem;
  border: 1px solid var(--at-border);
  border-radius: var(--at-radius-sm);
  background: var(--at-bg);
  color: var(--at-text-2);
  font-size: 0.9rem;
  line-height: 1;
  cursor: pointer;
}

.at-walk__btn:hover:not(:disabled) {
  border-color: var(--at-accent);
  color: var(--at-accent);
}

.at-walk__btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.at-walk__count {
  min-width: 3.2rem;
  text-align: center;
  font-size: 0.82rem;
  color: var(--at-text-muted);
  font-variant-numeric: tabular-nums;
}

.at-walk__steps {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin: 0 !important;
  padding: 0.55rem 0.9rem;
  list-style: none;
}

.at-walk__steps li {
  margin: 0 !important;
}

.at-walk__step {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.22rem 0.55rem;
  border: 1px solid var(--at-border);
  border-radius: 999px;
  background: var(--at-bg);
  color: var(--at-text-2);
  font-size: 0.82rem;
  cursor: pointer;
}

.at-walk__step:hover {
  border-color: var(--at-border-strong);
  color: var(--at-text);
}

.at-walk__step.is-active {
  border-color: var(--at-accent);
  background: var(--at-accent-soft);
  color: var(--at-accent-strong);
}

.at-walk__step-index {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.1rem;
  height: 1.1rem;
  border-radius: 50%;
  background: var(--at-surface-2);
  font-size: 0.72rem;
  font-weight: 600;
}

.at-walk__step.is-active .at-walk__step-index {
  background: var(--at-accent);
  color: var(--at-accent-contrast);
}

.at-walk__panel {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
}

.at-walk__code {
  margin: 0 !important;
  padding: 0.3rem 0;
  overflow-x: auto;
  background: var(--at-code-bg);
  font-family: var(--at-font-mono);
  font-size: 0.84rem;
  line-height: 1.6;
}

.at-walk__line {
  display: block;
  padding: 0 0.9rem 0 0;
  border-left: 2px solid transparent;
}

.at-walk__line.is-active {
  background: var(--at-highlight);
  border-left-color: var(--at-highlight-border);
}

.at-walk__gutter {
  display: inline-block;
  width: 2.6rem;
  margin-right: 0.7rem;
  text-align: right;
  user-select: none;
  color: var(--at-text-muted);
  font-variant-numeric: tabular-nums;
}

.at-walk__gutter.is-step {
  color: var(--at-accent);
  font-weight: 700;
}

.at-walk__text {
  white-space: pre;
}

.at-walk__note {
  padding: 0.75rem 1rem;
  border-top: 1px solid var(--at-border);
  background: var(--at-bg);
}

.at-walk__note-label {
  font-weight: 600;
  font-size: 0.85rem;
  color: var(--at-accent-strong);
}

.at-walk__note p {
  margin: 0.35rem 0 0 !important;
  font-size: 0.9rem;
  color: var(--at-text-2);
}
</style>
