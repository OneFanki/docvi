<script setup lang="ts">
/**
 * DebugTable —— 按症状筛选的故障排查表。
 *
 * 把「错误现象清单」沉淀为可筛选表格：每行「症状 / 可能原因 / 排查与解决」，
 * 顶部按维度（自定义 tag、严重级别）过滤——症状大多一眼看不出来，筛选维度帮你
 * 按现象、模块、或严重程度先收窄，再对症下药。纯前端过滤，刷新即还原。
 *
 * 用法（Markdown）：在页面顶部的 script setup 块里定义 rows / filters，正文写：
 *
 * <DebugTable
 *   title="构建任务故障排查表"
 *   :rows="rows" :filters="filters" severity="error"
 * />
 *
 * 数据协议见 types.ts：
 *   rows:   DebugRow[] = { symptom, cause, fix, severity?, tag? }
 *   filters: DebugFilter[] = { label, on: 'tag'|'severity', options: [{ value, label? }] }
 *   severity: 缺省初始过滤的严重级别（'info' | 'warn' | 'error'，可选）
 */
import { computed, ref } from 'vue'
import type { DebugFilter, DebugRow } from './types'

const props = withDefaults(
  defineProps<{
    /** 卡片标题（缺省「故障排查表」） */
    title?: string
    /** 排查条目 */
    rows: DebugRow[]
    /** 筛选维度（tag / severity 字段） */
    filters?: DebugFilter[]
    /** 初始过滤的严重级别（缺省不过滤） */
    severity?: 'info' | 'warn' | 'error'
  }>(),
  {
    filters: () => [],
    severity: undefined,
  },
)

const SEVERITIES: Array<{ value: 'info' | 'warn' | 'error'; label: string }> = [
  { value: 'info', label: '提示' },
  { value: 'warn', label: '警告' },
  { value: 'error', label: '严重' },
]

const SEVERITY_LABEL: Record<'info' | 'warn' | 'error', string> = {
  info: '提示',
  warn: '警告',
  error: '严重',
}

/** 当前选中的严重级别；'all' 表示不过滤 */
const activeSeverity = ref<string>(props.severity ?? 'all')

/** 每个筛选维度当前选中的值；'all' 表示该维度不过滤（按 dim label 存） */
const activeDims = ref<Record<string, string>>({})

function activeOf(label: string): string {
  return activeDims.value[label] ?? 'all'
}

function setSeverity(v: string): void {
  activeSeverity.value = v
}

function setDim(label: string, v: string): void {
  activeDims.value = { ...activeDims.value, [label]: v }
}

function reset(): void {
  activeSeverity.value = 'all'
  activeDims.value = {}
}

const filteredRows = computed<DebugRow[]>(() => {
  const sev = activeSeverity.value
  const dims = activeDims.value
  return props.rows.filter(r => {
    if (sev !== 'all' && r.severity !== sev) return false
    for (const f of props.filters) {
      const active = dims[f.label] ?? 'all'
      if (active === 'all') continue
      const value = f.on === 'severity' ? (r.severity ?? 'info') : r.tag
      if (value !== active) return false
    }
    return true
  })
})
</script>

<template>
  <section class="at-dbg">
    <header class="at-dbg__head">
      <span class="at-dbg__head-title">
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
          <path d="M12 9v4" />
          <path d="M12 17h.01" />
          <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
        </svg>
        {{ title || '故障排查表' }}
      </span>
      <span class="at-dbg__meta">
        <span class="at-dbg__count">{{ filteredRows.length }} / {{ rows.length }} 条</span>
        <button
          type="button"
          class="at-dbg__reset"
          :disabled="activeSeverity === 'all' && !Object.keys(activeDims).length"
          @click="reset"
        >
          重置
        </button>
      </span>
    </header>

    <div v-if="filters.length" class="at-dbg__filters">
      <div v-for="(f, i) in filters" :key="i" class="at-dbg__dim">
        <span class="at-dbg__dim-label">{{ f.label }}</span>
        <span class="at-dbg__chips">
          <button
            type="button"
            class="at-dbg__chip"
            :class="{ 'is-active': activeOf(f.label) === 'all' }"
            @click="setDim(f.label, 'all')"
          >
            全部
          </button>
          <button
            v-for="(opt, j) in f.options"
            :key="j"
            type="button"
            class="at-dbg__chip"
            :class="{ 'is-active': activeOf(f.label) === opt.value }"
            @click="setDim(f.label, opt.value)"
          >
            {{ opt.label ?? opt.value }}
          </button>
        </span>
      </div>

      <div class="at-dbg__dim">
        <span class="at-dbg__dim-label">严重级别</span>
        <span class="at-dbg__chips">
          <button
            type="button"
            class="at-dbg__chip"
            :class="{ 'is-active': activeSeverity === 'all' }"
            @click="setSeverity('all')"
          >
            全部
          </button>
          <button
            v-for="(s, j) in SEVERITIES"
            :key="j"
            type="button"
            class="at-dbg__chip"
            :class="[`is-${s.value}`, { 'is-active': activeSeverity === s.value }]"
            @click="setSeverity(s.value)"
          >
            {{ s.label }}
          </button>
        </span>
      </div>
    </div>

    <div class="at-dbg__table-wrap">
      <table class="at-dbg__table">
        <thead>
          <tr>
            <th scope="col" class="at-dbg__th at-dbg__th-symptom">症状</th>
            <th scope="col" class="at-dbg__th">可能原因</th>
            <th scope="col" class="at-dbg__th">排查与解决</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(r, i) in filteredRows" :key="i" class="at-dbg__tr">
            <td class="at-dbg__td at-dbg__td-symptom">
              <span class="at-dbg__severity" :class="`is-${r.severity ?? 'info'}`">{{
                SEVERITY_LABEL[r.severity ?? 'info']
              }}</span>
              <span class="at-dbg__symptom">{{ r.symptom }}</span>
              <span v-if="r.tag" class="at-dbg__tag">{{ r.tag }}</span>
            </td>
            <td class="at-dbg__td at-dbg__td-text">{{ r.cause }}</td>
            <td class="at-dbg__td at-dbg__td-text at-dbg__td-fix">{{ r.fix }}</td>
          </tr>
          <tr v-if="!filteredRows.length">
            <td colspan="3" class="at-dbg__td at-dbg__empty">没有符合当前筛选的条目</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<style scoped>
.at-dbg {
  margin: 1rem 0;
  border: 1px solid var(--at-border);
  border-radius: var(--at-radius-lg);
  background: var(--at-surface);
  overflow: hidden;
}

.at-dbg__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.8rem;
  padding: 0.6rem 0.9rem;
}

.at-dbg__head-title {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  color: var(--at-text);
  font-weight: 600;
  font-size: 0.9rem;
}

.at-dbg__meta {
  display: inline-flex;
  align-items: center;
  gap: 0.6rem;
}

.at-dbg__count {
  color: var(--at-text-muted);
  font-size: 0.8rem;
  font-variant-numeric: tabular-nums;
}

.at-dbg__reset {
  padding: 0.15rem 0.55rem;
  border: 1px solid var(--at-border);
  border-radius: var(--at-radius-sm);
  background: var(--at-bg);
  color: var(--at-text-2);
  font-family: var(--at-font-sans);
  font-size: 0.78rem;
  cursor: pointer;
}

.at-dbg__reset:hover:not(:disabled) {
  border-color: var(--at-accent);
  color: var(--at-accent);
}

.at-dbg__reset:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.at-dbg__filters {
  display: grid;
  gap: 0.4rem;
  padding: 0.5rem 0.95rem 0.6rem;
  border-bottom: 1px solid var(--at-border);
  background: color-mix(in srgb, var(--at-accent) 4%, transparent);
}

.at-dbg__dim {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex-wrap: wrap;
}

.at-dbg__dim-label {
  flex: none;
  width: 4.2rem;
  color: var(--at-text-muted);
  font-size: 0.76rem;
  font-weight: 600;
}

.at-dbg__chips {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}

.at-dbg__chip {
  padding: 0.15rem 0.6rem;
  border: 1px solid var(--at-border);
  border-radius: 999px;
  background: var(--at-bg);
  color: var(--at-text-2);
  font-family: var(--at-font-sans);
  font-size: 0.76rem;
  cursor: pointer;
  transition:
    border-color 0.12s ease,
    color 0.12s ease,
    background 0.12s ease;
}

.at-dbg__chip:hover {
  border-color: var(--at-accent);
  color: var(--at-accent);
}

.at-dbg__chip.is-active {
  border-color: var(--at-accent);
  background: color-mix(in srgb, var(--at-accent) 12%, transparent);
  color: var(--at-accent-strong);
}

.at-dbg__chip.is-warn.is-active {
  border-color: var(--at-warn);
  background: color-mix(in srgb, var(--at-warn) 14%, transparent);
  color: var(--at-warn);
}

.at-dbg__chip.is-error.is-active {
  border-color: var(--at-danger);
  background: color-mix(in srgb, var(--at-danger) 12%, transparent);
  color: var(--at-danger);
}

.at-dbg__table-wrap {
  overflow-x: auto;
}

.at-dbg__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.85rem;
}

.at-dbg__th {
  padding: 0.5rem 0.9rem;
  border-bottom: 1px solid var(--at-border);
  background: var(--at-surface-2);
  color: var(--at-text-muted);
  font-size: 0.74rem;
  font-weight: 600;
  text-align: left;
  letter-spacing: 0.03em;
  white-space: nowrap;
}

.at-dbg__th-symptom {
  width: 34%;
}

.at-dbg__td {
  padding: 0.55rem 0.9rem;
  border-bottom: 1px solid var(--at-border);
  color: var(--at-text-2);
  line-height: 1.5;
  vertical-align: top;
}

.at-dbg__tr:last-child .at-dbg__td {
  border-bottom: 0;
}

.at-dbg__td-symptom {
  color: var(--at-text);
}

.at-dbg__severity {
  display: inline-block;
  padding: 0.05rem 0.45rem;
  margin-right: 0.45rem;
  border-radius: 999px;
  background: color-mix(in srgb, var(--at-accent) 12%, transparent);
  color: var(--at-accent-strong);
  font-size: 0.7rem;
  font-weight: 600;
  vertical-align: 1px;
}

.at-dbg__severity.is-warn {
  background: color-mix(in srgb, var(--at-warn) 14%, transparent);
  color: var(--at-warn);
}

.at-dbg__severity.is-error {
  background: color-mix(in srgb, var(--at-danger) 12%, transparent);
  color: var(--at-danger);
}

.at-dbg__tag {
  display: inline-block;
  padding: 0.04rem 0.45rem;
  margin-left: 0.45rem;
  border: 1px solid var(--at-border);
  border-radius: var(--at-radius-sm);
  font-family: var(--at-font-mono);
  font-size: 0.72rem;
  color: var(--at-text-muted);
  vertical-align: 1px;
}

.at-dbg__td-fix {
  color: var(--at-text);
}

.at-dbg__empty {
  padding: 1.6rem 0.9rem;
  text-align: center;
  color: var(--at-text-muted);
}
</style>
