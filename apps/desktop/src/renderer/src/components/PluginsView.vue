<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  AlertTriangle,
  Blocks,
  ChevronDown,
  ExternalLink,
  FolderPlus,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Trash2,
} from 'lucide-vue-next'

import type { PluginRecordView } from '@docvi/shared'

import ComponentPreview from './ComponentPreview.vue'
import { usePluginStore } from '../stores/plugins'
import { useI18n } from '../lib/i18n'

/**
 * 插件面板：列表 + 启停 + 安装/卸载 + 组件示例预览。
 *
 * 三个信息必须一眼可见，否则用户没法做安装决定：
 *  1. **信任等级**——呈现插件只是页面代码，受信服务插件能读整个文件系统；
 *  2. **贡献点摘要**——装了这个会得到什么（组件几个、主题几个）；
 *  3. **加载错误**——manifest 写错时给出可读原因，而不是「插件不见了」。
 *
 * 组件清单默认折叠：一个包动辄 20+ 个组件，全展开会把列表撑成几百屏。
 * 展开后点任一组件，在卡片内就地渲染它的示例文件——「装了什么」变成看得见的东西，
 * 而不是只能读一行动词描述。
 */
const store = usePluginStore()
const { t, locale } = useI18n()

/**
 * 只读宿主（容器版）：插件由平台运维统一管理，读者只能看「装了什么」。
 *
 * 安装 / 卸载 / 启停整组隐藏——容器里的插件清单来自部署器配置，浏览器这边
 * 改了也不会影响任何人，留着开关只会让人以为自己改动了平台。
 */
defineProps<{ readonly?: boolean }>()

onMounted(() => {
  void store.load()
  void store.loadMarket()
})

/** 已展开组件清单的插件名 */
const expanded = ref<Set<string>>(new Set())
/** 正在预览的组件：`<plugin>::<kind>`，同一时刻只预览一个 */
const previewing = ref<string | null>(null)

function toggleExpand(name: string): void {
  const next = new Set(expanded.value)
  if (next.has(name)) {
    next.delete(name)
    // 收起插件时顺手关掉它的预览，避免卡片收起了预览还悬在下面
    if (previewing.value?.startsWith(`${name}::`)) previewing.value = null
  } else {
    next.add(name)
  }
  expanded.value = next
}

function togglePreview(record: PluginRecordView, kind: string): void {
  const key = `${record.name}::${kind}`
  previewing.value = previewing.value === key ? null : key
}

/** 这个组件是否被单独停用 */
function isComponentOff(record: PluginRecordView, kind: string): boolean {
  return record.disabledComponents.includes(kind)
}

/**
 * 切换单个组件。
 *
 * 停用后预览要关掉——否则会看到「已停用」的开关旁边还渲染着它的预览，
 * 两处说法互相矛盾。
 */
function toggleComponent(record: PluginRecordView, kind: string): void {
  const currentlyOff = isComponentOff(record, kind)
  // 从「停用」切回「启用」时关掉预览没有意义；从启用切到停用才需要收起
  if (!currentlyOff && previewing.value === `${record.name}::${kind}`) previewing.value = null
  void store.setComponentEnabled(record.name, kind, currentlyOff)
}

function isPreviewing(record: PluginRecordView, kind: string): boolean {
  return previewing.value === `${record.name}::${kind}`
}

/** 协议字段双形态（string / 语言映射）：按当前语言取，回退中文 */
function lz(value: { zh: string; en?: string }): string {
  return locale.value === 'en' && value.en ? value.en : value.zh
}

const groups = computed(() => {
  const builtin = store.records.filter(record => record.origin === 'builtin')
  const user = store.records.filter(record => record.origin === 'user')
  return [
    { key: 'user', title: t('plugins.installed'), items: user },
    { key: 'builtin', title: t('plugins.builtin'), items: builtin },
  ].filter(group => group.items.length)
})

/**
 * 两个页签：已安装 / 插件市场。
 *
 * 早先是上下堆在同一页：已装插件动辄二十多个组件，市场条目要滚过好几屏才
 * 看得见——用户根本不知道下面还有市场。这两块的心智任务本来也不同：
 * 「已安装」是**管理**（启停、卸载、看贡献点），「市场」是**发现**（有什么能装）。
 */
type PluginsTab = 'installed' | 'market'

const activeTab = ref<PluginsTab>('installed')

/** 市场里能装的条目（未安装的才算候选；已装的只做展示并标注） */
const marketItems = computed(() => store.market)

/** 市场元信息：拉取时间 / 来源 / 离线原因 */
const marketMeta = computed(() => store.marketMeta)

/** 正在刷新市场 */
const refreshing = ref(false)

async function refreshMarket(): Promise<void> {
  if (refreshing.value) return
  refreshing.value = true
  try {
    await store.loadMarket(true)
  } finally {
    refreshing.value = false
  }
}

/** 拉到的时间：显示成「几分钟前」，比一串时间戳好读 */
function fetchedLabel(): string {
  const at = marketMeta.value?.fetchedAt ?? 0
  if (!at) return t('plugins.market.neverFetched')
  const minutes = Math.floor((Date.now() - at) / 60000)
  if (minutes < 1) return t('plugins.market.justNow')
  if (minutes < 60) return t('plugins.market.minutesAgo', { count: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('plugins.market.hoursAgo', { count: hours })
  return t('plugins.market.daysAgo', { count: Math.floor(hours / 24) })
}

/** 打开插件仓库（市场里唯一的动作：去 GitHub 看源码/文档） */
function openRepository(url: string): void {
  window.open(url, '_blank', 'noreferrer')
}

function trustLabel(trust: string): string {
  if (trust === 'presentation') return t('plugins.trust.presentation')
  if (trust === 'sandbox-service') return t('plugins.trust.sandbox')
  return t('plugins.trust.trusted')
}

function trustHint(trust: string): string {
  if (trust === 'presentation') return t('plugins.trust.presentationHint')
  if (trust === 'sandbox-service') return t('plugins.trust.sandboxHint')
  return t('plugins.trust.trustedHint')
}

function contributionSummary(record: (typeof store.records)[number]): string {
  const parts: string[] = []
  const components = record.contributes?.components?.length ?? 0
  const themes = record.contributes?.themes?.length ?? 0
  const syntax = record.contributes?.markdownSyntax?.length ?? 0
  const commands = record.contributes?.commands?.length ?? 0
  if (components) parts.push(t('plugins.contrib.components', { count: components }))
  if (themes) parts.push(t('plugins.contrib.themes', { count: themes }))
  if (syntax) parts.push(t('plugins.contrib.syntax', { count: syntax }))
  if (commands) parts.push(t('plugins.contrib.commands', { count: commands }))
  return parts.join(' · ') || t('plugins.contrib.none')
}
</script>

<template>
  <div class="plugins">
    <div class="plugins__inner">
      <div class="plugins__head">
        <div>
          <h1 class="plugins__title">{{ t('plugins.title') }}</h1>
          <p class="plugins__sub">{{ t('plugins.subtitle') }}</p>
        </div>
        <button v-if="!readonly" class="btn btn--primary" type="button" @click="store.install()">
          <FolderPlus :size="15" :stroke-width="1.8" />
          <span>{{ t('plugins.install') }}</span>
        </button>
      </div>

      <!--
        两个页签取代原来的上下堆叠。「已安装」是管理（启停/卸载/看贡献点），
        「插件市场」是发现（远端清单里有什么、去哪拿源码）——任务不同，不该
        共用一屏滚动。
      -->
      <div class="tabs" role="tablist">
        <button
          class="tabs__item"
          type="button"
          role="tab"
          :aria-selected="activeTab === 'installed'"
          :class="{ 'is-active': activeTab === 'installed' }"
          @click="activeTab = 'installed'"
        >
          {{ t('plugins.tab.installed') }}
          <span class="tabs__count">{{ store.records.length }}</span>
        </button>
        <button
          class="tabs__item"
          type="button"
          role="tab"
          :aria-selected="activeTab === 'market'"
          :class="{ 'is-active': activeTab === 'market' }"
          @click="activeTab = 'market'"
        >
          {{ t('plugins.tab.market') }}
          <span v-if="marketItems.length" class="tabs__count">{{ marketItems.length }}</span>
        </button>
      </div>

      <!-- ============ 已安装 ============ -->
      <div v-if="activeTab === 'installed'" role="tabpanel">
        <div v-if="store.loading && !store.records.length" class="plugins__empty">
          {{ t('plugins.loading') }}
        </div>
        <div v-else-if="!store.records.length" class="plugins__empty">
          <Blocks :size="26" :stroke-width="1.4" />
          <p>{{ t('empty.plugins') }}</p>
        </div>

        <section v-for="group in groups" :key="group.key" class="group">
          <h2 class="group__title">{{ group.title }}</h2>
          <div class="list">
            <article
              v-for="record in group.items"
              :key="record.name"
              class="card"
              :class="{ 'is-off': !record.enabled, 'is-error': record.error }"
            >
              <div class="card__main">
                <div class="card__title-row">
                  <h3 class="card__name">{{ record.displayName.zh }}</h3>
                  <span class="card__version">v{{ record.version }}</span>
                  <span class="badge" :class="`badge--${record.trust}`">
                    <ShieldAlert
                      v-if="record.trust === 'trusted-service'"
                      :size="11"
                      :stroke-width="2"
                    />
                    <ShieldCheck v-else :size="11" :stroke-width="2" />
                    {{ trustLabel(record.trust) }}
                  </span>
                </div>
                <p class="card__desc">
                  {{ lz(record.description ?? record.displayName) || contributionSummary(record) }}
                </p>
                <p class="card__summary">{{ contributionSummary(record) }}</p>
                <p v-if="record.error" class="card__error">
                  <AlertTriangle :size="12" :stroke-width="2" />
                  <span>{{ record.error }}</span>
                </p>
                <p v-else class="card__trust">{{ trustHint(record.trust) }}</p>

                <!-- 组件清单：默认折叠，展开后可逐个预览示例 -->
                <div v-if="record.contributes?.components?.length" class="comps">
                  <button
                    class="comps__toggle"
                    type="button"
                    :aria-expanded="expanded.has(record.name)"
                    @click="toggleExpand(record.name)"
                  >
                    <ChevronDown
                      :size="12"
                      :stroke-width="2"
                      class="comps__chevron"
                      :class="{ 'is-open': expanded.has(record.name) }"
                    />
                    <span>{{
                      t('plugins.components.toggle', {
                        count: record.contributes.components.length,
                      })
                    }}</span>
                  </button>
                  <ul v-if="expanded.has(record.name)" class="comps__list">
                    <li
                      v-for="item in record.contributes.components"
                      :key="item.kind"
                      class="comp"
                      :class="{ 'is-off': isComponentOff(record, item.kind) }"
                    >
                      <!-- 预览按钮与开关是兄弟节点：button 里不能再嵌可交互元素 -->
                      <div class="comp__row-wrap">
                        <button
                          class="comp__row"
                          type="button"
                          :class="{ 'is-open': isPreviewing(record, item.kind) }"
                          :aria-expanded="isPreviewing(record, item.kind)"
                          @click="togglePreview(record, item.kind)"
                        >
                          <code class="comp__kind">{{ item.kind }}</code>
                          <span class="comp__title">{{ lz(item.title) }}</span>
                          <span class="comp__desc">{{ lz(item.description) }}</span>
                        </button>
                        <!--
                        逐组件开关：两个包声明同一 kind 时，关掉其中一个，另一个实现
                        自动顶上来——这就是「同名切换」，不需要单独的切换 UI。
                      -->
                        <button
                          v-if="!readonly"
                          v-tooltip="
                            isComponentOff(record, item.kind)
                              ? t('plugins.components.enable')
                              : t('plugins.components.disable')
                          "
                          class="comp__switch"
                          type="button"
                          role="switch"
                          :aria-checked="!isComponentOff(record, item.kind)"
                          :aria-label="`${lz(item.title)}（${item.kind}）`"
                          :data-kind="item.kind"
                          @click="toggleComponent(record, item.kind)"
                        >
                          <span class="switch__knob" />
                        </button>
                      </div>
                      <ComponentPreview
                        v-if="isPreviewing(record, item.kind) && item.example"
                        :plugin="record.name"
                        :kind="item.kind"
                        :example="item.example"
                        @close="previewing = null"
                      />
                      <p v-else-if="isPreviewing(record, item.kind)" class="comp__no-example">
                        {{ t('plugins.preview.noExample') }}
                      </p>
                    </li>
                  </ul>
                </div>
              </div>

              <div v-if="!readonly" class="card__actions">
                <button
                  class="switch"
                  type="button"
                  :class="{ 'is-on': record.enabled }"
                  :disabled="!!record.error"
                  :aria-pressed="record.enabled"
                  :aria-label="record.enabled ? t('plugins.disable') : t('plugins.enable')"
                  @click="store.setEnabled(record.name, !record.enabled)"
                >
                  <span class="switch__knob" />
                </button>
                <button
                  v-if="record.origin === 'user'"
                  v-tooltip="t('plugins.uninstall')"
                  class="card__remove"
                  type="button"
                  :aria-label="t('plugins.uninstall')"
                  @click="store.remove(record.name)"
                >
                  <Trash2 :size="14" :stroke-width="1.7" />
                </button>
              </div>
            </article>
          </div>
        </section>
      </div>

      <!-- ============ 插件市场 ============ -->
      <div v-else role="tabpanel">
        <!--
          市场头部：来源地址 + 缓存时间 + 刷新。
          市场是**远端配置文件**（GitHub 上的 market.json），所以「你看到的是
          什么时候的清单」必须显式——否则拉取失败时用户会以为市场里就这些插件。
        -->
        <div class="market-head">
          <div class="market-head__meta">
            <span class="market-head__label">{{ t('plugins.market.source') }}</span>
            <code class="market-head__url">{{ marketMeta?.sourceUrl || '—' }}</code>
            <span class="market-head__time">{{ fetchedLabel() }}</span>
          </div>
          <button
            class="btn btn--ghost btn--sm"
            type="button"
            :disabled="refreshing || readonly"
            @click="refreshMarket()"
          >
            <RefreshCw :size="13" :stroke-width="1.8" :class="{ 'is-spinning': refreshing }" />
            <span>{{
              refreshing ? t('plugins.market.refreshing') : t('plugins.market.refresh')
            }}</span>
          </button>
        </div>

        <p v-if="marketMeta?.error" class="market-offline">{{ marketMeta.error }}</p>

        <div v-if="!marketItems.length" class="plugins__empty">
          <Blocks :size="26" :stroke-width="1.4" />
          <p>
            {{ marketMeta?.error ? t('plugins.market.emptyOffline') : t('plugins.market.empty') }}
          </p>
        </div>

        <div v-else class="list">
          <article v-for="entry in marketItems" :key="entry.name" class="card card--market">
            <div class="card__main">
              <div class="card__title-row">
                <h3 class="card__name">{{ lz(entry.displayName) }}</h3>
                <span class="card__version">v{{ entry.version }}</span>
                <span class="badge" :class="`badge--${entry.trust}`">
                  <ShieldAlert
                    v-if="entry.trust === 'trusted-service'"
                    :size="11"
                    :stroke-width="2"
                  />
                  <ShieldCheck v-else :size="11" :stroke-width="2" />
                  {{ trustLabel(entry.trust) }}
                </span>
                <span v-if="store.isInstalled(entry.name)" class="card__tag card__tag--on">
                  {{ t('plugins.market.installed') }}
                </span>
              </div>
              <p class="card__desc">{{ lz(entry.description ?? entry.displayName) }}</p>
              <p v-if="entry.tags?.length" class="card__tags">
                <span v-for="tag in entry.tags" :key="tag" class="card__tag">{{ tag }}</span>
              </p>
            </div>
            <div class="card__actions">
              <button
                class="btn btn--ghost btn--sm"
                type="button"
                @click="openRepository(entry.repository)"
              >
                <ExternalLink :size="13" :stroke-width="1.8" />
                <span>{{ t('plugins.market.repository') }}</span>
              </button>
            </div>
          </article>
        </div>

        <!--
          为什么这里没有「安装」按钮：桌面端没有解压库（安装包刻意零运行时依赖），
          下载 tarball → 解压 → 校验这条链只有容器运维面有。给一个点了必然失败
          的按钮，比不给按钮更糟。
        -->
        <p v-if="!readonly" class="market-note">{{ t('plugins.market.installHint') }}</p>
      </div>

      <p v-if="store.error" class="plugins__error">{{ store.error }}</p>
    </div>
  </div>
</template>

<style scoped>
/* 外层吃满画布宽度当滚动容器，内层才是限宽内容列——否则滚动条浮在列右缘 */
.plugins {
  height: 100%;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.plugins__inner {
  max-width: 1100px;
  margin: 0 auto;
  padding: 32px 32px 64px;
}

.plugins__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 24px;
}

.plugins__title {
  margin: 0 0 6px;
  font-size: 20px;
  font-weight: 620;
  letter-spacing: -0.01em;
  color: var(--dv-ui-text);
}

.plugins__sub {
  margin: 0;
  max-width: 520px;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--dv-ui-text-muted);
}

/*
 * 页签：与设置页同一套（文字按钮 + 底部细线，当前项浮起表面 3）。
 * 不复用「大标签」样式——插件页不是导航容器，两个页签只是把管理与发展分开。
 */
.tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 20px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--dv-ui-line-soft);
}

.tabs__item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 11px;
  border: 1px solid transparent;
  border-radius: var(--dv-ui-radius-sm);
  background: transparent;
  color: var(--dv-ui-text-muted);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition:
    background var(--dv-ui-dur-1) var(--dv-ui-ease),
    color var(--dv-ui-dur-1) var(--dv-ui-ease);
}

.tabs__item:hover {
  background: var(--dv-ui-surface-2);
  color: var(--dv-ui-text-2);
}

.tabs__item.is-active {
  background: var(--dv-ui-surface-3);
  color: var(--dv-ui-text);
}

.tabs__count {
  padding: 0 5px;
  border-radius: 999px;
  background: var(--dv-ui-surface-3);
  font-size: 10.5px;
  line-height: 15px;
  color: var(--dv-ui-text-dim);
}

.tabs__item.is-active .tabs__count {
  background: var(--dv-ui-bg);
  color: var(--dv-ui-text-muted);
}

/* 市场头部：来源地址 + 缓存时间 + 刷新，一条紧凑的元信息行 */
.market-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

.market-head__meta {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-size: 11.5px;
  color: var(--dv-ui-text-dim);
}

.market-head__label {
  flex: none;
}

.market-head__url {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--dv-font-mono, ui-monospace, monospace);
  font-size: 10.5px;
  color: var(--dv-ui-text-muted);
}

.market-head__time {
  flex: none;
}

/* 离线提示：市场拉取失败但仍有缓存时出现，不能做成红色错误条——功能仍可用 */
.market-offline {
  margin: 0 0 14px;
  padding: 8px 12px;
  border: 1px solid var(--dv-ui-line);
  border-left: 2px solid var(--dv-ui-warn, #cba45f);
  border-radius: var(--dv-ui-radius-sm);
  background: var(--dv-ui-surface-1);
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--dv-ui-text-muted);
}

/* 没有安装按钮的原因说明 */
.market-note {
  margin: 16px 0 0;
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--dv-ui-text-dim);
}

.is-spinning {
  animation: spin 0.9s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.btn {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 32px;
  flex: none;
  padding: 0 14px;
  border: 1px solid transparent;
  border-radius: var(--dv-ui-radius-sm);
  background: var(--dv-ui-accent);
  color: var(--dv-ui-accent-fg);
  font-size: 12.5px;
  font-weight: 560;
  cursor: pointer;
}

.btn:hover {
  background: var(--dv-ui-accent-strong);
}

.plugins__empty {
  margin: 14vh auto 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  max-width: 380px;
  text-align: center;
  font-size: 12.5px;
  color: var(--dv-ui-text-dim);
}

.group {
  margin-bottom: 26px;
}

.group__title {
  /* 小标题与市场说明同一行：说明是给这个分区做注解的，不该另起一行抢位置 */
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 0 0 10px;
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--dv-ui-text-dim);
}

.group__hint {
  font-size: 10.5px;
  font-weight: 400;
  letter-spacing: 0;
  text-transform: none;
  color: var(--dv-ui-text-dim);
  opacity: 0.8;
}

/* 市场卡片：虚线边框与已装卡片区分开（「还没装」是一眼要看出来的状态） */
.card--market {
  border-style: dashed;
}

.card__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin: 6px 0 0;
}

.card__tag {
  padding: 1px 6px;
  border: 1px solid var(--dv-ui-line-soft);
  border-radius: 999px;
  color: var(--dv-ui-text-dim);
  font-size: 10px;
  white-space: nowrap;
}

/* 市场里「已安装」的状态标记：强调色描边，与中性 tag 区分开 */
.card__tag--on {
  border-color: color-mix(in srgb, var(--dv-ui-accent) 42%, transparent);
  color: var(--dv-ui-accent);
}

/* 市场里已安装的条目：位置留给按钮的地方换成状态字，弱化成提示而不是操作 */

.btn--sm {
  height: 26px;
  padding: 0 10px;
  font-size: 11.5px;
}

.list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.card {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  padding: 14px 16px;
  border: 1px solid var(--dv-ui-line-soft);
  border-radius: var(--dv-ui-radius-md);
  background: var(--dv-ui-surface-1);
}

.card.is-off {
  opacity: 0.62;
}

.card.is-error {
  border-color: color-mix(in srgb, var(--dv-ui-danger) 45%, var(--dv-ui-line-soft));
}

.card__main {
  flex: 1;
  min-width: 0;
}

.card__title-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.card__name {
  margin: 0;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--dv-ui-text);
}

.card__version {
  font-size: 11px;
  color: var(--dv-ui-text-dim);
  font-variant-numeric: tabular-nums;
}

.badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--dv-ui-surface-2);
  font-size: 10.5px;
  color: var(--dv-ui-text-muted);
}

.badge--trusted-service {
  background: color-mix(in srgb, var(--dv-ui-danger) 16%, transparent);
  color: var(--dv-ui-danger);
}

.card__desc {
  margin: 7px 0 4px;
  font-size: 12.5px;
  line-height: 1.65;
  color: var(--dv-ui-text-2);
}

.card__summary {
  margin: 0;
  font-size: 11.5px;
  color: var(--dv-ui-text-muted);
}

.card__trust {
  margin: 6px 0 0;
  font-size: 11px;
  color: var(--dv-ui-text-dim);
}

.card__error {
  display: flex;
  align-items: flex-start;
  gap: 5px;
  margin: 7px 0 0;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--dv-ui-danger);
}

.card__actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
}

.switch {
  position: relative;
  width: 34px;
  height: 20px;
  border: 1px solid var(--dv-ui-line);
  border-radius: 999px;
  background: var(--dv-ui-surface-3);
  cursor: pointer;
  transition: background var(--dv-ui-dur-1) var(--dv-ui-ease);
}

.switch.is-on {
  background: var(--dv-ui-accent);
  border-color: transparent;
}

.switch:disabled {
  opacity: 0.4;
  cursor: default;
}

.switch__knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--dv-ui-text);
  transition: transform var(--dv-ui-dur-1) var(--dv-ui-ease);
}

.switch.is-on .switch__knob {
  transform: translateX(14px);
  background: var(--dv-ui-accent-fg);
}

.card__remove {
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  border: none;
  border-radius: var(--dv-ui-radius-sm);
  background: transparent;
  color: var(--dv-ui-text-dim);
  cursor: pointer;
}

.card__remove:hover {
  background: var(--dv-ui-surface-3);
  color: var(--dv-ui-danger);
}

.plugins__error {
  margin-top: 12px;
  font-size: 12px;
  color: var(--dv-ui-danger);
}

/* ---------- 组件清单与示例预览 ---------- */

.comps {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed var(--dv-ui-line-soft);
}

.comps__toggle {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--dv-ui-text-muted);
  font-size: 11.5px;
  cursor: pointer;
}

.comps__toggle:hover {
  color: var(--dv-ui-text);
}

.comps__chevron {
  transition: transform 0.15s ease;
}

.comps__chevron.is-open {
  transform: rotate(180deg);
}

.comps__list {
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.comp__row-wrap {
  display: flex;
  align-items: center;
  gap: 6px;
}

.comp__row {
  flex: 1;
  min-width: 0;
  display: grid;
  grid-template-columns: 130px 88px 1fr;
  align-items: baseline;
  gap: 10px;
  padding: 5px 8px;
  border: none;
  border-radius: var(--dv-ui-radius-sm);
  background: transparent;
  color: var(--dv-ui-text-2);
  text-align: left;
  cursor: pointer;
}

/* 逐组件开关：比整包开关小一号，视觉上明确是「包内子项」 */
.comp__switch {
  position: relative;
  flex: none;
  width: 26px;
  height: 15px;
  padding: 0;
  border: 1px solid var(--dv-ui-line);
  border-radius: 8px;
  background: var(--dv-ui-surface-3);
  cursor: pointer;
  transition: background var(--dv-dur-1, 130ms) ease;
}

.comp__switch .switch__knob {
  position: absolute;
  top: 1px;
  left: 1px;
  width: 11px;
  height: 11px;
  border-radius: 50%;
  background: var(--dv-ui-text-muted);
  transition: transform var(--dv-dur-1, 130ms) ease;
}

.comp__switch[aria-checked='true'] {
  background: var(--dv-ui-accent);
  border-color: transparent;
}

.comp__switch[aria-checked='true'] .switch__knob {
  background: #fff;
  transform: translateX(11px);
}

/* 停用的组件行整体压暗，但名称仍可读——用户要能看出它还在、只是关着 */
.comp.is-off .comp__kind,
.comp.is-off .comp__title,
.comp.is-off .comp__desc {
  opacity: 0.45;
}

.comp__row:hover,
.comp__row.is-open {
  background: var(--dv-ui-surface-2);
}

.comp__kind {
  font-family: var(--dv-font-mono, ui-monospace, monospace);
  font-size: 11px;
  color: var(--dv-ui-text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
}

.comp__row.is-open .comp__kind {
  color: var(--dv-ui-accent);
}

.comp__title {
  font-size: 12px;
  color: var(--dv-ui-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.comp__desc {
  font-size: 11.5px;
  color: var(--dv-ui-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.comp__no-example {
  margin: 6px 0 10px;
  padding: 8px 10px;
  border-radius: var(--dv-ui-radius-sm);
  background: var(--dv-ui-surface-2);
  font-size: 11.5px;
  color: var(--dv-ui-text-muted);
}
</style>
