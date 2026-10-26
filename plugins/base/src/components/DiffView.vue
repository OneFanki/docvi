<script setup lang="ts">
/**
 * DiffView —— 演进/重构视图：展示「什么变了」。
 *
 * 灵感来自 show-me skill 的最小视图原则：当要点是「变化」而周边形状
 * 已经存在时，用 diff 比整段代码或长篇文字更省注意力。四种典型用法：
 * 组件变化、文件布局变化、调用树变化、控制流变化——由内容作者按需裁剪，
 * 只保留讲清变化所需的行。
 *
 * 用法（Markdown）：页面 script setup 里用 `?raw` 导入 diff 文本，正文写：
 *
 * <DiffView title="声环统一后的薄包装" filename="moment-templates/index.ts"
 *           :diff="diffText" />
 *
 * diff 文本兼容两种来源：标准 unified diff（- / + / @@ / 空格 前缀），
 * 或手写的 +/- 行（省略 @@ 头）。空行按上下文行渲染。
 */
import { computed, ref } from 'vue'
import { highlightLineHtml } from './highlight'

interface Props {
  /** diff 明文（建议 `import diff from './snippets/xx.diff?raw'` 引入） */
  diff: string
  /** 块标题（缺省显示「变更」） */
  title?: string
  /** 建议文件路径 / 变更主题（mono 显示，可选） */
  filename?: string
  /** 出处徽标文案，如「真实提交：ac46de23」（可选） */
  source?: string
  /** 高亮语言（默认 ts；与代码块同一轻量高亮器） */
  language?: string
}

const props = withDefaults(defineProps<Props>(), {
  title: '',
  filename: '',
  source: '',
  language: 'ts',
})

interface DiffLine {
  /** + 新增 / - 删除 / @@ hunk 头 / --- +++ 文件头 / 空格与空行=上下文 */
  kind: 'add' | 'del' | 'meta' | 'ctx'
  text: string
}

const lines = computed<DiffLine[]>(() =>
  props.diff
    .replace(/\r\n/g, '\n')
    .split('\n')
    // 去掉尾部的单个空行（?raw 导入常见），保留中间空行
    .filter((line, index, all) => !(index === all.length - 1 && line === ''))
    .map(line => {
      if (line.startsWith('+')) return { kind: 'add', text: line.slice(1) }
      if (line.startsWith('-')) return { kind: 'del', text: line.slice(1) }
      if (line.startsWith('@@') || line.startsWith('---') || line.startsWith('+++')) {
        return { kind: 'meta', text: line }
      }
      return { kind: 'ctx', text: line.replace(/^ /, '') }
    }),
)

const stats = computed(() => {
  let add = 0
  let del = 0
  for (const line of lines.value) {
    if (line.kind === 'add') add += 1
    if (line.kind === 'del') del += 1
  }
  return { add, del }
})

const copied = ref(false)
let copyTimer: number | undefined

async function copyDiff(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.diff.replace(/\r\n/g, '\n'))
  } catch {
    // 非安全上下文 / 老浏览器：静默退化
  }
  copied.value = true
  window.clearTimeout(copyTimer)
  copyTimer = window.setTimeout(() => {
    copied.value = false
  }, 1800)
}
</script>

<template>
  <figure class="at-diffview">
    <header class="at-diffview__head">
      <span class="at-diffview__title">{{ title || '变更' }}</span>
      <span class="at-diffview__stats" aria-label="新增与删除行数">
        <span v-if="stats.add" class="at-diffview__stat is-add">+{{ stats.add }}</span>
        <span v-if="stats.del" class="at-diffview__stat is-del">−{{ stats.del }}</span>
      </span>
      <button
        type="button"
        class="at-diffview__copy"
        :class="{ 'is-copied': copied }"
        :aria-label="copied ? '已复制' : '复制 diff'"
        @click="copyDiff"
      >
        {{ copied ? '已复制' : '复制' }}
      </button>
    </header>

    <div v-if="filename || source" class="at-diffview__cap">
      <span v-if="filename" class="at-diffview__file">{{ filename }}</span>
      <span v-if="source" class="at-diffview__src">{{ source }}</span>
    </div>

    <pre class="at-diffview__pre" :aria-label="filename || title || '变更'"><code
      v-for="(line, i) in lines"
      :key="i"
      class="at-diffview__line"
      :class="{ 'is-add': line.kind === 'add', 'is-del': line.kind === 'del', 'is-meta': line.kind === 'meta' }"
    ><span class="at-diffview__mark">{{ line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : line.kind === 'meta' ? '·' : ' ' }}</span><span class="at-diffview__text" v-html="highlightLineHtml(line.text, language)" /></code></pre>
  </figure>
</template>

<style scoped>
.at-diffview {
  margin: 1rem 0;
  border: 1px solid var(--at-border);
  border-radius: var(--at-radius-lg);
  overflow: hidden;
  background: var(--at-surface);
}

.at-diffview__head {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  padding: 0.5rem 0.9rem;
  border-bottom: 1px solid var(--at-border);
}

.at-diffview__title {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--at-text-muted);
  letter-spacing: 0.02em;
  margin-right: auto;
}

.at-diffview__stats {
  display: inline-flex;
  gap: 0.4rem;
}

.at-diffview__stat {
  font-family: var(--at-font-mono);
  font-size: 0.76rem;
  font-weight: 600;
}

.at-diffview__stat.is-add {
  color: var(--at-ok);
}

.at-diffview__stat.is-del {
  color: var(--at-danger, #e05561);
}

.at-diffview__copy {
  padding: 0.2rem 0.55rem;
  border: 1px solid var(--at-border);
  border-radius: var(--at-radius-sm);
  background: var(--at-bg);
  color: var(--at-text-2);
  font-size: 0.78rem;
  cursor: pointer;
  transition:
    border-color 0.12s ease,
    color 0.12s ease;
}

.at-diffview__copy:hover {
  border-color: var(--at-accent);
  color: var(--at-accent);
}

.at-diffview__copy.is-copied {
  border-color: var(--at-ok);
  color: var(--at-ok);
}

.at-diffview__cap {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.8rem;
  flex-wrap: wrap;
  padding: 0.45rem 0.9rem;
  border-bottom: 1px solid var(--at-border);
  font-size: 0.78rem;
}

.at-diffview__file {
  font-family: var(--at-font-mono);
  color: var(--at-accent-strong);
}

.at-diffview__src {
  color: var(--at-text-muted);
}

.at-diffview__pre {
  margin: 0 !important;
  padding: 0.5rem 0;
  overflow-x: auto;
  background: var(--at-code-bg);
  font-family: var(--at-font-mono);
  font-size: 0.82rem;
  line-height: 1.6;
}

.at-diffview__line {
  display: block;
  padding: 0.02rem 0.9rem 0.02rem 0;
  white-space: pre;
}

.at-diffview__line.is-add {
  background: rgba(74, 171, 111, 0.12);
}

.at-diffview__line.is-del {
  background: rgba(224, 85, 97, 0.1);
}

.at-diffview__line.is-meta {
  color: var(--at-text-muted);
  user-select: none;
}

.at-diffview__mark {
  display: inline-block;
  width: 1.6rem;
  margin-right: 0.6rem;
  text-align: center;
  user-select: none;
  color: var(--at-text-muted);
}

.at-diffview__line.is-add .at-diffview__mark {
  color: var(--at-ok);
}

.at-diffview__line.is-del .at-diffview__mark {
  color: var(--at-danger, #e05561);
}

.at-diffview__text {
  white-space: pre;
}
</style>
