<script setup lang="ts">
/**
 * MetricRow —— 指标卡组：一排「数值 + 变化 + 说明」的量化卡。
 *
 * 适合性能 / 规模 / 质量一类量化叙述（P95 耗时、体积、覆盖率…）：比表格直接，
 * 一眼看到「从多少变成多少」。通用组件，不绑定业务域。
 *
 * 用法（Markdown）：页面 script setup 里定义 items，正文写
 *
 * <MetricRow title="服务性能" :items="metrics" />
 *
 * 数据协议见 types.ts：
 *   MetricItem = { label, value, unit?, delta?, trend?, tone?, note? }
 *   trend: up / down / flat（只决定箭头）；tone: good / bad / warn / neutral（决定颜色）
 */
import type { MetricItem } from './types'

withDefaults(
  defineProps<{
    /** 指标列表（自动换行平铺） */
    items: MetricItem[]
    /** 标题（可选） */
    title?: string
  }>(),
  { title: '' },
)

const trendMark: Record<string, string> = { up: '↑', down: '↓', flat: '→' }
</script>

<template>
  <section class="at-metricrow">
    <header v-if="title" class="at-metricrow__title">{{ title }}</header>
    <div class="at-metricrow__grid">
      <article v-for="item in items" :key="item.label" class="at-metricrow__card">
        <span class="at-metricrow__label">{{ item.label }}</span>
        <span class="at-metricrow__value">
          {{ item.value }}<small v-if="item.unit" class="at-metricrow__unit">{{ item.unit }}</small>
        </span>
        <span class="at-metricrow__foot">
          <span
            v-if="item.delta"
            class="at-metricrow__delta"
            :class="`is-${item.tone || 'neutral'}`"
          >
            <template v-if="item.trend">{{ trendMark[item.trend] }}</template
            >{{ item.delta }}
          </span>
          <span v-if="item.note" class="at-metricrow__note">{{ item.note }}</span>
        </span>
      </article>
    </div>
  </section>
</template>

<style scoped>
.at-metricrow {
  margin: 1rem 0;
}

.at-metricrow__title {
  margin: 0 0 0.5rem;
  color: var(--at-text-muted);
  font-size: 0.8rem;
  font-weight: 600;
  letter-spacing: 0.02em;
}

.at-metricrow__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(10.5rem, 1fr));
  gap: 0.6rem;
}

.at-metricrow__card {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  padding: 0.7rem 0.8rem;
  border: 1px solid var(--at-border);
  border-radius: var(--at-radius-md);
  background: var(--at-surface);
}

.at-metricrow__label {
  color: var(--at-text-muted);
  font-size: 0.76rem;
}

.at-metricrow__value {
  color: var(--at-text);
  font-size: 1.35rem;
  font-weight: 650;
  line-height: 1.2;
  font-variant-numeric: tabular-nums;
}

.at-metricrow__unit {
  margin-left: 0.15rem;
  color: var(--at-text-muted);
  font-size: 0.8rem;
  font-weight: 500;
}

.at-metricrow__foot {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  flex-wrap: wrap;
  min-height: 1.1rem;
}

.at-metricrow__delta {
  padding: 0.05rem 0.45rem;
  border-radius: 999px;
  font-size: 0.76rem;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.at-metricrow__delta.is-good {
  background: color-mix(in srgb, var(--at-ok) 14%, transparent);
  color: var(--at-ok);
}

.at-metricrow__delta.is-bad {
  background: color-mix(in srgb, var(--at-danger) 14%, transparent);
  color: var(--at-danger);
}

.at-metricrow__delta.is-warn {
  background: color-mix(in srgb, var(--at-warn) 14%, transparent);
  color: var(--at-warn);
}

.at-metricrow__delta.is-neutral {
  background: var(--at-surface-2);
  color: var(--at-text-muted);
}

.at-metricrow__note {
  color: var(--at-text-muted);
  font-size: 0.74rem;
}
</style>
