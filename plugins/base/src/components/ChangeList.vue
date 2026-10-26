<script setup lang="ts">
/**
 * ChangeList —— 改动清单：一条改动 = 标题 + 一句话说明 + 涉及模块徽标。
 *
 * PRD / 技术方案里的「本次改动」是高频结构：五到十条并列，每条要能一眼看出
 * 「改了什么」与「改了哪几块」。纯列表看不出模块覆盖面，纯表格又太死板，
 * 因此用编号 + 模块徽标的卡片式清单。
 *
 * 数据协议见 types.ts：
 *   ChangeItem = { title, summary, modules?, kind? }
 *   kind: add（新增，主色）/ change（变更，琥珀）/ remove（移除，红）
 */
import type { ChangeItem } from './types'

withDefaults(
  defineProps<{
    /** 卡片标题（缺省「本次改动」） */
    title?: string
    /** 改动条目 */
    items: ChangeItem[]
  }>(),
  { title: '本次改动' },
)

const KIND_LABEL: Record<string, string> = { add: '新增', change: '变更', remove: '移除' }
</script>

<template>
  <section class="at-changelist">
    <header class="at-changelist__head">
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
        <path d="M4 7h10" />
        <path d="M4 12h16" />
        <path d="M4 17h7" />
        <path d="M18 5l2 2 2-2" />
      </svg>
      {{ title }}
      <span class="at-changelist__count">{{ items.length }} 项</span>
    </header>

    <ol class="at-changelist__list">
      <li
        v-for="(item, index) in items"
        :key="index"
        class="at-changelist__item"
        :class="`is-${item.kind ?? 'add'}`"
      >
        <span class="at-changelist__index" aria-hidden="true">{{ index + 1 }}</span>
        <div class="at-changelist__body">
          <p class="at-changelist__title">
            {{ item.title }}
            <span v-if="item.kind" class="at-changelist__kind">{{
              KIND_LABEL[item.kind] ?? item.kind
            }}</span>
          </p>
          <p class="at-changelist__summary">{{ item.summary }}</p>
          <p v-if="item.modules?.length" class="at-changelist__modules">
            <span v-for="mod in item.modules" :key="mod" class="at-changelist__module">{{
              mod
            }}</span>
          </p>
        </div>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.at-changelist {
  margin: 1rem 0;
  border: 1px solid var(--at-border);
  border-radius: var(--at-radius-lg);
  background: var(--at-surface);
}

.at-changelist__head {
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

.at-changelist__count {
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

.at-changelist__list {
  margin: 0 !important;
  padding: 0;
  list-style: none;
}

.at-changelist__item {
  display: flex;
  gap: 0.65rem;
  align-items: flex-start;
  margin: 0 !important;
  padding: 0.7rem 0.9rem;
  border-bottom: 1px solid var(--at-border);
  font-size: 0.9rem;
}

.at-changelist__item:last-child {
  border-bottom: 0;
}

.at-changelist__index {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 1.4rem;
  height: 1.4rem;
  margin-top: 0.05rem;
  border-radius: 50%;
  background: var(--at-accent-soft);
  color: var(--at-accent-strong);
  font-family: var(--at-font-mono);
  font-size: 0.72rem;
  font-weight: 600;
}

.at-changelist__item.is-change .at-changelist__index {
  background: color-mix(in srgb, var(--at-warn) 14%, transparent);
  color: var(--at-warn);
}

.at-changelist__item.is-remove .at-changelist__index {
  background: color-mix(in srgb, var(--at-danger) 12%, transparent);
  color: var(--at-danger);
}

.at-changelist__body {
  min-width: 0;
}

.at-changelist__title {
  margin: 0 !important;
  color: var(--at-text);
  font-weight: 600;
  line-height: 1.5;
}

.at-changelist__kind {
  margin-left: 0.35rem;
  padding: 0.02rem 0.35rem;
  border-radius: var(--at-radius-sm);
  background: var(--at-surface-2);
  color: var(--at-text-muted);
  font-size: 0.7rem;
  font-weight: 500;
  vertical-align: 0.08em;
}

.at-changelist__summary {
  margin: 0.2rem 0 0 !important;
  color: var(--at-text-2);
  font-size: 0.85rem;
  line-height: 1.6;
}

.at-changelist__modules {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
  margin: 0.45rem 0 0 !important;
}

.at-changelist__module {
  padding: 0.05rem 0.45rem;
  border-radius: 999px;
  background: var(--at-surface-2);
  color: var(--at-text-muted);
  font-family: var(--at-font-mono);
  font-size: 0.7rem;
  line-height: 1.5;
  white-space: nowrap;
}
</style>
