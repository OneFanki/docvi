<script setup lang="ts">
/**
 * DecisionCard —— 关键设计决策卡。
 *
 * 源材料的「决策」内容（如示例课程的“关键设计决策表”、音频教程 04 章的
 * “三个工程决策背后的原因”）沉淀为本卡：一条「决策 ＋ 原因（＋ 证据）」。
 * 比 Markdown 表格更贴近教学语义，且支持「正向理由 / 反向避坑」两种视觉。
 *
 * 用法（Markdown）：在页面顶部的 script setup 块里定义 decisions 数组，正文写：
 *
 * <DecisionCard title="三个工程决策" :decisions="decisions" />
 *
 * decisions 结构见 types.ts 的 DecisionItem：
 *   { decision, reason, evidence?, kind?: 'why' | 'avoid' }
 */
import type { DecisionItem } from './types'

defineProps<{
  /** 卡片标题（缺省「关键设计决策」） */
  title?: string
  /** 决策列表 */
  decisions: DecisionItem[]
}>()
</script>

<template>
  <section class="at-decision">
    <header class="at-decision__head">
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
        <path d="M9 12l2 2 4-4" />
        <circle cx="12" cy="12" r="9" />
      </svg>
      {{ title || '关键设计决策' }}
    </header>

    <ul class="at-decision__list">
      <li
        v-for="(d, i) in decisions"
        :key="i"
        class="at-decision__item"
        :class="`is-${d.kind ?? 'why'}`"
      >
        <span class="at-decision__mark" aria-hidden="true">
          <svg
            v-if="d.kind !== 'avoid'"
            viewBox="0 0 24 24"
            width="15"
            height="15"
            fill="none"
            stroke="currentColor"
            stroke-width="2.4"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M20 6 9 17l-5-5" />
          </svg>
          <svg
            v-else
            viewBox="0 0 24 24"
            width="15"
            height="15"
            fill="none"
            stroke="currentColor"
            stroke-width="2.2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M12 9v4" />
            <path d="M12 17h.01" />
            <circle cx="12" cy="12" r="9" />
          </svg>
        </span>

        <div class="at-decision__body">
          <p class="at-decision__title">{{ d.decision }}</p>
          <p class="at-decision__reason">{{ d.reason }}</p>
          <p v-if="d.evidence" class="at-decision__evidence">{{ d.evidence }}</p>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.at-decision {
  margin: 1rem 0;
  border: 1px solid var(--at-border);
  border-radius: var(--at-radius-lg);
  background: var(--at-surface);
}

.at-decision__head {
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

.at-decision__list {
  margin: 0 !important;
  padding: 0;
  list-style: none;
}

.at-decision__item {
  display: flex;
  gap: 0.7rem;
  align-items: flex-start;
  margin: 0 !important;
  padding: 0.8rem 0.95rem;
  border-bottom: 1px solid var(--at-border);
}

.at-decision__item:last-child {
  border-bottom: 0;
}

.at-decision__mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 1.55rem;
  height: 1.55rem;
  margin-top: 0.05rem;
  border-radius: 50%;
  background: var(--at-accent-soft);
  color: var(--at-accent-strong);
}

.at-decision__item.is-avoid .at-decision__mark {
  background: color-mix(in srgb, var(--at-danger) 12%, transparent);
  color: var(--at-danger);
}

.at-decision__title {
  margin: 0 !important;
  color: var(--at-text);
  font-weight: 600;
  font-size: 0.93rem;
}

.at-decision__reason {
  margin: 0.3rem 0 0 !important;
  color: var(--at-text-2);
  font-size: 0.88rem;
}

.at-decision__evidence {
  margin: 0.5rem 0 0 !important;
  padding: 0.25rem 0.55rem;
  border-radius: var(--at-radius-sm);
  background: var(--at-surface-2);
  color: var(--at-text-muted);
  /* 证据多为「字段：xxx」「接口：xxx」这类中英混排说明，不是纯代码——
     用 sans；其中真正的标识符请在数据里用反引号（行内代码自带 mono）。 */
  font-family: var(--at-font-sans);
  font-size: 0.76rem;
}

.at-decision__item.is-avoid .at-decision__evidence {
  color: var(--at-danger);
}
</style>
