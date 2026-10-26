<script setup lang="ts">
/**
 * RiskList —— 风险清单：严重度 + 风险 + 影响 + 当前处置。
 *
 * 技术方案里「影响与风险」「已知限制」这几节最容易写成流水账：读者扫读时
 * 分不清哪条是「已闭环」、哪条是「明确不修、后续独立处理」。本组件强制每条
 * 风险都写清「当前处置」——这就是它与普通列表的差别。
 *
 * 数据协议见 types.ts：
 *   RiskItem = { risk, impact, handling, severity?, tag?, handled? }
 *   severity: high（红）/ medium（琥珀）/ low（中性）
 *   handled: 是否已在本方案内闭环（徽标文案切换为「本方案已处理」/「待独立处理」）
 */
import type { RiskItem } from './types'

withDefaults(
  defineProps<{
    /** 卡片标题（缺省「已知风险」） */
    title?: string
    /** 风险条目 */
    items: RiskItem[]
  }>(),
  { title: '已知风险' },
)

const SEVERITY_LABEL: Record<string, string> = { high: '高', medium: '中', low: '低' }
</script>

<template>
  <section class="at-risklist">
    <header class="at-risklist__head">
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
        <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
        <path d="M12 9v4" />
        <path d="M12 17h.01" />
      </svg>
      {{ title }}
      <span class="at-risklist__count">{{ items.length }} 条</span>
    </header>

    <ul class="at-risklist__list">
      <li
        v-for="(item, index) in items"
        :key="index"
        class="at-risklist__item"
        :class="`is-${item.severity ?? 'medium'}`"
      >
        <div class="at-risklist__top">
          <span class="at-risklist__severity">{{
            SEVERITY_LABEL[item.severity ?? 'medium'] ?? item.severity
          }}</span>
          <p class="at-risklist__risk">{{ item.risk }}</p>
          <span
            v-if="item.handled !== undefined"
            class="at-risklist__status"
            :class="item.handled ? 'is-handled' : 'is-open'"
            >{{ item.handled ? '本方案已处理' : '待独立处理' }}</span
          >
          <span v-if="item.tag" class="at-risklist__tag">{{ item.tag }}</span>
        </div>
        <dl class="at-risklist__rows">
          <div class="at-risklist__row">
            <dt>影响</dt>
            <dd>{{ item.impact }}</dd>
          </div>
          <div class="at-risklist__row">
            <dt>当前处置</dt>
            <dd>{{ item.handling }}</dd>
          </div>
        </dl>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.at-risklist {
  margin: 1rem 0;
  border: 1px solid var(--at-border);
  border-radius: var(--at-radius-lg);
  background: var(--at-surface);
}

.at-risklist__head {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.6rem 0.9rem;
  border-bottom: 1px solid var(--at-border);
  color: var(--at-text-muted);
  font-size: 0.8rem;
  font-weight: 600;
  letter-spacing: 0.02em;
}

.at-risklist__count {
  margin-left: auto;
  padding: 0.05rem 0.45rem;
  border-radius: 999px;
  background: var(--at-surface-2);
  color: var(--at-text-2);
  font-family: var(--at-font-mono);
  font-size: 0.7rem;
  font-weight: 500;
  letter-spacing: 0;
}

.at-risklist__list {
  margin: 0 !important;
  padding: 0;
  list-style: none;
}

.at-risklist__item {
  margin: 0 !important;
  padding: 0.75rem 0.9rem;
  border-bottom: 1px solid var(--at-border);
  /* 左侧严重度色条：整块风险的分级一眼可见 */
  border-left: 3px solid var(--at-border-strong);
}

.at-risklist__item:last-child {
  border-bottom: 0;
}

.at-risklist__item.is-high {
  border-left-color: var(--at-danger);
}

.at-risklist__item.is-medium {
  border-left-color: var(--at-warn);
}

.at-risklist__item.is-low {
  border-left-color: var(--at-border-strong);
}

.at-risklist__top {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.3rem 0.5rem;
}

.at-risklist__severity {
  flex: none;
  padding: 0.02rem 0.4rem;
  border-radius: var(--at-radius-sm);
  background: var(--at-surface-2);
  color: var(--at-text-muted);
  font-size: 0.7rem;
  font-weight: 600;
  line-height: 1.7;
}

.at-risklist__item.is-high .at-risklist__severity {
  background: color-mix(in srgb, var(--at-danger) 12%, transparent);
  color: var(--at-danger);
}

.at-risklist__item.is-medium .at-risklist__severity {
  background: color-mix(in srgb, var(--at-warn) 14%, transparent);
  color: var(--at-warn);
}

.at-risklist__risk {
  flex: 1 1 14rem;
  min-width: 0;
  margin: 0 !important;
  color: var(--at-text);
  font-size: 0.92rem;
  font-weight: 600;
  line-height: 1.55;
}

.at-risklist__status {
  flex: none;
  padding: 0.02rem 0.45rem;
  border-radius: 999px;
  font-size: 0.7rem;
  font-weight: 600;
  line-height: 1.7;
  white-space: nowrap;
}

.at-risklist__status.is-handled {
  background: color-mix(in srgb, var(--at-ok) 12%, transparent);
  color: var(--at-ok);
}

.at-risklist__status.is-open {
  background: color-mix(in srgb, var(--at-warn) 14%, transparent);
  color: var(--at-warn);
}

.at-risklist__tag {
  flex: none;
  color: var(--at-text-muted);
  /* 中文环节标签（「语义链路」「验收边界」）→ sans；mono 的中文字形不适合作标签 */
  font-family: var(--at-font-sans);
  font-size: 0.7rem;
}

.at-risklist__rows {
  display: grid;
  gap: 0.15rem;
  margin: 0.4rem 0 0 !important;
}

.at-risklist__row {
  display: flex;
  gap: 0.55rem;
  align-items: baseline;
  margin: 0 !important;
}

.at-risklist__row dt {
  flex: none;
  width: 4.2rem;
  color: var(--at-text-muted);
  font-size: 0.76rem;
}

.at-risklist__row dd {
  min-width: 0;
  margin: 0 !important;
  color: var(--at-text-2);
  font-size: 0.85rem;
  line-height: 1.6;
}
</style>
