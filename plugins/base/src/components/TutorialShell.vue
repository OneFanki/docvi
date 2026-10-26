<script setup lang="ts">
/**
 * TutorialShell —— 固定教程页面壳（页内部分）。
 *
 * 职责：在章节标题（由 Markdown H1 提供）下方渲染固定的页眉：
 * 所属课程名、第几步/共几步、以及「读完本章你将理解…」的学习目标；
 * 正文内容放在默认插槽（原始 HTML），由 Markdown 排列。
 *
 * 外层「章节导航 + 上一章/下一章」由 VitePress 的 sidebar / docFooter 提供，
 * 本组件只负责页面内部壳，二者互补。
 */
interface Props {
  /** 所属课程名 */
  courseTitle?: string
  /** 本章是第几步 */
  step?: number
  /** 共几步 */
  stepTotal?: number
  /** 学习目标：「读完本章你将理解…」 */
  goals?: string[]
}

withDefaults(defineProps<Props>(), {
  courseTitle: '',
  step: 0,
  stepTotal: 0,
  goals: () => [],
})
</script>

<template>
  <section class="at-shell" aria-label="教程页眉">
    <header class="at-shell__header">
      <div class="at-shell__kicker">
        <span v-if="courseTitle" class="at-shell__course">{{ courseTitle }}</span>
        <span
          v-if="step && stepTotal"
          class="at-shell__position"
          :aria-label="`第 ${step} 步，共 ${stepTotal} 步`"
        >
          第 {{ step }} / {{ stepTotal }} 步
        </span>
      </div>

      <div v-if="goals.length" class="at-shell__goals">
        <span class="at-shell__goals-label">读完本章，你将理解：</span>
        <ul class="at-shell__goals-list">
          <li v-for="(goal, i) in goals" :key="i">{{ goal }}</li>
        </ul>
      </div>
    </header>

    <div class="at-shell__body">
      <slot />
    </div>

    <footer v-if="$slots.footnote" class="at-shell__foot">
      <slot name="footnote" />
    </footer>
  </section>
</template>

<style scoped>
.at-shell {
  font-family: var(--at-font-sans);
}

.at-shell__header {
  margin-bottom: 2rem;
  padding-bottom: 1.25rem;
  border-bottom: 1px solid var(--at-border);
}

.at-shell__kicker {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  margin-bottom: 0.75rem;
  font-size: 0.85rem;
}

.at-shell__course {
  color: var(--at-accent);
  font-weight: 600;
}

.at-shell__position {
  padding: 0.08rem 0.5rem;
  border-radius: 999px;
  background: var(--at-accent-soft);
  color: var(--at-accent-strong);
  font-weight: 600;
}

.at-shell__goals {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding: 0.7rem 0.9rem;
  border-left: 3px solid var(--at-accent);
  border-radius: 0 var(--at-radius-md) var(--at-radius-md) 0;
  background: var(--at-surface);
}

.at-shell__goals-label {
  flex: none;
  color: var(--at-text-2);
  font-size: 0.9rem;
  font-weight: 600;
  white-space: nowrap;
}

.at-shell__goals-list {
  margin: 0 !important;
  padding-left: 1.1rem;
  color: var(--at-text-2);
  font-size: 0.92rem;
}

.at-shell__goals-list li + li {
  margin-top: 0.25rem;
}

.at-shell__body {
  color: var(--at-text);
}

.at-shell__foot {
  margin-top: 2.5rem;
  padding-top: 1rem;
  border-top: 1px dashed var(--at-border);
  color: var(--at-text-muted);
  font-size: 0.92rem;
}
</style>
