<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import { ComponentRegistry, type OutlineEntry } from '@docvi/renderer-core'
import {
  createEditor,
  parseTable,
  serializeTable,
  type EditorHandle,
  type SelectionState,
  type SlashState,
  type TableModel,
} from '@docvi/editor'

import { BUILTIN_KINDS } from '../plugins/builtin'
import { useDocumentStore } from '../stores/documents'
import { usePluginStore } from '../stores/plugins'
import { useI18n } from '../lib/i18n'
import { buildInsertPlan, filterItems, type InsertItem } from '../lib/insert-menu'
import { insertedBlockRange } from '../lib/insert-plan'
import SlashMenu from './SlashMenu.vue'
import SelectionToolbar from './SelectionToolbar.vue'
import TableEditorDialog from './TableEditorDialog.vue'

/**
 * 编辑视图：CodeMirror 6 + Live Preview。
 *
 * 与旧实现的关键差异：**不再自己持有正文**。输入写进文档模型的共享缓冲区，
 * 因此：
 *  - 另一个标签打开同一文件时看到的是同一份内容（切过去不会丢未保存修改）；
 *  - 阅读视图渲染的也是缓冲区，从编辑切回阅读不会「回到磁盘版本」；
 *  - 保存 / 冲突 / 草稿都以文件为粒度，不存在两份草稿互相覆盖。
 *
 * 仍由本组件守住的时序：
 *  1. CM6 实例只在编辑态存在，切回阅读立刻 destroy（阅读是默认态）；
 *  2. 草稿 1.2 秒防抖落盘，崩溃或误关后可恢复；
 *  3. 自己刚保存触发的 watcher 事件要忽略（靠 mtime 比对，在文档模型里做）。
 */
const props = defineProps<{
  /** 文档绝对路径：所有状态都从文档模型按这个 key 取 */
  absolutePath: string
  mode: 'live' | 'source'
  docTheme: string
  /** 源码模式折行（实时预览恒折行） */
  wrap?: boolean
  /** 文档在内容根内的相对路径（块内图片按它解析相对引用） */
  docPath?: string
  /** 图片前缀：与阅读视图同一份，编辑态与阅读态必须显示同一张图 */
  assetPrefix?: string
}>()

const emit = defineEmits<{
  outline: [entries: OutlineEntry[]]
  error: [message: string]
  saved: [payload: { mtime: number; size: number; text: string }]
  /** 滚动比例（0–1）：分屏预览按它同步右侧 */
  /** 滚动上报：topLine = 视口顶部源行（分屏按源行对齐），ratio = 滚动比例 */
  scrolled: [payload: { topLine: number; ratio: number }]
}>()

const documents = useDocumentStore()
const plugins = usePluginStore()
const { t } = useI18n()
const host = ref<HTMLElement | null>(null)
const saving = ref(false)
const conflictOpen = ref(false)
const draftPrompted = ref(false)

const record = computed(() => documents.get(props.absolutePath))
const dirty = computed(() => (record.value ? record.value.text !== record.value.savedText : false))
const displayName = computed(
  () => record.value?.name ?? props.absolutePath.split(/[/\\]/).pop() ?? props.absolutePath,
)

/** 组件注册表：与阅读视图同一份（块级组件卡片复用同一条渲染管线） */
const registry = new ComponentRegistry()
for (const item of BUILTIN_KINDS) {
  registry.register(item.kind, item.component, {
    title: item.title,
    description: item.description,
    packageName: 'docs-plugin-base',
  })
}

let editor: EditorHandle | null = null
let draftTimer: number | null = null
/** 滚动上报的 rAF 句柄：同一帧内多次滚动只报一次 */
let scrollFrame: number | null = null

/* ---------- 可视化插入：斜杠菜单 / 选区气泡 / 表格编辑器 ---------- */

const tableEditor = ref<{ open: boolean; model: TableModel | null; from: number; to: number }>({
  open: false,
  model: null,
  from: 0,
  to: 0,
})

const slash = ref<SlashState | null>(null)
/** Esc 关掉菜单后，直到斜杠被删掉之前不再弹；按 `/` 起点记，重新输入会重开 */
const slashDismissedAt = ref<number | null>(null)

const slashOpen = computed(
  () =>
    props.mode === 'live' &&
    !!slash.value &&
    slash.value.rect !== null &&
    slash.value.from !== slashDismissedAt.value &&
    !tableEditor.value.open,
)
const slashItems = computed<InsertItem[]>(() => filterItems(slash.value?.query ?? ''))

const selection = ref<SelectionState | null>(null)
const bubbleOpen = computed(
  () =>
    props.mode === 'live' &&
    !!selection.value &&
    !selection.value.empty &&
    selection.value.focused &&
    selection.value.rect !== null &&
    !tableEditor.value.open,
)

/**
 * 斜杠插入：把「文件头声明 + 正文引用」合成一次事务。
 * 富组件的 frontmatter 增长量由 buildInsertPlan 一并算好，光标直接落在该打字的位置。
 */
function insertItem(item: InsertItem): void {
  const state = slash.value
  if (!editor || !state) return
  const doc = editor.getText()
  const plan = buildInsertPlan(doc, item, state.from, state.to)
  editor.applyChanges(plan.changes, plan.caretAfter)
  slash.value = null
  slashDismissedAt.value = null

  /*
   * 表格插完直接开网格编辑器。
   *
   * 只留「悬停表格右上角的小按钮」这一个入口，等于把可视化编辑藏起来：
   * 从斜杠菜单选「表格」的用户本来就想填内容，还要再找一遍按钮才知道能可视化改。
   * 插入的是空表（表头 + 一行空格），网格编辑器正好是它的自然续写。
   */
  if (item.id !== 'table') return
  const range = insertedBlockRange(plan)
  if (!range) return
  const model = parseTable(range.text)
  if (!model) return
  tableEditor.value = { open: true, model, from: range.from, to: range.to }
}

function dismissSlash(): void {
  slashDismissedAt.value = slash.value?.from ?? null
}

function onSlash(next: SlashState | null): void {
  if (!next) slashDismissedAt.value = null
  slash.value = next
}

function onSelection(next: SelectionState): void {
  selection.value = next
}

/** 「编辑表格」按钮：解析源码成网格模型，解析不了就明确告知（不静默拒绝） */
function openTableEditor(payload: { from: number; to: number; source: string }): void {
  const model = parseTable(payload.source)
  if (!model) {
    emit('error', '这段表格没有识别出分隔行，暂时不能可视化编辑（可直接在源码里改）')
    return
  }
  tableEditor.value = { open: true, model, from: payload.from, to: payload.to }
}

function saveTable(model: TableModel): void {
  const { from, to } = tableEditor.value
  tableEditor.value.open = false
  editor?.replaceRange(from, to, serializeTable(model))
}

/* 模板里不能直接引用非响应式的 editor 变量（Vue 会把顶层绑定当 ref 解包），统一走这几个函数 */
const format = {
  bold: (): void => editor?.wrapSelection('**'),
  italic: (): void => editor?.wrapSelection('*'),
  strike: (): void => editor?.wrapSelection('~~'),
  code: (): void => editor?.wrapSelection('`'),
  link: (url: string): void => editor?.insertLink(url),
  heading: (level: number): void => editor?.setHeading(level),
  prefix: (kind: 'bullet' | 'ordered' | 'quote'): void => editor?.toggleLinePrefix(kind),
}

async function save(force = false): Promise<void> {
  const current = record.value
  if (!editor || !current || saving.value) return
  if (!force && current.text === current.savedText) return
  const text = current.text
  saving.value = true
  try {
    const result = await window.docvi.docWrite({
      absolutePath: current.absolutePath,
      text,
      baseMtime: current.mtime,
      force,
    })
    if (!result.ok) {
      emit('error', result.error.message)
      return
    }
    if (result.data.status === 'conflict') {
      current.conflict = true
      conflictOpen.value = true
      emit('error', '文件在磁盘上已被改动，请选择处理方式')
      return
    }
    documents.markSaved(current.absolutePath, {
      mtime: result.data.mtime,
      size: result.data.size,
      text,
    })
    await window.docvi.draftClear(current.absolutePath)
    emit('saved', { mtime: result.data.mtime, size: result.data.size, text })
  } finally {
    saving.value = false
  }
}

/** 冲突处理：覆盖磁盘 / 重新载入磁盘 / 保持现状稍后处理 */
async function resolveConflict(choice: 'overwrite' | 'reload' | 'later'): Promise<void> {
  conflictOpen.value = false
  const current = record.value
  if (!current || choice === 'later') return
  if (choice === 'overwrite') {
    await save(true)
    return
  }
  documents.reloadFromDisk(current.absolutePath)
  editor?.setText(current.text)
  await window.docvi.draftClear(current.absolutePath)
}

function scheduleDraft(): void {
  if (draftTimer !== null) window.clearTimeout(draftTimer)
  draftTimer = window.setTimeout(() => {
    const current = record.value
    if (current && editor) void window.docvi.draftWrite(current.absolutePath, current.text)
  }, 1200)
}

function mountEditor(): void {
  const current = record.value
  if (!host.value || !current) return
  editor?.destroy()
  editor = createEditor({
    doc: current.text,
    parent: host.value,
    mode: props.mode,
    wrap: props.wrap,
    registry,
    // 容器语法（::: merged）必须和阅读视图同一份，否则同一块两处长得不一样
    containerSyntax: plugins.syntax.map(item => ({
      name: item.name,
      component: item.component,
      form: item.form,
    })),
    // 块内图片的解析基准：写死文件名会让子目录文档的图像全部取错
    docPath: props.docPath ?? current.relPath ?? current.name,
    ...(props.assetPrefix ? { assetPrefix: props.assetPrefix } : {}),
    // 空行引导：光标停在文档中间的空行时告诉用户「可以输入 / 插入」
    emptyHint: t('editor.emptyHint'),
    // 只有实时预览有可视化编辑：源码模式就是「所见即文件」，不加任何浮层
    context: { onSlash: onSlash, onSelection: onSelection },
    onEditTable: openTableEditor,
    onChange: text => {
      documents.setText(props.absolutePath, text)
      scheduleDraft()
    },
    onSave: () => void save(),
    /*
     * 滚动上报给宿主：分屏预览要按「滚动比例」同步右侧。
     *
     * 只报比例而不是像素：左右两侧的行高与内容高度不同（左侧是等宽源码、
     * 右侧是排过版的正文），像素对齐会让两边越滚越偏。
     * 用 rAF 合并：滚动事件的触发频率远高于屏幕刷新率，每次 setState
     * 都写 DOM 会掉帧。
     */
    onScroll: payload => {
      if (scrollFrame !== null) return
      scrollFrame = window.requestAnimationFrame(() => {
        scrollFrame = null
        emit('scrolled', payload)
      })
    },
  })

  // 草稿恢复：仅当草稿比磁盘新且与当前缓冲区不同
  if (!draftPrompted.value) {
    draftPrompted.value = true
    void window.docvi.draftRead(props.absolutePath).then(result => {
      if (!result.ok || !result.data) return
      const draft = result.data
      if (draft.text === current.text) return
      if (draft.updatedAt <= current.mtime) return
      documents.setText(props.absolutePath, draft.text)
      editor?.setText(draft.text)
      emit('error', '已恢复上次未保存的草稿（Ctrl+S 保存，或切回阅读丢弃）')
    })
  }

  void window.docvi.docWatch(props.absolutePath)
}

onMounted(() => {
  mountEditor()
  if (record.value?.conflict) conflictOpen.value = true
})

// 外部改动被文档模型判定为冲突时弹框；被静默采用时把编辑器换成磁盘内容
watch(
  () => record.value?.conflict,
  conflict => {
    if (conflict) conflictOpen.value = true
  },
)
watch(
  () => record.value?.diskText,
  (diskText, previous) => {
    const current = record.value
    if (!current || diskText === previous) return
    // 只有「缓冲区与磁盘一致」（即被 adopt）时才需要刷新编辑器；
    // 冲突状态下保留用户输入，等用户选择
    if (!current.conflict && current.text === diskText) editor?.setText(diskText)
  },
)

watch(
  () => props.mode,
  mode => editor?.setMode(mode),
)

// 折行开关不重建编辑器：走隔间重配，撤销栈与滚动位置都保住
watch(
  () => props.wrap,
  wrap => editor?.setWrap(wrap !== false),
)

// 文档主题只影响块级 Widget 内部的配色，需要重建装饰（不会丢缓冲区内容）
watch(
  () => props.docTheme,
  () => editor?.refresh(),
)

onBeforeUnmount(() => {
  if (draftTimer !== null) window.clearTimeout(draftTimer)
  void window.docvi.docUnwatch(props.absolutePath)
  // 离开编辑态时落一次草稿：切回阅读或换标签都能恢复
  const current = record.value
  if (current && dirty.value) void window.docvi.draftWrite(props.absolutePath, current.text)
  editor?.destroy()
  editor = null
})

defineExpose({
  save: () => save(),
  focus: () => editor?.focus(),
  getText: () => record.value?.text ?? '',
  isDirty: () => dirty.value,
  /** 分屏同步滚动用：取编辑区的当前滚动位置 */
  getScroll: () => editor?.getScroll() ?? 0,
  /** 分屏同步滚动用：滚动比例（0–1），源行取不到时的回落 */
  getScrollRatio: () => editor?.getScrollRatio() ?? 0,
  /** 分屏同步滚动用：视口顶部的 0-based 源行 */
  getTopLine: () => editor?.getTopLine() ?? 0,
})
</script>

<template>
  <div class="editor-shell">
    <!--
      没有顶栏：文件名在标签上、脏标记也在标签上（圆点）、保存状态在状态栏。
      再加一条「文件名 + 已同步 + Ctrl+S 保存」只是把同一件事说三遍，还占掉一行正文高度。
    -->
    <div ref="host" class="editor-shell__host" />

    <!--
      三个浮层都 Teleport 到 body：编辑器内部有 overflow 裁剪，
      菜单贴边时会被切掉一半。它们只读上报的坐标，不参与编辑器布局。
    -->
    <SlashMenu
      :open="slashOpen"
      :items="slashItems"
      :anchor="slash?.rect ?? null"
      @select="insertItem"
      @close="dismissSlash"
    />

    <SelectionToolbar
      :visible="bubbleOpen"
      :anchor="selection?.rect ?? null"
      @bold="format.bold()"
      @italic="format.italic()"
      @strike="format.strike()"
      @code="format.code()"
      @link="format.link"
      @heading="format.heading"
      @prefix="format.prefix"
    />

    <TableEditorDialog
      :open="tableEditor.open"
      :model="tableEditor.model"
      @save="saveTable"
      @close="tableEditor.open = false"
    />

    <div v-if="conflictOpen" class="conflict">
      <div class="conflict__card" role="dialog" aria-modal="true" aria-label="文件冲突">
        <h3 class="conflict__title">文件在磁盘上已被改动</h3>
        <p class="conflict__text">
          「{{ displayName }}」在你编辑期间被其他程序修改过。选择如何处理当前缓冲区。
        </p>
        <div class="conflict__actions">
          <button class="conflict__btn" type="button" @click="resolveConflict('reload')">
            重新载入磁盘版本
          </button>
          <button
            class="conflict__btn conflict__btn--primary"
            type="button"
            @click="resolveConflict('overwrite')"
          >
            用我的版本覆盖
          </button>
          <button
            class="conflict__btn conflict__btn--ghost"
            type="button"
            @click="resolveConflict('later')"
          >
            稍后处理
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.editor-shell {
  position: relative;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--dv-ed-bg);
}

.editor-shell__host {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.conflict {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  background: color-mix(in srgb, var(--dv-ui-bg) 60%, transparent);
}

.conflict__card {
  width: min(460px, calc(100vw - 80px));
  padding: 20px;
  border: 1px solid var(--dv-ui-line);
  border-radius: var(--dv-radius-md);
  background: var(--dv-ui-surface-2);
  box-shadow: var(--dv-ui-shadow-2);
}

.conflict__title {
  margin: 0 0 8px;
  font-size: 14px;
  color: var(--dv-ui-text);
}

.conflict__text {
  margin: 0 0 16px;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--dv-ui-text-muted);
}

.conflict__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.conflict__btn {
  height: 30px;
  padding: 0 12px;
  border: 1px solid var(--dv-ui-line-soft);
  border-radius: var(--dv-ui-radius-sm);
  background: transparent;
  color: var(--dv-ui-text-2);
  font-size: 12px;
  cursor: pointer;
}

.conflict__btn:hover {
  background: var(--dv-ui-surface-3);
}

.conflict__btn--primary {
  background: var(--dv-ui-accent);
  border-color: transparent;
  color: var(--dv-ui-accent-fg);
}

.conflict__btn--ghost {
  border-color: transparent;
  color: var(--dv-ui-text-dim);
}
</style>
