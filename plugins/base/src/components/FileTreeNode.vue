<script setup lang="ts">
/**
 * FileTreeNode —— 递归渲染 FileTree 的单个节点（内部组件，不全局注册）。
 */
import { computed, ref } from 'vue'
import type { TreeFileNode } from './types'

const props = defineProps<{
  node: TreeFileNode
  depth: number
}>()

const isDir = computed(() => props.node.kind === 'dir' || !!props.node.children?.length)
const open = ref(props.node.open ?? props.depth < 2)
</script>

<template>
  <div
    class="at-treenode"
    :class="{ 'is-dir': isDir, 'is-file': !isDir }"
    :style="{ '--at-depth': depth }"
  >
    <button
      v-if="isDir"
      type="button"
      class="at-treenode__toggle"
      :aria-expanded="open"
      :aria-label="open ? `折叠 ${node.name}` : `展开 ${node.name}`"
      @click="open = !open"
    >
      <svg
        class="at-treenode__chevron"
        :class="{ 'is-open': open }"
        viewBox="0 0 16 16"
        width="12"
        height="12"
        aria-hidden="true"
      >
        <path
          d="M6 4l4 4-4 4"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </button>
    <span v-else class="at-treenode__spacer" aria-hidden="true" />

    <span class="at-treenode__icon" aria-hidden="true">
      <svg v-if="isDir" viewBox="0 0 24 24" width="15" height="15" fill="currentColor">
        <path
          d="M3 5.5A1.5 1.5 0 0 1 4.5 4h4.6c.5 0 .97.2 1.32.55l1.3 1.3H19.5A1.5 1.5 0 0 1 21 7.35v10.15a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5v-12z"
        />
      </svg>
      <svg v-else viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
        <path
          d="M6 2.8A1.8 1.8 0 0 0 4.2 4.6v14.8A1.8 1.8 0 0 0 6 21.2h12a1.8 1.8 0 0 0 1.8-1.8V8.6L14.6 2.8H6zm7.6 1.7l4.9 5h-4.9V4.5z"
        />
      </svg>
    </span>

    <span class="at-treenode__name">{{ node.name }}</span>
    <span v-if="node.note" class="at-treenode__note">{{ node.note }}</span>
  </div>

  <ul v-if="isDir && open" class="at-treenode__children">
    <li v-for="(child, i) in node.children" :key="i">
      <FileTreeNode :node="child" :depth="depth + 1" />
    </li>
  </ul>
</template>

<style scoped>
.at-treenode {
  display: flex;
  align-items: baseline;
  gap: 0.4rem;
  padding: 0.14rem 0.3rem;
  padding-left: calc(var(--at-depth) * 1.15rem);
  border-radius: var(--at-radius-sm);
  font-family: var(--at-font-mono);
  font-size: 0.86rem;
  line-height: 1.7;
}

/* 行 hover：明确注释的归属行（卡片底色是 surface，需更深一档才可见） */
.at-treenode:hover {
  background: var(--at-surface-2);
}

.at-treenode:hover .at-treenode__note {
  color: var(--at-text-2);
}

.at-treenode__toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1rem;
  height: 1rem;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--at-text-muted);
  cursor: pointer;
}

.at-treenode__chevron {
  transition: transform 0.15s ease;
}

.at-treenode__chevron.is-open {
  transform: rotate(90deg);
}

.at-treenode__spacer {
  display: inline-block;
  width: 1rem;
  flex: none;
}

.at-treenode__icon {
  display: inline-flex;
  flex: none;
  color: var(--at-accent);
}

.at-treenode.is-file .at-treenode__icon {
  color: var(--at-text-muted);
}

.at-treenode__name {
  color: var(--at-text);
  white-space: nowrap;
}

.at-treenode__note {
  margin-left: auto;
  padding-left: 1rem;
  color: var(--at-text-muted);
  font-family: var(--at-font-sans);
  font-size: 0.8rem;
  white-space: nowrap;
}

.at-treenode__children {
  margin: 0 !important;
  padding: 0;
  list-style: none;
}

.at-treenode__children li {
  margin: 0 !important;
}
</style>
