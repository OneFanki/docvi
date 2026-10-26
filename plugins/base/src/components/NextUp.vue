<script setup lang="ts">
/**
 * NextUp —— 下一步阅读卡。
 *
 * 源材料每章结尾的「下一步：…」指引（如“下一章进入 DAW：编曲宿主”）
 * 沉淀为本卡：一个或多个下一步入口，带徽标（推荐 / 可选 / 深入）与一句话简介。
 * 与 VitePress 的「上一章 / 下一章」翻页互补：本卡表达的是「阅读建议」，可多目标。
 *
 * 用法（Markdown）：在页面顶部的 script setup 块里定义 items，正文末尾写：
 *
 * <NextUp :items="items" />
 *
 * items 结构见 types.ts 的 NextUpItem：
 *   { label, href?, description?, badge? }
 */
import type { NextUpItem } from './types'

defineProps<{
  /** 卡片标题（缺省「下一步」） */
  title?: string
  /** 下一步入口列表 */
  items: NextUpItem[]
}>()
</script>

<template>
  <section class="at-nextup">
    <header class="at-nextup__head">
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
        <path d="M5 12h14" />
        <path d="M13 6l6 6-6 6" />
      </svg>
      {{ title || '下一步' }}
    </header>

    <ul class="at-nextup__list">
      <li v-for="(item, i) in items" :key="i" class="at-nextup__item">
        <a v-if="item.href" :href="item.href" class="at-nextup__link">
          <span v-if="item.badge" class="at-nextup__badge">{{ item.badge }}</span>
          <span class="at-nextup__label">{{ item.label }}</span>
          <span v-if="item.description" class="at-nextup__desc">{{ item.description }}</span>
          <svg
            class="at-nextup__arrow"
            viewBox="0 0 24 24"
            width="15"
            height="15"
            fill="none"
            stroke="currentColor"
            stroke-width="2.2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M9 6l6 6-6 6" />
          </svg>
        </a>
        <div v-else class="at-nextup__link is-plain">
          <span v-if="item.badge" class="at-nextup__badge">{{ item.badge }}</span>
          <span class="at-nextup__label">{{ item.label }}</span>
          <span v-if="item.description" class="at-nextup__desc">{{ item.description }}</span>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.at-nextup {
  margin: 1rem 0;
  border: 1px solid var(--at-border);
  border-radius: var(--at-radius-lg);
  background: var(--at-surface);
}

.at-nextup__head {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.6rem 0.9rem;
  border-bottom: 1px solid var(--at-border);
  color: var(--at-accent);
  font-size: 0.85rem;
  font-weight: 600;
}

.at-nextup__list {
  margin: 0 !important;
  padding: 0.4rem;
  list-style: none;
}

.at-nextup__item {
  margin: 0 !important;
}

.at-nextup__link {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex-wrap: wrap;
  padding: 0.55rem 0.6rem;
  border-radius: var(--at-radius-md);
  color: var(--at-text);
  text-decoration: none;
  transition: background 0.12s ease;
}

.at-nextup__link:hover {
  background: var(--at-surface-2);
  /* 盖掉正文全局 a:hover 下划线（卡片 hover 已有底色反馈） */
  text-decoration: none;
}

.at-nextup__link.is-plain {
  cursor: default;
}

.at-nextup__link.is-plain:hover {
  background: transparent;
}

.at-nextup__badge {
  flex: none;
  padding: 0.08rem 0.5rem;
  border-radius: 999px;
  background: var(--at-accent-soft);
  color: var(--at-accent-strong);
  font-size: 0.72rem;
  font-weight: 600;
}

.at-nextup__label {
  font-weight: 600;
  font-size: 0.9rem;
}

.at-nextup__desc {
  flex: 1 1 100%;
  margin-top: -0.2rem;
  color: var(--at-text-muted);
  font-size: 0.84rem;
}

.at-nextup__arrow {
  flex: none;
  margin-left: auto;
  color: var(--at-text-muted);
  transition:
    transform 0.12s ease,
    color 0.12s ease;
}

.at-nextup__link:hover .at-nextup__arrow {
  color: var(--at-accent);
  transform: translateX(2px);
}
</style>
