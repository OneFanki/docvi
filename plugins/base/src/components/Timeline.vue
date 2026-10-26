<script setup lang="ts">
/**
 * Timeline —— 竖向时间轴：按时间顺序排列节点（时间 + 标题 + 说明，带状态色）。
 *
 * 适合版本演进、项目排程、事件序列一类「先发生什么、后发生什么」的叙述。
 * 布局：时间与圆点同行、标题逐一换行、说明再下一行——横向不被时间列挤压，纵向紧凑。
 * 通用组件，不绑定业务域。
 *
 * 用法（Markdown）：页面 script setup 里定义 items，正文写
 *
 * <Timeline title="版本演进" :items="milestones" />
 *
 * 数据协议见 types.ts：
 *   TimelineItem = { time, title, note?, status? }
 *   status: done（绿）/ active（主色，带光环）/ todo（空心）/ warn（琥珀）
 */
import type { TimelineItem } from './types'

withDefaults(
  defineProps<{
    /** 时间轴节点（按数组顺序渲染） */
    items: TimelineItem[]
    /** 标题（可选） */
    title?: string
  }>(),
  { title: '' },
)
</script>

<template>
  <section class="at-timeline">
    <header v-if="title" class="at-timeline__title">{{ title }}</header>
    <ol class="at-timeline__list">
      <li
        v-for="(item, index) in items"
        :key="index"
        class="at-timeline__item"
        :class="`is-${item.status || 'done'}`"
      >
        <span class="at-timeline__dot" aria-hidden="true" />
        <div class="at-timeline__content">
          <div class="at-timeline__time">{{ item.time }}</div>
          <div class="at-timeline__heading">{{ item.title }}</div>
          <p v-if="item.note" class="at-timeline__note">{{ item.note }}</p>
        </div>
      </li>
    </ol>
  </section>
</template>

<style scoped>
/* 包成卡片：时间轴此前是裸列表，和上下正文直接贴在一起、没有视觉边界
   （2026-10-19 用户反馈）。与 DecisionCard / RiskList 等容器组件保持同一套
   边框 + 圆角 + 表面色的外观。 */
.at-timeline {
  margin: 1rem 0;
  padding: 0.65rem 0.9rem 0.5rem;
  border: 1px solid var(--at-border);
  border-radius: var(--at-radius-lg);
  background: var(--at-surface);
}

.at-timeline__title {
  margin: 0 0 0.6rem;
  color: var(--at-text-muted);
  font-size: 0.8rem;
  font-weight: 600;
  letter-spacing: 0.02em;
}

.at-timeline__list {
  margin: 0 !important;
  padding: 0;
  list-style: none;
}

.at-timeline__item {
  position: relative;
  padding: 0 0 0.85rem 1.5rem;
}

.at-timeline__item::before {
  content: '';
  position: absolute;
  left: 0.31rem;
  top: 1rem;
  bottom: 0;
  width: 1px;
  background: var(--at-border-strong);
}

.at-timeline__item:last-child::before {
  display: none;
}

.at-timeline__dot {
  position: absolute;
  left: 0;
  top: 0.14rem;
  width: 0.62rem;
  height: 0.62rem;
  border-radius: 50%;
  background: var(--at-surface-2);
  border: 2px solid var(--at-border-strong);
}

.at-timeline__item.is-done .at-timeline__dot {
  background: var(--at-ok);
  border-color: var(--at-ok);
}

.at-timeline__item.is-active .at-timeline__dot {
  background: var(--at-accent);
  border-color: var(--at-accent);
  box-shadow: 0 0 0 4px var(--at-accent-soft);
}

.at-timeline__item.is-todo .at-timeline__dot {
  background: var(--at-bg);
}

.at-timeline__item.is-warn .at-timeline__dot {
  background: var(--at-warn);
  border-color: var(--at-warn);
}

/* 三行结构：时间（圆点同行）→ 标题 → 内容；紧凑行距 */
.at-timeline__content {
  display: flex;
  flex-direction: column;
}

.at-timeline__time {
  /* 时间标注在中文化场景里常是「领取 / 上传中 / 阈值到期」这类词，不是代码——
     用 sans 而不是 mono（mono 栈的中文会落到系统默认等宽字体，Windows 上是宋体） */
  font-family: var(--at-font-sans);
  font-size: 0.72rem;
  line-height: 0.9rem;
  color: var(--at-text-muted);
  letter-spacing: 0.01em;
}

.at-timeline__heading {
  color: var(--at-text);
  font-size: 0.9rem;
  line-height: 1.35rem;
  font-weight: 600;
}

.at-timeline__note {
  margin: 0.05rem 0 0 !important;
  color: var(--at-text-muted);
  font-size: 0.8rem;
  line-height: 1.25rem;
}
</style>
