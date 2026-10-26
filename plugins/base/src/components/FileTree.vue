<script setup lang="ts">
/**
 * FileTree —— 静态教学目录树。
 *
 * 展示项目/模块的教学目录结构：目录可折叠，每个节点可带「职责说明」，
 * 帮助读者建立「这个文件在整体里负责什么」的认知，而不是逐行展开源码。
 *
 * 用法（Markdown）：在页面顶部的 script setup 块里 import 树数据，正文直接写
 *
 * <FileTree :data="tree" title="订单模块目录" />
 */
import FileTreeNode from './FileTreeNode.vue'
import type { TreeFileNode } from './types'

defineProps<{
  /** 树根节点列表（同层目录/文件平铺） */
  data: TreeFileNode[]
  /** 树标题（可选） */
  title?: string
}>()
</script>

<template>
  <div class="at-filetree" role="tree" :aria-label="title || '目录结构'">
    <header v-if="title" class="at-filetree__title">
      <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true">
        <path
          d="M3 5.5A1.5 1.5 0 0 1 4.5 4h4.6c.5 0 .97.2 1.32.55l1.3 1.3H19.5A1.5 1.5 0 0 1 21 7.35v10.15a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5v-12z"
        />
      </svg>
      {{ title }}
    </header>
    <ul class="at-filetree__root">
      <li v-for="(node, i) in data" :key="i">
        <FileTreeNode :node="node" :depth="0" />
      </li>
    </ul>
  </div>
</template>

<style scoped>
.at-filetree {
  margin: 1rem 0;
  padding: 0.6rem 0.4rem 0.7rem;
  border: 1px solid var(--at-border);
  border-radius: var(--at-radius-md);
  background: var(--at-surface);
}

.at-filetree__title {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin-bottom: 0.4rem;
  padding: 0 0.5rem;
  color: var(--at-text-muted);
  font-size: 0.8rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  text-transform: uppercase;
}

.at-filetree__root {
  margin: 0 !important;
  padding: 0;
  list-style: none;
}

.at-filetree__root > li {
  margin: 0 !important;
}
</style>
