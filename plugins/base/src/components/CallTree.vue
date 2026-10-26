<script setup lang="ts">
/**
 * CallTree —— 调用树：函数调函数的层层展开（名称 + 可选元信息 + 职责说明）。
 *
 * 适合「一次请求 / 一次构建里谁调了谁」的下钻式阅读：默认展开第一层，
 * 其余分支按需展开，不被无关分支淹没。通用组件，不绑定业务域。
 *
 * 用法（Markdown）：页面 script setup 里定义 data，正文写
 *
 * <CallTree title="buildSite 的调用树" :data="calls" />
 *
 * 数据协议见 types.ts：
 *   CallNode = { name, note?, meta?, children?, open? }
 *   meta 如「×86」「12ms」；open 控制初始展开（缺省仅第一层展开）。
 */
import { computed, ref } from 'vue'
import type { CallNode } from './types'

const props = withDefaults(
  defineProps<{
    /** 根节点列表（同层调用平铺） */
    data: CallNode[]
    /** 标题（可选） */
    title?: string
  }>(),
  { title: '' },
)

interface FlatRow {
  node: CallNode
  depth: number
  path: string
  hasChildren: boolean
  open: boolean
}

const openState = ref<Record<string, boolean>>({})

function isOpen(path: string, node: CallNode, depth: number): boolean {
  return openState.value[path] ?? node.open ?? depth < 1
}

const rows = computed<FlatRow[]>(() => {
  const out: FlatRow[] = []
  const walk = (nodes: CallNode[], depth: number, prefix: string) => {
    nodes.forEach((node, index) => {
      const path = `${prefix}/${index}`
      const hasChildren = Boolean(node.children?.length)
      const open = isOpen(path, node, depth)
      out.push({ node, depth, path, hasChildren, open })
      if (open && node.children) walk(node.children, depth + 1, path)
    })
  }
  walk(props.data, 0, '')
  return out
})

function toggle(row: FlatRow) {
  openState.value[row.path] = !row.open
}
</script>

<template>
  <div class="at-calltree" role="tree" :aria-label="title || '调用树'">
    <header v-if="title" class="at-calltree__title">{{ title }}</header>
    <ul class="at-calltree__list">
      <li
        v-for="row in rows"
        :key="row.path"
        class="at-calltree__row"
        :style="{ paddingLeft: `${row.depth * 1.25 + 0.25}rem` }"
      >
        <button
          v-if="row.hasChildren"
          type="button"
          class="at-calltree__toggle"
          :aria-expanded="row.open"
          :aria-label="row.open ? '折叠' : '展开'"
          @click="toggle(row)"
        >
          {{ row.open ? '▾' : '▸' }}
        </button>
        <span v-else class="at-calltree__placeholder" aria-hidden="true" />
        <code class="at-calltree__name">{{ row.node.name }}</code>
        <span v-if="row.node.meta" class="at-calltree__meta">{{ row.node.meta }}</span>
        <span v-if="row.node.note" class="at-calltree__note">{{ row.node.note }}</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.at-calltree {
  margin: 1rem 0;
  padding: 0.6rem 0.5rem 0.65rem;
  border: 1px solid var(--at-border);
  border-radius: var(--at-radius-md);
  background: var(--at-surface);
}

.at-calltree__title {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin: 0 0 0.35rem;
  padding: 0 0.5rem;
  color: var(--at-text-muted);
  font-size: 0.8rem;
  font-weight: 600;
  letter-spacing: 0.02em;
}

.at-calltree__list {
  margin: 0 !important;
  padding: 0;
  list-style: none;
}

.at-calltree__row {
  display: flex;
  align-items: baseline;
  gap: 0.45rem;
  padding: 0.06rem 0.5rem 0.06rem 0;
  border-radius: var(--at-radius-sm);
  font-size: 0.84rem;
  line-height: 1.45;
}

.at-calltree__toggle {
  flex: none;
  width: 1.1rem;
  height: 1.1rem;
  padding: 0;
  border: 0;
  background: none;
  color: var(--at-text-muted);
  font-size: 0.7rem;
  line-height: 1;
  cursor: pointer;
}

.at-calltree__placeholder {
  flex: none;
  width: 1.1rem;
}

.at-calltree__name {
  font-family: var(--at-font-mono);
  font-size: 0.8rem;
  color: var(--at-accent-strong);
}

.at-calltree__meta {
  padding: 0.02rem 0.45rem;
  border-radius: 999px;
  background: var(--at-surface-2);
  color: var(--at-text-muted);
  font-size: 0.72rem;
  font-variant-numeric: tabular-nums;
}

.at-calltree__note {
  color: var(--at-text-muted);
  font-size: 0.78rem;
}
</style>
