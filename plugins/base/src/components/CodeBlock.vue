<script setup lang="ts">
/**
 * CodeBlock —— 教学代码块（带文件名与真实项目出处）。
 *
 * 源材料（知识库音频教程）中「每个代码块上方都有一条路径 + 出处徽标」的
 * 常规模式：Markdown 原生代码围栏无法给代码块加文件名/出处，本组件补齐。
 *
 * 职责：
 * - 渲染代码明文（建议 `import code from '../snippets/xx.ts?raw'`）＋轻量语法高亮；
 * - 顶部 meta 条：建议文件路径（mono）+ 可选「真实项目：…」出处徽标；
 * - 一键复制按钮（不带行号时复制的是干净源码）；
 * - 可选行号（`:line-numbers`）。
 *
 * 用法（Markdown）：在页面顶部的 script setup 块里用 `?raw` 导入代码，正文写：
 *
 * <CodeBlock :code="code" filename="src/spectrum/freq-math.ts"
 *            source="真实项目：math-utils.ts（freqToX / xToFreq / dbToY）" />
 *
 * 代码后的「为什么这样写」折叠讲解仍用原生 Markdown 的 details 即可，两者互补。
 */
import { computed, ref } from 'vue'
import { highlightLineHtml } from './highlight'

interface Props {
  /** 代码明文（建议用 `import code from './snippets/xx.ts?raw'` 引入） */
  code: string
  /** 建议文件路径 / 文件名（mono 显示，可选） */
  filename?: string
  /** 出处徽标文案，如「真实项目：xxx.ts」（可选） */
  source?: string
  /** 块标题（缺省显示「代码」） */
  title?: string
  /** 高亮语言（默认 ts） */
  language?: string
  /** 是否显示行号（默认否，与源材料的无行号代码块一致） */
  lineNumbers?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  filename: '',
  source: '',
  title: '',
  language: 'ts',
  lineNumbers: false,
})

const lines = computed(() => props.code.replace(/\r\n/g, '\n').split('\n'))

function lineHtml(index: number): string {
  return highlightLineHtml(lines.value[index] ?? '', props.language)
}

/** 复制干净源码（不含高亮标签） */
const copied = ref(false)
let copyTimer: number | undefined

async function copyCode(): Promise<void> {
  const text = props.code.replace(/\r\n/g, '\n')
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    // 非安全上下文 / 老浏览器：退化为 select 提示，不抛错
  }
  copied.value = true
  window.clearTimeout(copyTimer)
  copyTimer = window.setTimeout(() => {
    copied.value = false
  }, 1800)
}
</script>

<template>
  <figure class="at-codeblock">
    <header class="at-codeblock__head">
      <span class="at-codeblock__title">{{ title || '代码' }}</span>
      <button
        type="button"
        class="at-codeblock__copy"
        :class="{ 'is-copied': copied }"
        :aria-label="copied ? '已复制' : '复制代码'"
        @click="copyCode"
      >
        <svg
          v-if="!copied"
          viewBox="0 0 24 24"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <rect x="9" y="9" width="11" height="11" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
        <svg
          v-else
          viewBox="0 0 24 24"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          stroke-width="2.4"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M20 6 9 17l-5-5" />
        </svg>
        <span>{{ copied ? '已复制' : '复制' }}</span>
      </button>
    </header>

    <div v-if="filename || source" class="at-codeblock__cap">
      <span v-if="filename" class="at-codeblock__file">
        <svg
          viewBox="0 0 24 24"
          width="13"
          height="13"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6" />
        </svg>
        {{ filename }}
      </span>
      <span v-if="source" class="at-codeblock__src">{{ source }}</span>
    </div>

    <pre class="at-codeblock__pre" :aria-label="filename || title || '代码'">
      <code
        v-for="(_, i) in lines"
        :key="i"
        class="at-codeblock__line"
        :class="{ 'has-gutter': lineNumbers }"
      ><span v-if="lineNumbers" class="at-codeblock__gutter">{{ i + 1 }}</span><span class="at-codeblock__text" v-html="lineHtml(i)" /></code>
    </pre>
  </figure>
</template>

<style scoped>
.at-codeblock {
  margin: 1rem 0;
  border: 1px solid var(--at-border);
  border-radius: var(--at-radius-lg);
  overflow: hidden;
  background: var(--at-surface);
}

.at-codeblock__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.5rem 0.9rem;
  border-bottom: 1px solid var(--at-border);
}

.at-codeblock__title {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--at-text-muted);
  letter-spacing: 0.02em;
}

.at-codeblock__copy {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.2rem 0.55rem;
  border: 1px solid var(--at-border);
  border-radius: var(--at-radius-sm);
  background: var(--at-bg);
  color: var(--at-text-2);
  font-family: var(--at-font-sans);
  font-size: 0.78rem;
  line-height: 1.4;
  cursor: pointer;
  transition:
    border-color 0.12s ease,
    color 0.12s ease;
}

.at-codeblock__copy:hover {
  border-color: var(--at-accent);
  color: var(--at-accent);
}

.at-codeblock__copy.is-copied {
  border-color: var(--at-ok);
  color: var(--at-ok);
}

.at-codeblock__cap {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.8rem;
  flex-wrap: wrap;
  padding: 0.45rem 0.9rem;
  font-size: 0.78rem;
}

.at-codeblock__file {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  font-family: var(--at-font-mono);
  color: var(--at-accent-strong);
}

.at-codeblock__src {
  color: var(--at-text-muted);
}

.at-codeblock__pre {
  margin: 0 !important;
  padding: 0.3rem 0;
  overflow-x: auto;
  background: var(--at-code-bg);
  font-family: var(--at-font-mono);
  font-size: 0.84rem;
  line-height: 1.6;
}

.at-codeblock__line {
  display: block;
  padding: 0 0.9rem 0 0;
}

.at-codeblock__line.has-gutter {
  padding-left: 0;
}

.at-codeblock__gutter {
  display: inline-block;
  width: 2.6rem;
  margin-right: 0.7rem;
  text-align: right;
  user-select: none;
  color: var(--at-text-muted);
  font-variant-numeric: tabular-nums;
}

.at-codeblock__text {
  white-space: pre;
}
</style>
