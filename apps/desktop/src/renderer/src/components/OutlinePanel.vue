<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'

import type { OutlineEntry } from '@docvi/renderer-core'

/**
 * 大纲：文档 h2/h3 的滚动联动导航。
 *
 * 高亮策略：用 IntersectionObserver 观察标题元素，取「已进入视口且最靠上」
 * 的一个作为当前节。不用 scroll 事件逐帧计算——长文档上那会持续占用主线程。
 */
const props = defineProps<{
  entries: OutlineEntry[]
  /** 滚动容器与内容根（由 ReaderView 提供选择器） */
  scrollSelector: string
}>()

const activeId = ref<string | null>(null)
let observer: IntersectionObserver | null = null
const visible = new Map<string, boolean>()

function disconnect(): void {
  observer?.disconnect()
  observer = null
  visible.clear()
}

function connect(): void {
  disconnect()
  if (!props.entries.length) return
  const root = document.querySelector<HTMLElement>(props.scrollSelector)
  if (!root) return

  observer = new IntersectionObserver(
    entries => {
      for (const entry of entries) visible.set(entry.target.id, entry.isIntersecting)
      // 取第一个可见项：滚动时读者视线首先落到的就是它
      const firstVisible = props.entries.find(item => visible.get(item.id))
      if (firstVisible) activeId.value = firstVisible.id
    },
    { root, rootMargin: '0px 0px -70% 0px', threshold: 0 },
  )
  for (const item of props.entries) {
    const el = document.getElementById(item.id)
    if (el) observer.observe(el)
  }
}

watch(
  () => [props.entries, props.scrollSelector],
  async () => {
    // 等 DOM 插入完成再观察：标题节点由 v-html 生成
    await new Promise(resolve => requestAnimationFrame(resolve))
    connect()
    activeId.value = props.entries[0]?.id ?? null
  },
  { immediate: true },
)

onBeforeUnmount(disconnect)

const hasEntries = computed(() => props.entries.length >= 2)

function jump(id: string): void {
  const el = document.getElementById(id)
  if (!el) return
  el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  activeId.value = id
}
</script>

<template>
  <aside v-if="hasEntries" class="outline" aria-label="本页目录">
    <p class="outline__title">本页目录</p>
    <nav>
      <button
        v-for="item in entries"
        :key="item.id"
        v-tooltip="item.text"
        class="outline__item"
        :class="{ 'is-active': activeId === item.id, 'is-h3': item.level === 3 }"
        type="button"
        @click="jump(item.id)"
      >
        {{ item.text }}
      </button>
    </nav>
  </aside>
</template>

<style scoped>
.outline {
  width: var(--dv-ui-outline-w);
  flex: none;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 16px 12px 24px;
  border-left: 1px solid var(--dv-ui-line-soft);
  background: var(--dv-ui-bg);
}

.outline__title {
  margin: 0 0 8px;
  padding-left: 8px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--dv-ui-text-dim);
  text-transform: uppercase;
}

.outline__item {
  display: block;
  width: 100%;
  padding: 5px 8px;
  border: none;
  border-left: 2px solid transparent;
  border-radius: 0 var(--dv-radius-sm) var(--dv-radius-sm) 0;
  background: transparent;
  color: var(--dv-ui-text-muted);
  font-size: 12px;
  line-height: 1.45;
  text-align: left;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition:
    color var(--dv-dur-1) var(--dv-ease),
    background var(--dv-dur-1) var(--dv-ease);
}

.outline__item:hover {
  background: var(--dv-ui-surface-2);
  color: var(--dv-ui-text-2);
}

.outline__item.is-active {
  border-left-color: var(--dv-ui-accent);
  color: var(--dv-ui-accent);
}

.outline__item.is-h3 {
  padding-left: 18px;
  font-size: 11.5px;
}
</style>
