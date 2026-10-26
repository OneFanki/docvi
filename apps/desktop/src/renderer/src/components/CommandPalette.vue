<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { FileText, Search, Terminal } from 'lucide-vue-next'

import { matchCommand, useCommands, type Command } from '../lib/commands'
import { searchIndex } from '../lib/search'
import type { SearchHit } from '../workers/search.worker'
import { useI18n } from '../lib/i18n'

/**
 * 命令面板（Ctrl+K）：全应用唯一的搜索入口。
 *
 * 一个输入框承担两件事：
 *  - 空输入时列出全部命令；
 *  - 有输入时把「命令命中」与「文档命中」并列，回车执行第一项。
 *
 * **为什么合并而不是分两个面板**：用户按 Ctrl+K 时脑子里只有一个念头——
 * 「我要去某处」。让他先选「找文件还是执行命令」是多余的一步。
 *
 * **搜索范围怎么区分**：不做「当前/全部」切换，靠结果分组 + 工作区徽标。
 * 命中先按「当前标签的工作区」分组，其余工作区归到「其他工作区」；打开行为
 * 也跟着范围走——当前工作区在当前标签内替换，其他工作区新开标签。
 * 这比任何开关都少一步决策，而且不会让用户疑惑「我现在到底在搜哪里」。
 */
const props = defineProps<{
  open: boolean
  /** 当前标签所属工作区（决定分组与打开方式） */
  activeWorkspaceId: string | null
  /** 工作区 id → 显示名 */
  workspaceNames: Map<string, string>
}>()

const emit = defineEmits<{
  close: []
  /** 在当前标签内打开（工作区文档 / 单文件） */
  openDoc: [path: string]
  /** 在新标签打开其他工作区的文档 */
  openDocInWorkspace: [payload: { workspaceId: string; path: string }]
}>()

const { commands } = useCommands()
const { t } = useI18n()

const query = ref('')
const cursor = ref(0)
const input = ref<HTMLInputElement | null>(null)

const terms = computed(() => query.value.trim().split(/\s+/).filter(Boolean))

const commandHits = computed(() =>
  commands.value.filter(command => matchCommand(command, terms.value)).slice(0, 5),
)

/* ---------- 文档命中：按工作区分组，当前工作区在前 ---------- */

const localHits = computed(() =>
  terms.value.length
    ? searchIndex.state.hits
        .filter(
          hit => props.activeWorkspaceId !== null && hit.workspaceId === props.activeWorkspaceId,
        )
        .slice(0, 12)
    : [],
)

const otherHits = computed(() =>
  terms.value.length
    ? searchIndex.state.hits.filter(hit => hit.workspaceId !== props.activeWorkspaceId).slice(0, 8)
    : [],
)

/** 展平后的可选项顺序，与渲染顺序严格一致（键盘上下移动靠它） */
type Row =
  { kind: 'command'; command: Command } | { kind: 'doc'; hit: SearchHit; external: boolean }

const rows = computed<Row[]>(() => {
  const list: Row[] = commandHits.value.map(command => ({ kind: 'command', command }))
  for (const hit of localHits.value) list.push({ kind: 'doc', hit, external: false })
  for (const hit of otherHits.value) list.push({ kind: 'doc', hit, external: true })
  return list
})

const total = computed(() => rows.value.length)

watch(
  () => props.open,
  async open => {
    if (!open) return
    query.value = ''
    cursor.value = 0
    await nextTick()
    input.value?.focus()
  },
)

watch(query, value => {
  cursor.value = 0
  searchIndex.search(value)
})

function move(delta: number): void {
  if (!total.value) return
  cursor.value = (cursor.value + delta + total.value) % total.value
}

function choose(index = cursor.value): void {
  const row = rows.value[index]
  if (!row) return
  if (row.kind === 'command') {
    void row.command.run()
    emit('close')
    return
  }
  if (row.external && row.hit.workspaceId) {
    emit('openDocInWorkspace', { workspaceId: row.hit.workspaceId, path: row.hit.path })
  } else {
    emit('openDoc', row.hit.path)
  }
  emit('close')
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    emit('close')
    return
  }
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    move(1)
    return
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault()
    move(-1)
    return
  }
  if (event.key === 'Enter') {
    event.preventDefault()
    choose()
  }
}

/** 摘要片段里高亮命中词：纯文本切分后分段渲染，不拼 HTML */
function snippetParts(text: string): Array<{ text: string; hit: boolean }> {
  if (!terms.value.length) return [{ text, hit: false }]
  const pattern = new RegExp(`(${terms.value.map(escapeRe).join('|')})`, 'gi')
  return text.split(pattern).map(part => ({
    text: part,
    hit: terms.value.some(term => part.toLowerCase() === term.toLowerCase()),
  }))
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function workspaceName(id: string | null): string {
  if (!id) return t('palette.singleFile')
  return props.workspaceNames.get(id) ?? t('palette.removedWorkspace')
}

/**
 * 面板打开时的全局按键收口。
 *
 * Tab 必须被拦下：面板只用一个输入框承载全部交互，Tab 会跑到背后的界面上，
 * 用户按几次后就完全失去「我现在在哪个面板」的线索。这里把 Tab 循环回输入框，
 * 其余键（方向键/回车/Esc）交给输入框自己的处理器。
 */
function onGlobalKey(event: KeyboardEvent): void {
  if (!props.open) return
  if (event.key === 'Escape') {
    emit('close')
    return
  }
  if (event.key === 'Tab') {
    event.preventDefault()
    input.value?.focus()
  }
}

onMounted(() => window.addEventListener('keydown', onGlobalKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onGlobalKey))

/** 命令分组标题只在组首出现 */
function commandGroupLabel(index: number): string | null {
  const command = commandHits.value[index]
  if (!command) return null
  const prev = commandHits.value[index - 1]
  return prev?.group === command.group ? null : command.group
}

const localLabel = computed(() => workspaceName(props.activeWorkspaceId))
</script>

<template>
  <div v-if="open" class="palette-scrim" @click.self="emit('close')">
    <div class="palette" role="dialog" :aria-label="t('titlebar.palette')" aria-modal="true">
      <div class="palette__input-row">
        <Search :size="15" :stroke-width="1.8" class="palette__icon" />
        <input
          ref="input"
          v-model="query"
          class="palette__input"
          type="text"
          :placeholder="t('palette.placeholder')"
          autocomplete="off"
          spellcheck="false"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-results"
          :aria-activedescendant="total ? `palette-item-${cursor}` : undefined"
          @keydown="onKeydown"
        />
        <kbd class="palette__esc">Esc</kbd>
      </div>

      <div
        id="palette-results"
        class="palette__list"
        role="listbox"
        :aria-label="t('palette.results')"
      >
        <template v-for="(command, index) in commandHits" :key="command.id">
          <div v-if="commandGroupLabel(index)" class="palette__group" role="presentation">
            {{ commandGroupLabel(index) }}
          </div>
          <div
            :id="`palette-item-${index}`"
            class="palette__item"
            :class="{ 'is-active': cursor === index }"
            role="option"
            :aria-selected="cursor === index"
            @click="choose(index)"
            @mouseenter="cursor = index"
          >
            <component
              :is="command.icon ?? Terminal"
              :size="14"
              :stroke-width="1.7"
              class="palette__item-icon"
            />
            <span class="palette__item-title">{{ command.title }}</span>
            <span v-if="command.hint" class="palette__item-hint">{{ command.hint }}</span>
          </div>
        </template>

        <template v-if="localHits.length">
          <div class="palette__group">
            {{ t('palette.localScope', { name: localLabel }) }}
            <span class="palette__count">{{ localHits.length }}</span>
          </div>
          <div
            v-for="(hit, i) in localHits"
            :id="`palette-item-${commandHits.length + i}`"
            :key="hit.id"
            class="palette__item palette__item--doc"
            :class="{ 'is-active': cursor === commandHits.length + i }"
            role="option"
            :aria-selected="cursor === commandHits.length + i"
            @click="choose(commandHits.length + i)"
            @mouseenter="cursor = commandHits.length + i"
          >
            <FileText :size="14" :stroke-width="1.7" class="palette__item-icon" />
            <div class="palette__doc">
              <div class="palette__doc-title">{{ hit.title }}</div>
              <div class="palette__snippet">
                <span
                  v-for="(part, partIndex) in snippetParts(hit.snippet)"
                  :key="partIndex"
                  :class="{ 'is-hit': part.hit }"
                  >{{ part.text }}</span
                >
              </div>
              <div class="palette__doc-path">{{ hit.path }}</div>
            </div>
          </div>
        </template>

        <template v-if="otherHits.length">
          <div class="palette__group">
            {{ t('palette.otherScopes') }}
            <span class="palette__count">{{ otherHits.length }}</span>
          </div>
          <div
            v-for="(hit, i) in otherHits"
            :id="`palette-item-${commandHits.length + localHits.length + i}`"
            :key="hit.id"
            class="palette__item palette__item--doc"
            :class="{ 'is-active': cursor === commandHits.length + localHits.length + i }"
            role="option"
            :aria-selected="cursor === commandHits.length + localHits.length + i"
            @click="choose(commandHits.length + localHits.length + i)"
            @mouseenter="cursor = commandHits.length + localHits.length + i"
          >
            <FileText :size="14" :stroke-width="1.7" class="palette__item-icon" />
            <div class="palette__doc">
              <div class="palette__doc-title">
                {{ hit.title }}
                <span class="palette__badge">{{ workspaceName(hit.workspaceId) }}</span>
              </div>
              <div class="palette__snippet">
                <span
                  v-for="(part, partIndex) in snippetParts(hit.snippet)"
                  :key="partIndex"
                  :class="{ 'is-hit': part.hit }"
                  >{{ part.text }}</span
                >
              </div>
              <div class="palette__doc-path">{{ hit.path }}</div>
            </div>
          </div>
        </template>

        <div v-if="!total" class="palette__empty">
          <template v-if="terms.length">没有匹配的文档或命令</template>
          <template v-else-if="searchIndex.state.indexing">正在建立索引…</template>
          <template v-else-if="!searchIndex.state.count && !searchIndex.state.external"
            >打开一个工作区后即可全库搜索</template
          >
          <template v-else>输入关键词开始搜索</template>
        </div>
      </div>

      <div class="palette__foot">
        <span v-if="searchIndex.state.indexing" class="palette__foot-item">
          {{
            t('palette.indexingOther', {
              done: searchIndex.state.indexedWorkspaces,
              total: searchIndex.state.totalWorkspaces,
            })
          }}
        </span>
        <span v-else-if="searchIndex.state.count" class="palette__foot-item">
          {{ t('palette.indexed', { count: searchIndex.state.count }) }}
        </span>
        <span class="palette__foot-hint"
          >↑↓ {{ t('palette.move') }} · ↵ {{ t('palette.open') }}</span
        >
      </div>
    </div>
  </div>
</template>

<style scoped>
.palette-scrim {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: flex;
  justify-content: center;
  /* 不写 align-items 时默认 stretch，面板会被拉成整屏高——结果只有两行时尤其难看 */
  align-items: flex-start;
  padding-top: 12vh;
  background: color-mix(in srgb, var(--dv-ui-bg) 55%, transparent);
  backdrop-filter: blur(2px);
}

.palette {
  width: min(680px, calc(100vw - 64px));
  display: flex;
  flex-direction: column;
  border: 1px solid var(--dv-ui-line);
  border-radius: var(--dv-ui-radius-md);
  background: var(--dv-ui-surface-2);
  box-shadow: var(--dv-ui-shadow-2);
  overflow: hidden;
}

.palette__input-row {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 0 12px;
  height: 46px;
  border-bottom: 1px solid var(--dv-ui-line-soft);
}

.palette__icon {
  color: var(--dv-ui-text-dim);
}

.palette__input {
  flex: 1;
  border: none;
  background: transparent;
  color: var(--dv-ui-text);
  font-size: 13.5px;
  outline: none;
}

.palette__input::placeholder {
  color: var(--dv-ui-text-dim);
}

.palette__esc {
  padding: 2px 6px;
  border: 1px solid var(--dv-ui-line-soft);
  border-radius: 4px;
  font-size: 10.5px;
  color: var(--dv-ui-text-dim);
}

.palette__list {
  /* 结果少时面板收缩到内容高度，结果多时才滚动 */
  max-height: calc(62vh - 46px);
  overflow-y: auto;
  padding: 6px;
}

.palette__group {
  display: flex;
  align-items: baseline;
  gap: 7px;
  padding: 9px 8px 4px;
  font-size: 10.5px;
  letter-spacing: 0.04em;
  color: var(--dv-ui-text-dim);
}

.palette__count {
  opacity: 0.7;
  font-variant-numeric: tabular-nums;
}

.palette__item {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 8px 9px;
  border-radius: var(--dv-ui-radius-sm);
  cursor: pointer;
}

.palette__item.is-active {
  background: var(--dv-ui-surface-3);
}

.palette__item-icon {
  flex: none;
  color: var(--dv-ui-text-muted);
}

.palette__item-title {
  font-size: 12.5px;
  color: var(--dv-ui-text);
}

.palette__item-hint {
  margin-left: auto;
  flex: none;
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--dv-ui-text-dim);
}

.palette__item--doc {
  align-items: flex-start;
  padding-top: 9px;
  padding-bottom: 9px;
}

.palette__item--doc .palette__item-icon {
  margin-top: 2px;
}

/*
 * 文档结果：标题 / 摘要 / 路径三行各自占满整行宽度。
 * 早先把路径放在右侧固定列，摘要被挤窄、右侧还留一大块空白。
 */
.palette__doc {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.palette__doc-title {
  display: flex;
  align-items: baseline;
  gap: 7px;
  min-width: 0;
  font-size: 12.5px;
  font-weight: 560;
  color: var(--dv-ui-text);
}

.palette__badge {
  flex: none;
  max-width: 45%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 1px 6px;
  border: 1px solid var(--dv-ui-line-soft);
  border-radius: 999px;
  font-size: 10px;
  font-weight: 500;
  color: var(--dv-ui-text-dim);
}

.palette__snippet {
  font-size: 11px;
  line-height: 1.55;
  color: var(--dv-ui-text-muted);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.palette__snippet .is-hit {
  color: var(--dv-ui-accent);
  font-weight: 600;
}

.palette__doc-path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10.5px;
  color: var(--dv-ui-text-dim);
}

.palette__empty {
  padding: 26px 12px;
  text-align: center;
  font-size: 12px;
  color: var(--dv-ui-text-dim);
}

.palette__foot {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  height: 28px;
  padding: 0 12px;
  border-top: 1px solid var(--dv-ui-line-soft);
  font-size: 10.5px;
  color: var(--dv-ui-text-dim);
}

.palette__foot-hint {
  margin-left: auto;
}
</style>
