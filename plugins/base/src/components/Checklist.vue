<script setup lang="ts">
/**
 * Checklist —— 验收 / 自检清单（可勾选）。
 *
 * 源材料每章末尾的「本章验收 / 完成本章的最低实践 / 最终自检清单」模式：
 * 把列表演进一张可勾选的卡片，勾选状态按 key 记忆在 localStorage，
 * 刷新/切换页面后进度保留（学习进度）。进度条 + 已完成计数 + 一键重置。
 *
 * 用法（Markdown）：在页面顶部的 script setup 块里定义 items，正文写：
 *
 * <Checklist title="本章验收" :items="items" storage-key="at:lens:check" />
 *
 * items 可为字符串数组，或带补充说明的对象数组（见 types.ts 的 ChecklistItem）：
 *   { text: '…', hint: '…' }
 * storage-key：决定记忆槽；同一课程不同清单请给不同 key。
 */
import { computed, onMounted, ref, watch } from 'vue'
import type { ChecklistItem } from './types'

interface Props {
  /** 清单标题（缺省「验收清单」） */
  title?: string
  /** 清单条目：字符串或 { text, hint? } */
  items: Array<string | ChecklistItem>
  /** localStorage 记忆槽（缺省按 title 派生；同标题会共用同一槽，建议显式传） */
  storageKey?: string
}

const props = withDefaults(defineProps<Props>(), {
  title: '验收清单',
  storageKey: '',
})

const normalized = computed<ChecklistItem[]>(() =>
  props.items.map(it => (typeof it === 'string' ? { text: it } : it)),
)

const storageKey = computed(() => props.storageKey || `at:checklist:${props.title}`)

/** 勾选状态（SSR 初始全 false，挂载后从 localStorage 恢复） */
const checked = ref<boolean[]>(new Array(props.items.length).fill(false))
const hasStorage = ref(false)

function persist(): void {
  if (!hasStorage.value) return
  try {
    localStorage.setItem(storageKey.value, JSON.stringify(checked.value))
  } catch {
    /* 隐私模式 / 无 storage：静默降级为会话内进度 */
  }
}

onMounted(() => {
  try {
    const stored = localStorage.getItem(storageKey.value)
    if (stored) {
      const parsed = JSON.parse(stored) as unknown
      if (Array.isArray(parsed)) {
        checked.value = normalized.value.map((_, i) => Boolean(parsed[i]))
      }
    }
  } catch {
    /* 解析失败则当无记忆 */
  }
  hasStorage.value = true
})

watch(checked, persist, { deep: true })

const doneCount = computed(() => checked.value.filter(Boolean).length)
const percent = computed(() =>
  normalized.value.length ? Math.round((doneCount.value / normalized.value.length) * 100) : 0,
)

function toggle(i: number): void {
  checked.value[i] = !checked.value[i]
}

function reset(): void {
  checked.value = new Array(props.items.length).fill(false)
}
</script>

<template>
  <section class="at-checklist">
    <header class="at-checklist__head">
      <span class="at-checklist__title">
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
          <path d="M9 11l3 3L22 4" />
          <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
        </svg>
        {{ title }}
      </span>
      <div class="at-checklist__meta">
        <span class="at-checklist__count">{{ doneCount }} / {{ normalized.length }}</span>
        <button
          type="button"
          class="at-checklist__reset"
          :disabled="doneCount === 0"
          @click="reset"
        >
          重置
        </button>
      </div>
    </header>

    <div class="at-checklist__progress" aria-hidden="true">
      <span class="at-checklist__bar" :style="{ width: `${percent}%` }" />
    </div>

    <ul class="at-checklist__list">
      <li
        v-for="(item, i) in normalized"
        :key="i"
        class="at-checklist__item"
        :class="{ 'is-done': checked[i] }"
      >
        <button
          type="button"
          class="at-checklist__box"
          role="checkbox"
          :aria-checked="checked[i]"
          :aria-label="`勾选：${item.text}`"
          @click="toggle(i)"
        >
          <svg
            v-if="checked[i]"
            viewBox="0 0 24 24"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            stroke-width="2.6"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M20 6 9 17l-5-5" />
          </svg>
        </button>
        <div class="at-checklist__body">
          <p class="at-checklist__text">{{ item.text }}</p>
          <p v-if="item.hint" class="at-checklist__hint">{{ item.hint }}</p>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.at-checklist {
  margin: 1rem 0;
  border: 1px solid var(--at-border);
  border-radius: var(--at-radius-lg);
  background: var(--at-surface);
}

.at-checklist__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.8rem;
  padding: 0.6rem 0.9rem;
}

.at-checklist__title {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  color: var(--at-text);
  font-weight: 600;
  font-size: 0.9rem;
}

.at-checklist__meta {
  display: inline-flex;
  align-items: center;
  gap: 0.6rem;
}

.at-checklist__count {
  color: var(--at-text-muted);
  font-size: 0.8rem;
  font-variant-numeric: tabular-nums;
}

.at-checklist__reset {
  padding: 0.15rem 0.55rem;
  border: 1px solid var(--at-border);
  border-radius: var(--at-radius-sm);
  background: var(--at-bg);
  color: var(--at-text-2);
  font-family: var(--at-font-sans);
  font-size: 0.78rem;
  cursor: pointer;
}

.at-checklist__reset:hover:not(:disabled) {
  border-color: var(--at-accent);
  color: var(--at-accent);
}

.at-checklist__reset:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.at-checklist__progress {
  height: 3px;
  background: var(--at-surface-2);
}

.at-checklist__bar {
  display: block;
  height: 100%;
  background: var(--at-ok);
  transition: width 0.25s ease;
}

.at-checklist__list {
  margin: 0 !important;
  padding: 0.3rem 0 0.5rem;
  list-style: none;
}

.at-checklist__item {
  display: flex;
  gap: 0.7rem;
  align-items: flex-start;
  margin: 0 !important;
  padding: 0.5rem 0.9rem;
}

.at-checklist__box {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 1.25rem;
  height: 1.25rem;
  margin-top: 0.1rem;
  border: 1.5px solid var(--at-border-strong);
  border-radius: var(--at-radius-sm);
  background: var(--at-bg);
  color: var(--at-accent-contrast);
  cursor: pointer;
  transition:
    border-color 0.12s ease,
    background 0.12s ease;
}

.at-checklist__box:hover {
  border-color: var(--at-accent);
}

.at-checklist__item.is-done .at-checklist__box {
  border-color: var(--at-ok);
  background: var(--at-ok);
}

.at-checklist__text {
  margin: 0.08rem 0 0 !important;
  color: var(--at-text);
  font-size: 0.9rem;
  line-height: 1.5;
}

.at-checklist__item.is-done .at-checklist__text {
  color: var(--at-text-muted);
  text-decoration: line-through;
  text-decoration-color: var(--at-border-strong);
}

.at-checklist__hint {
  margin: 0.2rem 0 0 !important;
  color: var(--at-text-muted);
  font-size: 0.8rem;
}
</style>
