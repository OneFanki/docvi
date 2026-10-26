<script setup lang="ts">
/**
 * EvidenceNote —— 教学片段与真实项目快照的关联证据卡。
 *
 * 平台原则「教学片段 = 整理 + 教学注释版，不逐行搬真实源码」：本卡把「这一节
 * 讲的抽象」与「真实项目里对应的一段真实快照」显式挂起来——教学片段来源、
 * 真实项目快照（类型徽标 / 标题 / 引用位置），并声明教学覆盖范围（这一点覆盖
 * 什么、不覆盖什么），避免读者误以为片段就是完整源码。
 *
 * 用法（Markdown）：在页面顶部的 script setup 块里定义 snapshot，正文写：
 *
 * <EvidenceNote
 *   title="对象池片段 ⇄ 真实项目快照"
 *   source="本章 2.3 节 CodeWalkthrough 的 Text 对象池片段"
 *   :snapshot="snapshot"
 *   teaching-scope="覆盖 Text 对象池的创建与复用；不覆盖字体缓存与字形回退，见 05 章"
 * />
 *
 * 数据协议见 types.ts：snapshot = ProjectSnapshot = { kind?, title, ref?, description? }；
 * kind 徽标：commit / pr / snippet / doc。
 */
import type { ProjectSnapshot } from './types'

defineProps<{
  /** 卡片标题（缺省「证据链接」） */
  title?: string
  /** 教学片段来源（本节/本章讲的是什么，来自哪一段） */
  source: string
  /** 真实项目快照 */
  snapshot: ProjectSnapshot
  /** 教学覆盖范围：该证据覆盖哪些点、不覆盖哪些（可选） */
  teachingScope?: string
}>()
</script>

<template>
  <section class="at-evidence">
    <header class="at-evidence__head">
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
        <circle cx="11" cy="11" r="7" />
        <path d="m21 21-4.35-4.35" />
        <path d="M8 11h6" />
        <path d="M11 8v6" />
      </svg>
      {{ title || '证据链接' }}
    </header>

    <div class="at-evidence__cols">
      <div class="at-evidence__side at-evidence__teaching">
        <p class="at-evidence__side-label">教学片段</p>
        <p class="at-evidence__side-text">{{ source }}</p>
      </div>

      <div class="at-evidence__arrow" aria-hidden="true">
        <svg
          viewBox="0 0 24 24"
          width="16"
          height="16"
          fill="none"
          stroke="currentColor"
          stroke-width="2.2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M4 12h16" />
          <path d="M14 6l6 6-6 6" />
        </svg>
      </div>

      <div class="at-evidence__side at-evidence__snapshot">
        <p class="at-evidence__side-label">
          真实项目快照
          <span v-if="snapshot.kind" class="at-evidence__kind" :class="`is-${snapshot.kind}`">{{
            snapshot.kind
          }}</span>
        </p>
        <p class="at-evidence__side-text at-evidence__title">{{ snapshot.title }}</p>
        <p v-if="snapshot.ref" class="at-evidence__ref">{{ snapshot.ref }}</p>
        <p v-if="snapshot.description" class="at-evidence__desc">{{ snapshot.description }}</p>
      </div>
    </div>

    <footer v-if="teachingScope" class="at-evidence__scope">
      <span class="at-evidence__scope-tag">教学范围</span>
      <span class="at-evidence__scope-text">{{ teachingScope }}</span>
    </footer>
  </section>
</template>

<style scoped>
.at-evidence {
  margin: 1rem 0;
  border: 1px solid var(--at-border);
  border-radius: var(--at-radius-lg);
  background: var(--at-surface);
}

.at-evidence__head {
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

.at-evidence__cols {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  gap: 0.9rem;
  align-items: stretch;
  padding: 0.8rem 0.95rem 0.85rem;
}

.at-evidence__side {
  padding: 0.6rem 0.75rem;
  border: 1px solid var(--at-border);
  border-radius: var(--at-radius-md);
  background: var(--at-bg);
}

.at-evidence__side-label {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin: 0 0 0.45rem !important;
  color: var(--at-text-muted);
  font-size: 0.74rem;
  font-weight: 600;
  letter-spacing: 0.04em;
}

.at-evidence__side-text {
  margin: 0 !important;
  color: var(--at-text-2);
  font-size: 0.88rem;
  line-height: 1.55;
}

.at-evidence__title {
  color: var(--at-text);
  font-weight: 600;
}

.at-evidence__arrow {
  display: flex;
  align-items: center;
  color: var(--at-text-muted);
}

.at-evidence__kind {
  padding: 0.03rem 0.45rem;
  border-radius: 999px;
  background: color-mix(in srgb, var(--at-accent) 12%, transparent);
  color: var(--at-accent-strong);
  font-family: var(--at-font-mono);
  font-size: 0.68rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.at-evidence__kind.is-pr {
  background: color-mix(in srgb, var(--at-accent) 12%, transparent);
  color: var(--at-accent-strong);
}

.at-evidence__kind.is-snippet {
  background: color-mix(in srgb, var(--at-ok) 14%, transparent);
  color: var(--at-ok);
}

.at-evidence__kind.is-doc {
  background: color-mix(in srgb, var(--at-warn) 14%, transparent);
  color: var(--at-warn);
}

.at-evidence__ref {
  margin: 0.45rem 0 0 !important;
  padding: 0.22rem 0.5rem;
  border-radius: var(--at-radius-sm);
  background: var(--at-surface-2);
  font-family: var(--at-font-mono);
  font-size: 0.76rem;
  color: var(--at-text-muted);
}

.at-evidence__desc {
  margin: 0.55rem 0 0 !important;
  font-size: 0.82rem;
  color: var(--at-text-2);
  line-height: 1.5;
}

.at-evidence__scope {
  display: flex;
  align-items: flex-start;
  gap: 0.55rem;
  padding: 0.6rem 0.95rem 0.7rem;
  border-top: 1px solid var(--at-border);
  background: color-mix(in srgb, var(--at-accent) 4%, transparent);
  font-size: 0.82rem;
}

.at-evidence__scope-tag {
  flex: none;
  padding: 0.12rem 0.5rem;
  border-radius: 999px;
  background: color-mix(in srgb, var(--at-accent) 10%, transparent);
  color: var(--at-accent-strong);
  font-size: 0.72rem;
  font-weight: 600;
}

.at-evidence__scope-text {
  color: var(--at-text-2);
  line-height: 1.55;
}
</style>
