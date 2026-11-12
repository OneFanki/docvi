<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { X } from 'lucide-vue-next'

/**
 * 源码编辑弹窗：给「实时预览里不展开源码」的块一个显式编辑入口。
 *
 * 目前用于 mermaid 围栏块。这类块的源码与渲染结果高度差极大（源码是几十行代码、
 * 渲染后是一个 SVG），在正文里随光标展开会把整页顶一下，所以预览态保持渲染结果，
 * 编辑走这个弹窗。
 *
 * 为什么不做成富编辑器：mermaid 是外部标准语法，任何可视化编辑都会失真/受限。
 * 直接给源码 + 语法说明就够用，也不会引入只有 docvi 认的写法。
 */
const props = defineProps<{
  open: boolean
  /** 块的完整源码（含围栏行） */
  source: string
  /** 块类型标题，如「Mermaid 图」 */
  title?: string
}>()

const emit = defineEmits<{
  save: [source: string]
  close: []
}>()

const draft = ref('')
const textareaRef = ref<HTMLTextAreaElement | null>(null)

watch(
  () => [props.open, props.source] as const,
  async ([open, source]) => {
    if (!open) return
    draft.value = source
    await nextTick()
    // 只选中围栏内的正文，避免用户一敲字就把 ``` 删掉
    const area = textareaRef.value
    if (!area) return
    area.focus()
    const headEnd = source.indexOf('\n')
    if (headEnd < 0) return
    const tailStart = source.lastIndexOf('\n```')
    const from = headEnd + 1
    const to = tailStart > headEnd ? tailStart : source.length
    area.setSelectionRange(from, to)
  },
  { immediate: true },
)

function save(): void {
  if (!draft.value.trim()) return
  emit('save', draft.value)
  emit('close')
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    emit('close')
    return
  }
  // Ctrl/Cmd+Enter 保存：多行文本框里回车是换行，不能拿来回车提交
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault()
    save()
  }
}
</script>

<template>
  <div v-if="open" class="srcmodal" role="dialog" aria-modal="true" @keydown="onKeydown">
    <div class="srcmodal__card">
      <header class="srcmodal__head">
        <span class="srcmodal__title">{{ title || '编辑源码' }}</span>
        <button class="srcmodal__close" type="button" aria-label="关闭" @click="emit('close')">
          <X :size="14" :stroke-width="2" />
        </button>
      </header>
      <textarea ref="textareaRef" v-model="draft" class="srcmodal__area" spellcheck="false" />
      <footer class="srcmodal__foot">
        <span class="srcmodal__hint">Ctrl+Enter 保存</span>
        <button class="srcmodal__btn" type="button" @click="emit('close')">取消</button>
        <button class="srcmodal__btn srcmodal__btn--primary" type="button" @click="save">
          保存
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.srcmodal {
  position: fixed;
  inset: 0;
  z-index: 900;
  display: grid;
  place-items: center;
  padding: 24px;
  background: color-mix(in srgb, #000 55%, transparent);
}

.srcmodal__card {
  width: min(760px, 100%);
  max-height: min(80vh, 640px);
  display: flex;
  flex-direction: column;
  border: 1px solid var(--dv-ui-line);
  border-radius: var(--dv-ui-radius-md);
  background: var(--dv-ui-surface-2);
  box-shadow: var(--dv-ui-shadow-2);
  overflow: hidden;
}

.srcmodal__head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--dv-ui-line-soft);
}

.srcmodal__title {
  flex: 1;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--dv-ui-text);
}

.srcmodal__close {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: var(--dv-ui-radius-sm);
  background: transparent;
  color: var(--dv-ui-text-dim);
  cursor: pointer;
}

.srcmodal__close:hover {
  background: var(--dv-ui-surface-3);
  color: var(--dv-ui-text);
}

.srcmodal__area {
  flex: 1;
  min-height: 260px;
  padding: 12px;
  border: none;
  background: var(--dv-ui-surface-1);
  color: var(--dv-ui-text-2);
  font-family: var(--dv-font-mono);
  font-size: 12.5px;
  line-height: 1.6;
  resize: none;
  outline: none;
  tab-size: 2;
}

.srcmodal__foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-top: 1px solid var(--dv-ui-line-soft);
}

.srcmodal__hint {
  flex: 1;
  font-size: 11px;
  color: var(--dv-ui-text-dim);
}

.srcmodal__btn {
  height: 26px;
  padding: 0 12px;
  border: 1px solid var(--dv-ui-line);
  border-radius: var(--dv-ui-radius-sm);
  background: transparent;
  color: var(--dv-ui-text-2);
  font-size: 12px;
  cursor: pointer;
}

.srcmodal__btn:hover {
  background: var(--dv-ui-surface-3);
  color: var(--dv-ui-text);
}

.srcmodal__btn--primary {
  border-color: var(--dv-ui-accent);
  background: var(--dv-ui-accent);
  color: var(--dv-ui-accent-text, #fff);
}

.srcmodal__btn--primary:hover {
  background: var(--dv-ui-accent);
  color: var(--dv-ui-accent-text, #fff);
}
</style>
