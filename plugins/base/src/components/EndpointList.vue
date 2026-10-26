<script setup lang="ts">
/**
 * EndpointList —— 接口清单：折叠态一行一个端点（方法 / 路径 / 一句话职责 / 权限门槛），
 * 点击展开契约详情（入参 / 出参关键字段 / 不变量 / 备注）。默认全折叠——先回答
 * 「有哪些接口、各自干什么」，只对存疑的端点下钻，不为细节占版面。
 *
 * 方法字段不限于 HTTP：非 HTTP 出口（WS 推送 / EVENT 事件出口 / INTERNAL 内部调用）
 * 直接填对应字样，筛选条按数据自动生成，未知方法走中性色徽标。
 *
 * 展示程度（组件设计约定）：
 * - 展开态只放「契约承诺」（关键字段 + 语义约束），不抄全量 DTO——完整 schema
 *   以 OpenAPI / 代码为准（文档链接而非复制，避免双源漂移）；
 * - 无详情数据的端点不显示展开箭头（避免「点了没东西」）；
 * - deprecated 端点划线与降透明度标记，保留可读但不抢视线。
 *
 * 用法（Markdown）：在页面顶部的 script setup 块里定义 endpoints，正文写：
 *
 * <EndpointList title="订单系统接口清单" :endpoints="endpoints" />
 *
 * 数据协议见 types.ts：
 *   EndpointSpec  = { method, path, summary, auth?, deprecated?, params?, response?, invariants?, note? }
 *   EndpointParam = { name, in?, type?, required?, desc? }（in 仅入参：path / query / body / header）
 */
import { computed, ref } from 'vue'
import type { EndpointSpec, InvariantRule } from './types'

const props = defineProps<{
  /** 卡片标题（缺省「接口清单」） */
  title?: string
  /** 端点列表 */
  endpoints: EndpointSpec[]
}>()

/** 方法筛选的展示顺序（数据中未出现的不显示；未知方法按字母序追加） */
const METHOD_ORDER = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']

const methods = computed(() => {
  const seen = new Set(props.endpoints.map(e => e.method.toUpperCase()))
  const known = METHOD_ORDER.filter(m => seen.has(m))
  const rest = [...seen].filter(m => !METHOD_ORDER.includes(m)).sort()
  return [...known, ...rest]
})

const filter = ref('*')
const filtered = computed(() =>
  filter.value === '*'
    ? props.endpoints
    : props.endpoints.filter(e => e.method.toUpperCase() === filter.value),
)

function endpointKey(ep: EndpointSpec) {
  return `${ep.method.toUpperCase()} ${ep.path}`
}

function hasDetail(ep: EndpointSpec) {
  return Boolean(ep.params?.length || ep.response?.length || ep.invariants?.length || ep.note)
}

// 展开集合按「方法 + 路径」记录：切换筛选不丢失展开状态
const openKeys = ref(new Set<string>())
function isOpen(ep: EndpointSpec) {
  return openKeys.value.has(endpointKey(ep))
}
function toggle(ep: EndpointSpec) {
  if (!hasDetail(ep)) return
  const key = endpointKey(ep)
  if (openKeys.value.has(key)) openKeys.value.delete(key)
  else openKeys.value.add(key)
}

const METHOD_TONE: Record<string, string> = {
  GET: 'ok',
  POST: 'accent',
  PUT: 'warn',
  PATCH: 'warn',
  DELETE: 'danger',
}
function methodTone(ep: EndpointSpec) {
  return METHOD_TONE[ep.method.toUpperCase()] ?? 'muted'
}

function invKind(raw: string | InvariantRule): 'must' | 'must-not' {
  return typeof raw === 'string' ? 'must' : (raw.kind ?? 'must')
}
function invText(raw: string | InvariantRule) {
  return typeof raw === 'string' ? raw : raw.statement
}
</script>

<template>
  <section v-if="endpoints.length" class="at-endpoints">
    <header class="at-endpoints__head">
      <div class="at-endpoints__head-top">
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
          <circle cx="5" cy="12" r="2" />
          <circle cx="19" cy="6" r="2" />
          <circle cx="19" cy="18" r="2" />
          <path d="M7 12h4l4-6" />
          <path d="M11 12l4 6" />
        </svg>
        <span class="at-endpoints__title">{{ title || '接口清单' }}</span>
        <span class="at-endpoints__meta">{{ endpoints.length }} 个接口</span>
      </div>
      <div
        v-if="methods.length > 1"
        class="at-endpoints__filters"
        role="group"
        aria-label="按方法筛选"
      >
        <button
          type="button"
          class="at-endpoints__chip"
          :class="{ 'is-active': filter === '*' }"
          @click="filter = '*'"
        >
          全部
        </button>
        <button
          v-for="m in methods"
          :key="m"
          type="button"
          class="at-endpoints__chip"
          :class="{ 'is-active': filter === m }"
          @click="filter = m"
        >
          {{ m }}
        </button>
      </div>
    </header>

    <ul class="at-endpoints__list">
      <li
        v-for="ep in filtered"
        :key="endpointKey(ep)"
        class="at-endpoints__item"
        :class="{ 'is-open': isOpen(ep), 'is-deprecated': ep.deprecated }"
      >
        <button
          type="button"
          class="at-endpoints__row"
          :class="{ 'is-expandable': hasDetail(ep) }"
          :aria-expanded="hasDetail(ep) ? isOpen(ep) : undefined"
          @click="toggle(ep)"
        >
          <span
            class="at-endpoints__chevron"
            :class="{ 'is-on': isOpen(ep), 'is-hidden': !hasDetail(ep) }"
            aria-hidden="true"
          >
            <svg
              viewBox="0 0 24 24"
              width="12"
              height="12"
              fill="none"
              stroke="currentColor"
              stroke-width="2.4"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M9 6l6 6-6 6" />
            </svg>
          </span>
          <span class="at-endpoints__method" :class="`is-${methodTone(ep)}`">{{
            ep.method.toUpperCase()
          }}</span>
          <code class="at-endpoints__path">{{ ep.path }}</code>
          <span class="at-endpoints__summary" :title="ep.summary">{{ ep.summary }}</span>
          <span v-if="ep.deprecated" class="at-endpoints__badge">已退役</span>
          <span v-if="ep.auth" class="at-endpoints__auth">{{ ep.auth }}</span>
        </button>

        <div v-if="isOpen(ep)" class="at-endpoints__detail">
          <div v-if="ep.params?.length" class="at-endpoints__section">
            <p class="at-endpoints__sub">入参</p>
            <table class="at-endpoints__table">
              <thead>
                <tr>
                  <th>参数</th>
                  <th>位置</th>
                  <th>类型</th>
                  <th>必填</th>
                  <th>说明</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="p in ep.params" :key="p.name">
                  <td>
                    <code class="at-endpoints__code">{{ p.name }}</code>
                  </td>
                  <td>
                    <span v-if="p.in" class="at-endpoints__loc">{{ p.in }}</span>
                    <template v-else>—</template>
                  </td>
                  <td>
                    <code v-if="p.type" class="at-endpoints__code at-endpoints__code--type">{{
                      p.type
                    }}</code>
                    <template v-else>—</template>
                  </td>
                  <td class="at-endpoints__req">{{ p.required ? '必填' : '可选' }}</td>
                  <td class="at-endpoints__tdesc">{{ p.desc || '—' }}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div v-if="ep.response?.length" class="at-endpoints__section">
            <p class="at-endpoints__sub">出参</p>
            <table class="at-endpoints__table">
              <thead>
                <tr>
                  <th>字段</th>
                  <th>类型</th>
                  <th>说明</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="f in ep.response" :key="f.name">
                  <td>
                    <code class="at-endpoints__code">{{ f.name }}</code>
                  </td>
                  <td>
                    <code v-if="f.type" class="at-endpoints__code at-endpoints__code--type">{{
                      f.type
                    }}</code>
                    <template v-else>—</template>
                  </td>
                  <td class="at-endpoints__tdesc">{{ f.desc || '—' }}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div v-if="ep.invariants?.length" class="at-endpoints__section">
            <p class="at-endpoints__sub">不变量</p>
            <ul class="at-endpoints__invs">
              <li
                v-for="(raw, i) in ep.invariants"
                :key="i"
                class="at-endpoints__inv"
                :class="`is-${invKind(raw)}`"
              >
                <span class="at-endpoints__inv-mark" aria-hidden="true">
                  <svg
                    v-if="invKind(raw) === 'must'"
                    viewBox="0 0 24 24"
                    width="12"
                    height="12"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2.6"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                  <svg
                    v-else
                    viewBox="0 0 24 24"
                    width="12"
                    height="12"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2.6"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path d="M18 6 6 18" />
                    <path d="M6 6l12 12" />
                  </svg>
                </span>
                <span class="at-endpoints__inv-text">{{ invText(raw) }}</span>
              </li>
            </ul>
          </div>

          <p v-if="ep.note" class="at-endpoints__note">{{ ep.note }}</p>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.at-endpoints {
  margin: 1rem 0;
  border: 1px solid var(--at-border);
  border-radius: var(--at-radius-lg);
  background: var(--at-surface);
  overflow: hidden;
}

.at-endpoints__head {
  padding: 0.6rem 0.95rem 0.55rem;
  border-bottom: 1px solid var(--at-border);
}

.at-endpoints__head-top {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  color: var(--at-text-muted);
}

.at-endpoints__title {
  font-size: 0.85rem;
  font-weight: 600;
  letter-spacing: 0.02em;
}

.at-endpoints__meta {
  margin-left: auto;
  font-size: 0.76rem;
  font-variant-numeric: tabular-nums;
}

.at-endpoints__filters {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  margin-top: 0.5rem;
}

.at-endpoints__chip {
  padding: 0.1rem 0.6rem;
  border: 1px solid var(--at-border);
  border-radius: 999px;
  background: var(--at-bg);
  color: var(--at-text-muted);
  font-size: 0.72rem;
  font-weight: 600;
  cursor: pointer;
  transition:
    border-color 0.12s ease,
    color 0.12s ease;
}

.at-endpoints__chip:hover {
  border-color: var(--at-accent);
  color: var(--at-accent);
}

.at-endpoints__chip.is-active {
  border-color: transparent;
  background: var(--at-accent-soft);
  color: var(--at-accent-strong);
}

.at-endpoints__list {
  margin: 0 !important;
  padding: 0;
  list-style: none;
  background: var(--at-bg);
}

.at-endpoints__item + .at-endpoints__item {
  border-top: 1px solid var(--at-border);
}

/* 行：单行放不下时折成两行——
   「方法 + 路径」一行（路径长到 443px，占满后摘要只剩 8px 宽，等于看不见），
   「摘要 + 权限」换到第二行。用 flex-wrap 而非 grid：展开箭头要跟首行垂直居中。 */
.at-endpoints__row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.3rem 0.55rem;
  width: 100%;
  padding: 0.55rem 0.95rem;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
}

.at-endpoints__row.is-expandable {
  cursor: pointer;
}

.at-endpoints__row.is-expandable:hover {
  background: color-mix(in srgb, var(--at-accent) 5%, transparent);
}

.at-endpoints__item.is-open .at-endpoints__row {
  background: color-mix(in srgb, var(--at-accent) 6%, transparent);
}

.at-endpoints__chevron {
  display: inline-flex;
  flex: none;
  color: var(--at-text-muted);
}

.at-endpoints__chevron svg {
  transition: transform 0.15s ease;
}

.at-endpoints__chevron.is-on svg {
  transform: rotate(90deg);
}

.at-endpoints__chevron.is-hidden {
  visibility: hidden;
}

.at-endpoints__method {
  flex: none;
  min-width: 3.4rem;
  padding: 0.08rem 0.3rem;
  border-radius: var(--at-radius-sm);
  font-family: var(--at-font-mono);
  font-size: 0.66rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-align: center;
}

.at-endpoints__method.is-ok {
  background: color-mix(in srgb, var(--at-ok) 13%, transparent);
  color: var(--at-ok);
}

.at-endpoints__method.is-accent {
  background: var(--at-accent-soft);
  color: var(--at-accent-strong);
}

.at-endpoints__method.is-warn {
  background: color-mix(in srgb, var(--at-warn) 14%, transparent);
  color: var(--at-warn);
}

.at-endpoints__method.is-danger {
  background: color-mix(in srgb, var(--at-danger) 12%, transparent);
  color: var(--at-danger);
}

.at-endpoints__method.is-muted {
  background: var(--at-surface-2);
  color: var(--at-text-muted);
}

.at-endpoints__path {
  flex: 0 1 auto;
  min-width: 0;
  font-family: var(--at-font-mono);
  font-size: 0.79rem;
  font-weight: 600;
  color: var(--at-text);
  /* 长路径在方法后折行，不把整行挤爆 */
  overflow-wrap: anywhere;
}

/* 摘要：允许占满剩余宽度；空间不足时整体落到第二行（与权限并排）。
   旧版是 nowrap + ellipsis——路径吃满后摘要宽度只有 8px，等于完全看不见。 */
.at-endpoints__summary {
  flex: 1 1 12rem;
  min-width: 8rem;
  font-size: 0.82rem;
  color: var(--at-text-2);
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.at-endpoints__auth {
  flex: 0 0 auto;
  margin-left: auto;
  padding: 0.06rem 0.45rem;
  border-radius: var(--at-radius-sm);
  background: var(--at-surface-2);
  color: var(--at-text-muted);
  /* 鉴权门槛常写成中文（「Bearer Token（当前登录租户）」）→ sans */
  font-family: var(--at-font-sans);
  font-size: 0.66rem;
  white-space: nowrap;
}

.at-endpoints__badge {
  flex: none;
  padding: 0.06rem 0.45rem;
  border-radius: var(--at-radius-sm);
  background: color-mix(in srgb, var(--at-danger) 12%, transparent);
  color: var(--at-danger);
  font-size: 0.68rem;
  font-weight: 600;
}

.at-endpoints__item.is-deprecated .at-endpoints__row {
  opacity: 0.55;
}

.at-endpoints__item.is-deprecated .at-endpoints__path {
  text-decoration: line-through;
}

.at-endpoints__detail {
  padding: 0.3rem 1rem 0.9rem 2.4rem;
  border-top: 1px dashed var(--at-border);
  background: color-mix(in srgb, var(--at-surface) 55%, var(--at-bg));
}

.at-endpoints__section + .at-endpoints__section {
  margin-top: 0.65rem;
}

.at-endpoints__sub {
  margin: 0 0 0.3rem !important;
  color: var(--at-text-muted);
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.05em;
}

.at-endpoints__table {
  width: 100%;
  margin: 0 !important;
  border-collapse: collapse;
  font-size: 0.8rem;
}

.at-endpoints__table th {
  padding: 0.25rem 0.7rem 0.25rem 0;
  border-bottom: 1px solid var(--at-border);
  color: var(--at-text-muted);
  font-size: 0.7rem;
  font-weight: 600;
  text-align: left;
  white-space: nowrap;
}

.at-endpoints__table td {
  padding: 0.35rem 0.7rem 0.35rem 0;
  border-bottom: 1px dashed var(--at-border);
  color: var(--at-text-2);
  vertical-align: top;
}

.at-endpoints__table tbody tr:last-child td {
  border-bottom: 0;
}

.at-endpoints__code {
  font-family: var(--at-font-mono);
  font-size: 0.76rem;
  color: var(--at-accent-strong);
}

.at-endpoints__code--type {
  color: var(--at-text-2);
}

.at-endpoints__loc {
  padding: 0.04rem 0.4rem;
  border-radius: var(--at-radius-sm);
  background: var(--at-surface-2);
  color: var(--at-text-muted);
  font-family: var(--at-font-mono);
  font-size: 0.66rem;
}

.at-endpoints__req {
  white-space: nowrap;
  color: var(--at-text-muted);
  font-size: 0.74rem;
}

.at-endpoints__tdesc {
  min-width: 12rem;
}

.at-endpoints__invs {
  display: grid;
  gap: 0.3rem;
  margin: 0 !important;
  padding: 0;
  list-style: none;
}

.at-endpoints__inv {
  display: flex;
  align-items: flex-start;
  gap: 0.45rem;
  margin: 0 !important;
  font-size: 0.8rem;
}

.at-endpoints__inv-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 1.05rem;
  height: 1.05rem;
  margin-top: 0.1rem;
  border-radius: 50%;
  background: color-mix(in srgb, var(--at-ok) 14%, transparent);
  color: var(--at-ok);
}

.at-endpoints__inv.is-must-not .at-endpoints__inv-mark {
  background: color-mix(in srgb, var(--at-danger) 12%, transparent);
  color: var(--at-danger);
}

.at-endpoints__inv-text {
  color: var(--at-text-2);
  line-height: 1.55;
}

.at-endpoints__note {
  margin: 0.65rem 0 0 !important;
  padding-left: 0.6rem;
  border-left: 2px solid var(--at-border-strong);
  color: var(--at-text-muted);
  font-size: 0.78rem;
  line-height: 1.6;
}

@media (max-width: 640px) {
  .at-endpoints__summary {
    flex-basis: 100%;
    white-space: normal;
  }

  .at-endpoints__detail {
    padding-left: 1rem;
  }
}
</style>
