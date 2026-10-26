<script setup lang="ts">
/**
 * TableTabs —— 表设计分页签浏览（一表一页签 + 表间关系）。
 *
 * 表设计场景的唯一组件（合并原 DataModel 能力）：
 * - 每个页签下是一张完整的字段表（字段名 / 中文名 / 类型 / 键 / 业务说明），
 *   不再是「一行塞一张表」的汇总表；
 * - 传 `relations` 时在表格末尾渲染表间关系脚注（from → label → to，语义见 relation.label），
 *   跨表引用一眼看全；脚注跟随内容滚动、**不做底部吸附**（全屏时吸附会被推到
 *   屏幕最底部，屏幕越大离表格越远）；
 * - 单表（只传一张）时不渲染页签栏，等价于「单表字段设计」形态。
 *
 * 尺寸与交互约定：
 * - 组件高度上限 = 一屏可用高度（calc(100vh - 8rem)），表格在组件内部滚动：
 *   横向滚动条始终在可视区内（否则要先把页面滚到底才能看到）；
 * - 页签栏固定在滚动区之外——无论怎么滚，页签都不动；
 * - 全屏：原生 Fullscreen API，整个组件（含页签栏）一起全屏；不可用时
 *   （嵌入式 iframe 等）退化为 fixed 覆盖层，Esc 退出。
 *
 * 用法（Markdown）：页面 script setup 里定义 tables / relations，正文写
 *
 * <TableTabs title="订单系统表设计" :tables="tables" :relations="relations" />
 *
 * 数据协议见 types.ts：
 *   TableSpec    = { name, cn?, note?, fields: TableField[] }
 *   TableField   = { name, cn?, type?, key?, note? }   // key 如 PK / UK / FK / 索引
 *   DataRelation = { from, to, label? }                // 表间关系（可选）
 */
import { computed, ref, watch } from 'vue'
import { useFullscreen } from './fullscreen'
import type { DataRelation, TableSpec } from './types'

const props = withDefaults(
  defineProps<{
    /** 各表定义（一个页签一张表；单表时不渲染页签栏） */
    tables: TableSpec[]
    /** 标题（可选，显示在顶栏） */
    title?: string
    /** 表间关系（from → to，可带语义标注；跨表引用与一对多粒度） */
    relations?: DataRelation[]
  }>(),
  { title: '', relations: () => [] },
)

const activeIndex = ref(0)
const active = computed<TableSpec | undefined>(
  () => props.tables[activeIndex.value] ?? props.tables[0],
)

// 数据替换（路由切换等）后索引越界时回退到第一张表
watch(
  () => props.tables.length,
  length => {
    if (activeIndex.value >= length) activeIndex.value = 0
  },
)

// ── 全屏：原生 API 优先，失败退化为覆盖层（兜底逻辑与 TableGraph 共用 ./fullscreen） ──
const rootRef = ref<HTMLElement | null>(null)
const { isFullscreen, overlay, toggle: toggleFullscreen } = useFullscreen(rootRef)
</script>

<template>
  <figure ref="rootRef" class="at-tabletabs" :class="{ 'is-overlay': overlay }">
    <header class="at-tabletabs__head">
      <span class="at-tabletabs__title">{{ title || '表设计' }}</span>
      <span v-if="tables.length > 1" class="at-tabletabs__meta">{{ tables.length }} 张表</span>
      <button
        type="button"
        class="at-tabletabs__fs"
        :aria-pressed="isFullscreen"
        :aria-label="isFullscreen ? '退出全屏' : '全屏查看'"
        @click="toggleFullscreen"
      >
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
          <template v-if="!isFullscreen">
            <path d="M8 3H5a2 2 0 0 0-2 2v3" />
            <path d="M16 3h3a2 2 0 0 1 2 2v3" />
            <path d="M8 21H5a2 2 0 0 1-2-2v-3" />
            <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
          </template>
          <template v-else>
            <path d="M8 3v3a2 2 0 0 1-2 2H3" />
            <path d="M16 3v3a2 2 0 0 0 2 2h3" />
            <path d="M8 21v-3a2 2 0 0 0-2-2H3" />
            <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
          </template>
        </svg>
        {{ isFullscreen ? '退出全屏' : '全屏' }}
      </button>
    </header>

    <div
      v-if="tables.length > 1"
      class="at-tabletabs__tabs"
      role="tablist"
      :aria-label="title || '表设计'"
    >
      <button
        v-for="(table, index) in tables"
        :key="table.name"
        type="button"
        role="tab"
        class="at-tabletabs__tab"
        :class="{ 'is-active': index === activeIndex }"
        :aria-selected="index === activeIndex"
        @click="activeIndex = index"
      >
        <span class="at-tabletabs__tab-cn">{{ table.cn || table.name }}</span>
        <span class="at-tabletabs__tab-name">{{ table.name }}</span>
      </button>
    </div>

    <div class="at-tabletabs__body">
      <p v-if="active?.note" class="at-tabletabs__note">{{ active.note }}</p>
      <table v-if="active && active.fields.length" class="at-tabletabs__table">
        <thead>
          <tr>
            <th>字段名</th>
            <th>中文名</th>
            <th>类型</th>
            <th>键</th>
            <th>业务说明</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="field in active.fields" :key="field.name">
            <td class="at-tabletabs__cell-name">
              <code>{{ field.name }}</code>
            </td>
            <td>{{ field.cn || '—' }}</td>
            <td class="at-tabletabs__cell-type">
              <code>{{ field.type || '—' }}</code>
            </td>
            <td>
              <span v-if="field.key" class="at-tabletabs__key">{{ field.key }}</span
              ><template v-else>—</template>
            </td>
            <td class="at-tabletabs__cell-note">{{ field.note || '—' }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="at-tabletabs__empty">（暂无字段数据）</p>

      <!--
        表间关系放在**滚动内容末尾**，不做底部吸附。
        全屏时容器是 flex 列 + body flex:1；脚注若留在 body 之外会被推到整屏
        最底部——屏幕越大离表格越远，读者得低头去找（用户实测「全屏还是会在
        底部吸附一排内容」）。放进 body 后它成为表格的延续，任何尺寸下位置都成立。
      -->
      <ul v-if="relations.length" class="at-tabletabs__rels" aria-label="表间关系">
        <li v-for="(relation, index) in relations" :key="index" class="at-tabletabs__rel">
          <span class="at-tabletabs__rel-name">{{ relation.from }}</span>
          <span class="at-tabletabs__rel-arrow" aria-hidden="true">→</span>
          <span v-if="relation.label" class="at-tabletabs__rel-label">{{ relation.label }}</span>
          <span class="at-tabletabs__rel-name">{{ relation.to }}</span>
        </li>
      </ul>
    </div>
  </figure>
</template>

<style scoped>
.at-tabletabs {
  display: flex;
  flex-direction: column;
  margin: 1rem 0;
  border: 1px solid var(--at-border);
  border-radius: var(--at-radius-lg);
  background: var(--at-surface);
  overflow: hidden;
  /* 正文态不限高（2026-10-18 拍板「反正有全屏」）：整表随页面自然滚动，
     限高会在 1000+ 高屏上留一大块空白、还得在卡片里再滚一次。 */
}

.at-tabletabs:fullscreen,
.at-tabletabs.is-overlay {
  /* 覆盖层用 fixed + inset 定高：正文态的 margin: 1rem 0 会再从 inset 里扣掉
     上下各 1rem，容器比视口矮 2rem；原生全屏由 UA 归零，这里统一写死 */
  margin: 0;
  max-height: none;
  border: none;
  border-radius: 0;
}

.at-tabletabs:fullscreen {
  height: 100%;
}

/* 覆盖层：居中模态（四周留白 + 圆角），不铺满整屏贴底——
   大屏上铺满会让表格顶到最上、关系脚注沉到最下（2026-10-19 用户反馈）。 */
.at-tabletabs.is-overlay {
  position: fixed;
  inset: 3vh 4vw;
  z-index: 1000;
  border: 1px solid var(--at-border);
  border-radius: var(--at-radius-lg);
  box-shadow: var(--at-shadow);
}

.at-tabletabs__head {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.5rem 0.9rem;
  border-bottom: 1px solid var(--at-border);
}

.at-tabletabs__title {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--at-text-muted);
  letter-spacing: 0.02em;
}

.at-tabletabs__meta {
  margin-left: auto;
  color: var(--at-text-muted);
  font-size: 0.76rem;
  font-variant-numeric: tabular-nums;
}

.at-tabletabs__fs {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
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

.at-tabletabs__fs:hover {
  border-color: var(--at-accent);
  color: var(--at-accent);
}

.at-tabletabs__tabs {
  display: flex;
  gap: 0.15rem;
  padding: 0 0.6rem;
  border-bottom: 1px solid var(--at-border);
  overflow-x: auto;
  scrollbar-width: thin;
}

.at-tabletabs__tab {
  display: inline-flex;
  align-items: baseline;
  gap: 0.4rem;
  padding: 0.5rem 0.7rem;
  margin-bottom: -1px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: none;
  color: var(--at-text-2);
  font-size: 0.82rem;
  white-space: nowrap;
  cursor: pointer;
}

.at-tabletabs__tab:hover {
  color: var(--at-accent);
}

.at-tabletabs__tab.is-active {
  color: var(--at-accent-strong);
  border-bottom-color: var(--at-accent);
  font-weight: 600;
}

.at-tabletabs__tab-name {
  font-family: var(--at-font-mono);
  font-size: 0.72rem;
  color: var(--at-text-muted);
}

.at-tabletabs__tab.is-active .at-tabletabs__tab-name {
  color: var(--at-accent);
}

.at-tabletabs__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  background: var(--at-bg);
}

/*
 * 全屏 / 覆盖层：表体吃满剩余高度，行数不够的表下方会留出一整块。
 * 那里改与卡片同色——用更深的页面底色会形成明显异色区，看着像「底部一块
 * 没渲染」；同色则读作「表格到此结束」。
 */
.at-tabletabs:fullscreen .at-tabletabs__body,
.at-tabletabs.is-overlay .at-tabletabs__body {
  background: var(--at-surface);
}

.at-tabletabs__note {
  margin: 0 !important;
  padding: 0.5rem 0.9rem;
  border-bottom: 1px solid var(--at-border);
  background: var(--at-surface);
  color: var(--at-text-muted);
  font-size: 0.78rem;
}

.at-tabletabs__table {
  width: 100%;
  /* 720px 时「业务说明」列也是唯一可伸缩列，中文名列会被挤到逐字竖排
     （用户实测「全局预处 / 理开 / 关」）。抬到 880px 并把最小宽度分给各列，
     让中文名与类型能单行显示；容器内横向滚动条本身就在可视区内。 */
  min-width: 880px;
  border-collapse: collapse;
  font-size: 0.85rem;
}

.at-tabletabs__table th {
  position: sticky;
  top: 0;
  z-index: 1;
  padding: 0.45rem 0.9rem;
  border-bottom: 1px solid var(--at-border);
  background: var(--at-surface);
  color: var(--at-text-muted);
  font-size: 0.76rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  text-align: left;
  white-space: nowrap;
}

.at-tabletabs__table td {
  padding: 0.45rem 0.9rem;
  border-bottom: 1px solid var(--at-border);
  color: var(--at-text-2);
  vertical-align: top;
}

/* 短列锁最小宽度：中文名、类型、键都不该被长字段名/长说明挤扁。
   表格整体已有 880px 最小宽，这些列在最窄布局下也放得下两三个词。
   中文名列 8rem（128px）保证 9 字中文名（全局预处理同步状态 ≈ 122px）单行；
   业务说明列随之收窄到 13rem，避免把表格总宽推出卡片可视区。 */
.at-tabletabs__table td:nth-child(2) {
  min-width: 8rem;
}

.at-tabletabs__table td:nth-child(3) {
  min-width: 5.5rem;
  white-space: nowrap;
}

.at-tabletabs__table td:nth-child(4) {
  min-width: 3.2rem;
  white-space: nowrap;
}

.at-tabletabs__table tbody tr:last-child td {
  border-bottom: none;
}

.at-tabletabs__cell-name code,
.at-tabletabs__cell-type code {
  font-family: var(--at-font-mono);
  font-size: 0.8rem;
}

.at-tabletabs__cell-name code {
  color: var(--at-accent-strong);
}

.at-tabletabs__cell-note {
  min-width: 13rem;
}

.at-tabletabs__key {
  display: inline-block;
  padding: 0.05rem 0.4rem;
  border-radius: 999px;
  background: var(--at-accent-soft);
  color: var(--at-accent-strong);
  font-family: var(--at-font-mono);
  font-size: 0.72rem;
}

.at-tabletabs__empty {
  margin: 0 !important;
  padding: 2rem 0;
  text-align: center;
  color: var(--at-text-muted);
  font-size: 0.85rem;
}

.at-tabletabs__rels {
  display: flex;
  flex-wrap: wrap;
  gap: 0.45rem;
  margin: 0 !important;
  padding: 0.5rem 0.9rem;
  border-top: 1px solid var(--at-border);
  list-style: none;
}

.at-tabletabs__rel {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.22rem 0.6rem;
  border-radius: 999px;
  background: color-mix(in srgb, var(--at-accent) 7%, transparent);
  font-size: 0.78rem;
}

.at-tabletabs__rel-name {
  font-family: var(--at-font-mono);
  font-weight: 600;
  color: var(--at-text);
}

.at-tabletabs__rel-arrow {
  color: var(--at-accent);
}

.at-tabletabs__rel-label {
  color: var(--at-text-muted);
  font-size: 0.74rem;
}
</style>
