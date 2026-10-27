<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  Bot,
  Check,
  Copy,
  Eye,
  EyeOff,
  ExternalLink,
  FileText,
  FolderOpen,
  Link2,
  Power,
  RefreshCw,
  Server,
  Trash2,
  Wifi,
} from 'lucide-vue-next'

import type { DesktopPrefsState, RuntimeInfo, UpdateCheckResult, UpdatePhase } from '@docvi/shared'

import { useServiceStore } from '../stores/service'
import { useTabsStore } from '../stores/tabs'
import { useThemeStore } from '../stores/app'
import { LOCALES, useI18n } from '../lib/i18n'
import ThemePicker from './ThemePicker.vue'

/**
 * 设置：本地服务（MCP）与临时分享。
 *
 * 这一页要回答三个问题，顺序也是用户的实际顺序：
 *  1. 服务在跑吗？端口多少？（状态行 + 重启按钮）
 *  2. 我该怎么连？（端点 + 令牌，一键复制成 MCP 客户端配置）
 *  3. 我在分享什么？（列表 + 新建，停用即失效）
 */
const props = defineProps<{
  /** 深链分区：右键标签「标签页设置」直接跳到这里 */
  section?: 'general' | 'tabs' | 'service' | 'about'
  /**
   * 只读宿主（容器版）：本地服务、临时分享、桌面外壳都不存在。
   *
   * 服务分区整块隐藏，剩下「外观 / 标签页」——那两项是纯前端偏好，
   * 容器里同样有（存在 localStorage）。
   */
  readonly?: boolean
}>()

const emit = defineEmits<{
  'open-section': [section: 'general' | 'tabs' | 'service' | 'about']
}>()

const store = useServiceStore()
const tabs = useTabsStore()
const theme = useThemeStore()
const { t, locale, setLocale } = useI18n()

/** 源码折行的两个档位（值来自 @docvi/shared 的 EditorWrap） */
const WRAP_OPTIONS = computed(() => [
  { id: 'wrap' as const, label: t('status.wrapOn') },
  { id: 'nowrap' as const, label: t('status.wrapOff') },
])

/**
 * 标签页设置：直接改内存里的 preferences，由 App 的 watch 写回 settings.json。
 *
 * 这里不做本地副本——设置是单一事实源，多一份副本就一定会有「界面显示 A、
 * 实际用 B」的时刻。
 */
function patchTabs(patch: Partial<typeof tabs.preferences>): void {
  tabs.setPreferences({ ...tabs.preferences, ...patch })
  void window.docvi.settingsWrite({ tabs: patch })
}

const activeSection = computed(() => {
  // 容器版没有服务分区：深链指过来（旧书签 / 命令）时落回外观
  if (props.readonly && props.section === 'service') return 'general'
  if (props.readonly && props.section === 'about') return 'about'
  return props.section ?? 'general'
})

/** 分区列表：服务分区只在桌面宿主出现 */
const sections = computed(() => [
  { id: 'general' as const, label: t('settings.appearance') },
  { id: 'tabs' as const, label: t('tabs.section') },
  ...(props.readonly ? [] : [{ id: 'service' as const, label: t('settings.exposure') }]),
  { id: 'about' as const, label: t('settings.about') },
])

/* ---------- 关于 / 更新 ---------- */

interface AboutState {
  info: RuntimeInfo | null
  update: UpdateCheckResult | null
  checking: boolean
}

const about = ref<AboutState>({ info: null, update: null, checking: false })

async function loadAbout(): Promise<void> {
  const result = await window.docvi.appRuntimeInfo()
  if (result.ok) about.value.info = result.data
}

/**
 * 更新流程状态：检查 → 下载 → 校验 → 可以安装。
 *
 * 三个阶段分开存，是因为用户的等待预期完全不同：检查是秒级、下载可能几分钟
 * （取决于网络）、校验完后要明确告诉他「现在可以重启安装了」。
 */
const updateFlow = ref<{
  phase: UpdatePhase
  received: number
  total: number | null
  /** 已下载并校验通过的版本；有值时才显示「重启并安装」 */
  readyVersion: string | null
  fileName: string | null
}>({ phase: 'idle', received: 0, total: null, readyVersion: null, fileName: null })

let unsubscribeProgress: (() => void) | null = null

/** 更新流程的错误：就地显示在更新区（见 downloadUpdate 的说明） */
const updateError = ref<string | null>(null)

/**
 * 检查更新。
 *
 * 除了比对版本，还会拿到本机平台对应的安装包信息（含 SHA-256）。拿不到资产
 * 或没有校验值时，界面只给下载页——不引导用户走一条注定失败的自动更新。
 */
async function checkUpdate(): Promise<void> {
  if (about.value.checking) return
  about.value = { ...about.value, checking: true }
  // 重新检查时清掉上一轮的下载态：版本可能已经变了，旧包不该继续挂着
  updateFlow.value = { phase: 'idle', received: 0, total: null, readyVersion: null, fileName: null }
  try {
    const result = await window.docvi.appUpdateCheck()
    if (result.ok) about.value = { ...about.value, update: result.data }
    else
      about.value = {
        ...about.value,
        update: {
          status: 'unavailable',
          current: about.value.info?.version ?? '',
          checkedAt: Date.now(),
          message: result.error.message,
        },
      }
  } finally {
    about.value = { ...about.value, checking: false }
  }
}

/** 可以走应用内自动更新：有资产、有校验值、不是容器版 */
const canAutoUpdate = computed(() => {
  const asset = about.value.update?.asset
  return Boolean(asset?.sha256) && !props.readonly
})

/** 下载 → 校验 → 就绪。进度由主进程推送，这里只更新本地状态 */
async function downloadUpdate(): Promise<void> {
  const update = about.value.update
  if (!update?.asset || !update.latest) return
  updateError.value = null
  updateFlow.value = { ...updateFlow.value, phase: 'downloading', received: 0 }
  const result = await window.docvi.appUpdateDownload({
    asset: update.asset,
    version: update.latest,
  })
  if (result.ok) {
    updateFlow.value = {
      phase: 'ready',
      received: updateFlow.value.received,
      total: updateFlow.value.total,
      readyVersion: result.data.version,
      fileName: result.data.fileName,
    }
    return
  }
  /*
   * 错误就地显示在更新区，不丢进全局 toast：
   * 关于页可能开着很久，用户回头看不到已经消失的提示；而下载失败的原因
   * （校验不通过 / 网络 / 磁盘）恰恰需要停在那儿让他读完。
   */
  updateError.value = result.error.message
  updateFlow.value = { ...updateFlow.value, phase: 'idle' }
}

function cancelDownload(): void {
  void window.docvi.appUpdateCancel()
}

/** 重启并安装：应用会退出，安装程序接管 */
async function installUpdate(): Promise<void> {
  const version = updateFlow.value.readyVersion
  if (!version) return
  updateError.value = null
  updateFlow.value = { ...updateFlow.value, phase: 'installing' }
  const result = await window.docvi.appUpdateInstall()
  if (!result.ok) {
    updateError.value = result.error.message
    updateFlow.value = { ...updateFlow.value, phase: 'ready' }
  }
}

/** 下载进度百分比；没有总字节时返回 null（显示不确定态） */
const downloadPercent = computed(() => {
  const { received, total } = updateFlow.value
  if (!total || total <= 0) return null
  return Math.min(100, Math.round((received / total) * 100))
})

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function openDownload(): void {
  const url = about.value.update?.downloadUrl ?? about.value.info?.homepage
  if (url) void window.docvi.appOpenExternal(url)
}

/** 打开项目主页（GitHub） */
function openHomepage(): void {
  const url = about.value.info?.homepage
  if (url) void window.docvi.appOpenExternal(url)
}

/** 版本对比结果的展示文案 */
const updateLabel = computed(() => {
  const update = about.value.update
  if (!update) return ''
  if (update.status === 'latest')
    return t('about.upToDate', { version: update.latest ?? update.current })
  if (update.status === 'outdated')
    return t('about.updateAvailable', { current: update.current, latest: update.latest ?? '' })
  return update.message
    ? t('about.checkFailed', { reason: update.message })
    : t('about.checkUnavailable')
})

/** 刚复制过的字段（用于短暂打勾反馈）；值是字段 key 或分享 id */
const copied = ref<string | null>(null)
let unsubscribe: (() => void) | null = null

onMounted(() => {
  void loadAbout()
  // 容器版没有服务进程也没有桌面外壳：这两个面板的数据源都不存在
  if (props.readonly) return
  void store.load()
  void loadDesktop()
  // 服务自己推状态（崩溃重启 / 端口顺延），这里不再轮询
  unsubscribe = store.subscribe()
  // 下载进度由主进程按 ~200ms 节流推送；渲染层只负责把它落进状态
  unsubscribeProgress = window.docvi.onUpdateProgress(progress => {
    const flow = updateFlow.value
    updateFlow.value = {
      phase: progress.phase,
      received: progress.received ?? flow.received,
      total: progress.total ?? flow.total,
      // ready 阶段主进程才知道最终文件名；其余阶段保留已有值
      readyVersion:
        progress.phase === 'ready' ? (progress.version ?? flow.readyVersion) : flow.readyVersion,
      fileName: flow.fileName,
    }
  })
})

onUnmounted(() => {
  unsubscribe?.()
  unsubscribeProgress?.()
})

/** 复制并短暂高亮：用户要能确认「刚才那下生效了」 */
async function copyField(key: string, text: string): Promise<void> {
  if (!text) return
  const ok = await store.copy(text)
  if (!ok) return
  copied.value = key
  setTimeout(() => {
    if (copied.value === key) copied.value = null
  }, 1600)
}

/** 整份 MCP 客户端配置：用户真正需要粘出去的是一段 JSON，不是一个 URL */
const mcpConfig = computed(() => {
  const endpoint = store.endpoint
  if (!endpoint) return ''
  return JSON.stringify(
    {
      mcpServers: {
        docvi: {
          type: 'http',
          url: endpoint,
          headers: { Authorization: `Bearer ${store.state?.token ?? ''}` },
        },
      },
    },
    null,
    2,
  )
})

function shortPath(path: string): string {
  // 尾部优先：绝对路径的前缀对判断「分享的是哪个」没有帮助
  const parts = path.replaceAll('\\', '/').split('/').filter(Boolean)
  if (parts.length <= 3) return path
  return `…/${parts.slice(-3).join('/')}`
}

/* ---------- 端口 / 启动与常驻 ---------- */

/**
 * 端口草稿：只在用户按「应用」时提交，避免每敲一个数字就重启服务。
 *
 * 「脏」不能用 `portDraft !== store.state?.port` 判断：服务状态是异步拉回来的，
 * 拿未加载时的初值去比会立刻算出「已修改」，于是下面那个同步 watch 永远进不去，
 * 输入框会一直停在初值（实测显示 0，而服务其实跑在 7312 上）。
 * 改成显式记录「用户是否改过」，服务端端口变化时只要没改过就照抄。
 */
const portDraft = ref(0)
const portEdited = ref(false)
const portDirty = computed(() => portEdited.value && portDraft.value !== store.state?.port)

watch(
  () => store.state?.port,
  port => {
    if (typeof port === 'number' && !portEdited.value) portDraft.value = port
  },
  { immediate: true },
)

/** 手动输入即视为改过；之后不再被服务端同步覆盖 */
function onPortInput(value: number): void {
  portDraft.value = Number.isFinite(value) ? value : 0
  portEdited.value = true
}

async function applyPort(): Promise<void> {
  const port = Number(portDraft.value)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    store.error = t('error.badPort')
    return
  }
  await store.setPort(port)
  // 提交成功即与服务端对齐，之后重新允许服务端端口变化同步进草稿
  portEdited.value = false
}

const desktop = ref<DesktopPrefsState>({
  autostart: false,
  autostartCommand: '',
  closeToTray: false,
  error: null,
})
const desktopBusy = ref(false)

async function loadDesktop(): Promise<void> {
  const result = await window.docvi.desktopPrefs()
  if (result.ok) desktop.value = result.data
  else store.error = result.error.message
}

async function toggleAutostart(): Promise<void> {
  desktopBusy.value = true
  try {
    const result = await window.docvi.desktopSetAutostart(!desktop.value.autostart)
    if (result.ok) desktop.value = result.data
    else store.error = result.error.message
  } finally {
    desktopBusy.value = false
  }
}

async function toggleCloseToTray(): Promise<void> {
  desktopBusy.value = true
  try {
    const result = await window.docvi.desktopSetCloseToTray(!desktop.value.closeToTray)
    if (result.ok) desktop.value = result.data
    else store.error = result.error.message
  } finally {
    desktopBusy.value = false
  }
}

async function openLogs(): Promise<void> {
  const result = await window.docvi.serviceOpenLog()
  if (!result.ok) store.error = result.error.message
}
</script>

<template>
  <div class="settings">
    <div class="settings__inner">
      <nav class="settings__nav" :aria-label="t('settings.title')">
        <button
          v-for="item in sections"
          :key="item.id"
          class="settings__nav-btn"
          :class="{ 'is-on': activeSection === item.id }"
          type="button"
          :aria-current="activeSection === item.id ? 'page' : undefined"
          @click="emit('open-section', item.id)"
        >
          {{ item.label }}
        </button>
      </nav>

      <template v-if="activeSection === 'service' && !readonly">
        <section class="panel">
          <div class="panel__head">
            <h2 class="panel__title">
              <Server :size="15" :stroke-width="1.8" /> {{ t('settings.service') }}
            </h2>
            <div class="panel__actions">
              <button
                class="btn btn--ghost"
                type="button"
                :disabled="store.loading"
                @click="store.restart()"
              >
                <RefreshCw :size="13" :stroke-width="1.8" />
                <span>{{ t('settings.serviceRestart') }}</span>
              </button>
            </div>
          </div>

          <p class="hint">{{ t('settings.exposureHint') }}</p>

          <div class="row">
            <span class="row__label">{{ t('settings.status') }}</span>
            <span class="row__value">
              <span class="dot" :class="store.running ? 'dot--on' : 'dot--off'" />
              {{
                store.running
                  ? `${t('settings.running')} · ${store.state?.host ?? ''}:${store.state?.port ?? ''}`
                  : t('settings.stopped')
              }}
            </span>
          </div>

          <p v-if="store.state?.error" class="alert">{{ store.state.error }}</p>

          <div class="row">
            <span class="row__label">{{ t('settings.port') }}</span>
            <span class="row__value">
              <input
                class="port-input mono"
                type="number"
                min="1024"
                max="65535"
                :value="portDraft"
                :aria-label="t('settings.port')"
                @input="onPortInput(Number(($event.target as HTMLInputElement).value))"
                @keydown.enter.prevent="applyPort"
              />
              <button
                class="btn btn--ghost"
                type="button"
                :disabled="store.loading || !portDirty"
                @click="applyPort"
              >
                {{ t('settings.portApply') }}
              </button>
            </span>
          </div>
          <p class="hint">{{ t('settings.portHint') }}</p>

          <div class="row">
            <span class="row__label">{{ t('settings.lan') }}</span>
            <span class="row__value">
              <Wifi :size="13" :stroke-width="1.8" />
              {{ store.lan ? t('settings.lanOn') : t('settings.lanOff') }}
            </span>
            <button
              class="switch"
              type="button"
              :class="{ 'is-on': store.lan }"
              :aria-pressed="store.lan"
              :aria-label="t('settings.lan')"
              @click="store.setLan(!store.lan)"
            >
              <span class="switch__knob" />
            </button>
          </div>
          <p v-if="store.lan" class="hint hint--warn">{{ t('settings.lanWarn') }}</p>
        </section>

        <section class="panel">
          <div class="panel__head">
            <h2 class="panel__title">
              <Bot :size="15" :stroke-width="1.8" /> {{ t('settings.mcpSection') }}
            </h2>
          </div>
          <p class="hint">{{ t('settings.mcpHint') }}</p>

          <div class="row">
            <span class="row__label">{{ t('settings.endpoint') }}</span>
            <span class="row__value mono">{{ store.endpoint || '—' }}</span>
            <button
              class="icon-btn"
              type="button"
              :disabled="!store.endpoint"
              :aria-label="copied === 'endpoint' ? t('settings.copied') : t('settings.copy')"
              @click="copyField('endpoint', store.endpoint)"
            >
              <Check v-if="copied === 'endpoint'" :size="13" :stroke-width="2" />
              <Copy v-else :size="13" :stroke-width="1.8" />
            </button>
          </div>

          <div class="row">
            <span class="row__label">{{ t('settings.token') }}</span>
            <span class="row__value mono">{{ store.maskedToken || '—' }}</span>
            <button
              class="icon-btn"
              type="button"
              :aria-label="store.tokenVisible ? t('settings.hide') : t('settings.show')"
              @click="store.tokenVisible = !store.tokenVisible"
            >
              <EyeOff v-if="store.tokenVisible" :size="13" :stroke-width="1.8" />
              <Eye v-else :size="13" :stroke-width="1.8" />
            </button>
            <button
              class="icon-btn"
              type="button"
              :disabled="!store.state?.token"
              :aria-label="copied === 'token' ? t('settings.copied') : t('settings.copy')"
              @click="copyField('token', store.state?.token ?? '')"
            >
              <Check v-if="copied === 'token'" :size="13" :stroke-width="2" />
              <Copy v-else :size="13" :stroke-width="1.8" />
            </button>
          </div>

          <div class="row row--block">
            <div class="row__label-row">
              <span class="row__label">{{ t('settings.mcpConfig') }}</span>
              <button
                class="link-btn"
                type="button"
                :disabled="!mcpConfig"
                @click="copyField('config', mcpConfig)"
              >
                {{ copied === 'config' ? t('settings.copied') : t('settings.copyJson') }}
              </button>
            </div>
            <pre class="code">{{ mcpConfig || t('settings.noConfig') }}</pre>
            <p class="hint">{{ t('settings.toolsHint') }}</p>
          </div>
        </section>

        <!--
        「启动与常驻」单列一节：这一组开关改变的是**应用的行为**（开机启动、
        关窗口是否退出），与服务本身是否运行是两件事——混在服务卡片里会让人
        以为「关掉托盘 = 关掉 MCP」。
      -->
        <section class="panel">
          <div class="panel__head">
            <h2 class="panel__title">
              <Power :size="15" :stroke-width="1.8" /> {{ t('settings.desktop') }}
            </h2>
          </div>

          <div class="row">
            <span class="row__label">{{ t('settings.autostart') }}</span>
            <span class="row__value">{{ t('settings.autostartHint') }}</span>
            <button
              class="switch"
              type="button"
              :class="{ 'is-on': desktop.autostart }"
              :aria-pressed="desktop.autostart"
              :aria-label="t('settings.autostart')"
              :disabled="desktopBusy"
              @click="toggleAutostart"
            >
              <span class="switch__knob" />
            </button>
          </div>
          <p v-if="desktop.error" class="hint hint--warn">{{ desktop.error }}</p>
          <p v-else-if="desktop.autostartCommand" class="hint mono hint--code">
            {{ desktop.autostartCommand }}
          </p>

          <div class="row">
            <span class="row__label">{{ t('settings.closeToTray') }}</span>
            <span class="row__value">{{ t('settings.closeToTrayHint') }}</span>
            <button
              class="switch"
              type="button"
              :class="{ 'is-on': desktop.closeToTray }"
              :aria-pressed="desktop.closeToTray"
              :aria-label="t('settings.closeToTray')"
              :disabled="desktopBusy"
              @click="toggleCloseToTray"
            >
              <span class="switch__knob" />
            </button>
          </div>

          <div class="row">
            <span class="row__label">{{ t('settings.logs') }}</span>
            <span class="row__value mono">{{ t('settings.logsHint') }}</span>
            <button class="btn btn--ghost" type="button" @click="openLogs">
              <FolderOpen :size="13" :stroke-width="1.8" />
              <span>{{ t('settings.openLogs') }}</span>
            </button>
          </div>
        </section>

        <section class="panel">
          <div class="panel__head">
            <h2 class="panel__title">
              <Link2 :size="15" :stroke-width="1.8" /> {{ t('settings.shares') }}
            </h2>
            <button class="btn btn--primary" type="button" @click="store.createShare()">
              <FolderOpen :size="14" :stroke-width="1.8" />
              <span>{{ t('settings.newShare') }}</span>
            </button>
          </div>
          <p class="hint">{{ t('settings.sharesHint') }}</p>

          <p v-if="!store.shares.length" class="empty">{{ t('empty.shares') }}</p>

          <ul v-else class="shares">
            <li v-for="share in store.shares" :key="share.id" class="share">
              <span
                class="share__kind"
                :title="share.kind === 'dir' ? t('settings.shares') : t('status.standalone')"
              >
                <FolderOpen v-if="share.kind === 'dir'" :size="14" :stroke-width="1.7" />
                <FileText v-else :size="14" :stroke-width="1.7" />
              </span>
              <div class="share__main">
                <span class="share__path" :title="share.path">{{ shortPath(share.path) }}</span>
                <span class="share__url mono" :title="share.url">{{ share.url }}</span>
              </div>
              <button
                class="icon-btn"
                type="button"
                :aria-label="copied === share.id ? t('settings.copied') : t('settings.copy')"
                @click="copyField(share.id, share.url)"
              >
                <Check v-if="copied === share.id" :size="13" :stroke-width="2" />
                <Copy v-else :size="13" :stroke-width="1.8" />
              </button>
              <button
                class="icon-btn"
                type="button"
                :aria-label="t('settings.copy')"
                @click="store.openShare(share.id)"
              >
                <ExternalLink :size="13" :stroke-width="1.8" />
              </button>
              <button
                class="icon-btn icon-btn--danger"
                type="button"
                :aria-label="t('settings.shares')"
                @click="store.removeShare(share.id)"
              >
                <Trash2 :size="13" :stroke-width="1.8" />
              </button>
            </li>
          </ul>
        </section>
      </template>

      <template v-if="activeSection === 'general'">
        <section class="panel">
          <div class="panel__head">
            <h2 class="panel__title">{{ t('settings.appearance') }}</h2>
          </div>
          <!--
          主题选择器直接列全部主题：内置两套 + 各插件带来的。原来这里只有一行
          「当前：xxx + 切换深浅」，插件主题等于藏起来了——插件装了也切不过去。
        -->
          <ThemePicker />
          <p class="hint">{{ t('settings.themeHint') }}</p>

          <!--
            源码折行：这是编辑器排版偏好，不是主题的一部分（主题管颜色），
            所以单独一行放在外观分区里，用户找「显示怎么排」时能看见。
          -->
          <div class="row row--spaced">
            <span class="row__label">{{ t('settings.editorWrap') }}</span>
            <span class="row__value">
              <button
                v-for="option in WRAP_OPTIONS"
                :key="option.id"
                class="seg"
                :class="{ 'is-on': theme.editorWrap === option.id }"
                type="button"
                :aria-pressed="theme.editorWrap === option.id"
                @click="theme.editorWrap = option.id"
              >
                {{ option.label }}
              </button>
            </span>
          </div>
          <p class="hint">{{ t('settings.editorWrapHint') }}</p>
        </section>

        <section class="panel">
          <div class="panel__head">
            <h2 class="panel__title">{{ t('settings.language') }}</h2>
          </div>
          <div class="row">
            <span class="row__label">{{ t('settings.language') }}</span>
            <span class="row__value">
              <button
                v-for="item in LOCALES"
                :key="item.id"
                class="seg"
                :class="{ 'is-on': locale === item.id }"
                type="button"
                :aria-pressed="locale === item.id"
                @click="setLocale(item.id)"
              >
                {{ item.label }}
              </button>
            </span>
          </div>
          <p class="hint">{{ t('settings.storageHint') }}</p>
        </section>
      </template>

      <template v-if="activeSection === 'tabs'">
        <section class="panel">
          <div class="panel__head">
            <h2 class="panel__title">{{ t('tabs.section') }}</h2>
          </div>

          <div class="row">
            <span class="row__label">{{ t('tabs.max') }}</span>
            <span class="row__value">
              <input
                class="num"
                type="number"
                min="0"
                max="200"
                :value="tabs.preferences.maxTabs"
                :aria-label="t('tabs.max')"
                @change="
                  patchTabs({ maxTabs: Number(($event.target as HTMLInputElement).value) || 0 })
                "
              />
              <span class="hint-inline">{{ t('tabs.maxHint') }}</span>
            </span>
          </div>

          <div class="row">
            <span class="row__label">{{ t('tabs.overflow') }}</span>
            <span class="row__value">
              <button
                v-for="option in [
                  { id: 'least-recent', label: t('tabs.overflow.leastRecent') },
                  { id: 'oldest', label: t('tabs.overflow.oldest') },
                  { id: 'reject', label: t('tabs.overflow.reject') },
                ]"
                :key="option.id"
                class="seg"
                :class="{ 'is-on': tabs.preferences.overflow === option.id }"
                type="button"
                :aria-pressed="tabs.preferences.overflow === option.id"
                @click="patchTabs({ overflow: option.id as 'least-recent' })"
              >
                {{ option.label }}
              </button>
            </span>
          </div>

          <div class="row">
            <span class="row__label">{{ t('tabs.layout') }}</span>
            <span class="row__value">
              <button
                v-for="option in [
                  { id: 'single', label: t('tabs.layout.single') },
                  { id: 'wrap', label: t('tabs.layout.wrap') },
                ]"
                :key="option.id"
                class="seg"
                :class="{ 'is-on': tabs.preferences.layout === option.id }"
                type="button"
                :aria-pressed="tabs.preferences.layout === option.id"
                @click="patchTabs({ layout: option.id as 'single' })"
              >
                {{ option.label }}
              </button>
            </span>
          </div>

          <div class="row">
            <span class="row__label">{{ t('tabs.overflowX') }}</span>
            <span class="row__value">
              <button
                v-for="option in [
                  { id: 'scroll', label: t('tabs.overflowX.scroll') },
                  { id: 'shrink', label: t('tabs.overflowX.shrink') },
                ]"
                :key="option.id"
                class="seg"
                :class="{ 'is-on': tabs.preferences.overflowX === option.id }"
                type="button"
                :aria-pressed="tabs.preferences.overflowX === option.id"
                :disabled="tabs.preferences.layout === 'wrap'"
                @click="patchTabs({ overflowX: option.id as 'scroll' })"
              >
                {{ option.label }}
              </button>
            </span>
          </div>

          <div class="row">
            <span class="row__label">{{ t('tabs.width') }}</span>
            <span class="row__value">
              <input
                class="num"
                type="number"
                min="120"
                max="320"
                step="10"
                :value="tabs.preferences.maxWidth"
                :aria-label="t('tabs.width')"
                @change="
                  patchTabs({
                    maxWidth: Math.min(
                      320,
                      Math.max(120, Number(($event.target as HTMLInputElement).value) || 200),
                    ),
                  })
                "
              />
              <span class="row__hint">{{ t('tabs.widthHint') }}</span>
            </span>
          </div>
        </section>
      </template>

      <!--
        关于：版本、运行时、数据目录、更新检查。
        数据目录用等宽字并支持复制——排查问题时要贴给别人，手抄路径最容易出错。
      -->
      <template v-if="activeSection === 'about'">
        <section class="panel">
          <div class="panel__head">
            <h2 class="panel__title">{{ t('settings.about') }}</h2>
            <div class="panel__actions">
              <button
                class="btn btn--ghost"
                type="button"
                :disabled="about.checking"
                @click="checkUpdate"
              >
                <RefreshCw :size="13" :stroke-width="1.8" />
                <span>{{ about.checking ? t('about.checking') : t('about.checkUpdate') }}</span>
              </button>
            </div>
          </div>

          <div class="row">
            <span class="row__label">{{ t('about.version') }}</span>
            <span class="row__value mono">{{ about.info?.version ?? '—' }}</span>
          </div>
          <!--
            项目主页：开源仓是用户能找到源码、提 issue、看更新日志的地方，
            必须有一个可点的入口，而不是让人自己去搜。
          -->
          <div v-if="about.info?.homepage" class="row">
            <span class="row__label">{{ t('about.homepage') }}</span>
            <span class="row__value">
              <button class="about__link mono" type="button" @click="openHomepage">
                {{ about.info.homepage }}
                <ExternalLink :size="11" :stroke-width="1.8" aria-hidden="true" />
              </button>
            </span>
          </div>
          <div v-if="about.info?.electron" class="row">
            <span class="row__label">Electron</span>
            <span class="row__value mono">{{ about.info.electron }}</span>
          </div>
          <div v-if="about.info?.node" class="row">
            <span class="row__label">Node</span>
            <span class="row__value mono">{{ about.info.node }}</span>
          </div>
          <div v-if="about.info?.chrome" class="row">
            <span class="row__label">Chromium</span>
            <span class="row__value mono">{{ about.info.chrome }}</span>
          </div>
          <div class="row">
            <span class="row__label">{{ t('about.platform') }}</span>
            <span class="row__value mono">
              {{ about.info?.platform ?? '—' }} · {{ about.info?.arch ?? '—' }}
            </span>
          </div>
          <div v-if="about.info?.dataDir" class="row">
            <span class="row__label">{{ t('about.dataDir') }}</span>
            <span class="row__value">
              <span class="mono path-text">{{ about.info.dataDir }}</span>
              <button
                class="btn btn--ghost btn--sm"
                type="button"
                @click="copyField('about-dataDir', about.info?.dataDir ?? '')"
              >
                {{ copied === 'about-dataDir' ? t('settings.copied') : t('settings.copy') }}
              </button>
            </span>
          </div>

          <p
            v-if="about.update"
            class="hint"
            :class="{ 'hint--warn': about.update.status === 'unavailable' }"
          >
            {{ updateLabel }}
          </p>
          <p v-if="about.update?.notes" class="hint">{{ about.update.notes }}</p>
          <p v-if="updateError" class="hint hint--error">{{ updateError }}</p>

          <!--
            更新操作区：三种状态互斥，同一位置替换内容而不是并排堆按钮。
            按钮位置稳定，用户在等哪一步都看得见当前处于哪一阶段。
          -->
          <div v-if="about.update?.status === 'outdated'" class="update-actions">
            <!-- 就绪：已经下载并校验完，只等重启 -->
            <template v-if="updateFlow.phase === 'ready'">
              <div class="update-progress">
                <span class="update-progress__label">
                  {{
                    t('about.readyToInstall', {
                      version: updateFlow.readyVersion ?? about.update.latest ?? '',
                    })
                  }}
                </span>
                <span v-if="updateFlow.fileName" class="update-progress__file mono">
                  {{ updateFlow.fileName }}
                </span>
              </div>
              <button class="btn btn--primary btn--sm" type="button" @click="installUpdate">
                {{ t('about.installNow') }}
              </button>
            </template>

            <!-- 下载 / 校验中：进度条 + 取消 -->
            <template
              v-else-if="updateFlow.phase === 'downloading' || updateFlow.phase === 'verifying'"
            >
              <div class="update-progress">
                <span class="update-progress__label">
                  {{
                    updateFlow.phase === 'verifying' ? t('about.verifying') : t('about.downloading')
                  }}
                  <template v-if="downloadPercent !== null">· {{ downloadPercent }}%</template>
                  <template v-if="updateFlow.total">
                    （{{ formatBytes(updateFlow.received) }} / {{ formatBytes(updateFlow.total) }}）
                  </template>
                </span>
                <span class="update-progress__track" aria-hidden="true">
                  <span
                    class="update-progress__fill"
                    :class="{ 'is-indeterminate': downloadPercent === null }"
                    :style="downloadPercent === null ? undefined : { width: `${downloadPercent}%` }"
                  />
                </span>
              </div>
              <button
                v-if="updateFlow.phase === 'downloading'"
                class="btn btn--ghost btn--sm"
                type="button"
                @click="cancelDownload"
              >
                {{ t('about.cancelDownload') }}
              </button>
            </template>

            <!-- 默认：可以下载 -->
            <template v-else>
              <button
                v-if="canAutoUpdate"
                class="btn btn--primary btn--sm"
                type="button"
                @click="downloadUpdate"
              >
                {{ t('about.downloadUpdate', { version: about.update.latest ?? '' }) }}
              </button>
              <button
                v-if="about.update.downloadUrl"
                class="btn btn--ghost btn--sm"
                type="button"
                @click="openDownload"
              >
                {{ t('about.openDownload') }}
              </button>
              <!-- 没有校验值 / 容器版：说明为什么只能手动下 -->
              <span v-if="!canAutoUpdate" class="hint hint--inline">
                {{ props.readonly ? t('about.webCannotUpdate') : t('about.noChecksum') }}
              </span>
            </template>
          </div>

          <p class="hint">{{ t('about.updateNote') }}</p>
        </section>
      </template>

      <p v-if="store.error" class="alert">{{ store.error }}</p>
    </div>
  </div>
</template>

<style scoped>
/* 外层吃满画布宽度当滚动容器，内层才是限宽内容列——否则滚动条浮在列右缘 */
.settings {
  height: 100%;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.settings__inner {
  max-width: 880px;
  margin: 0 auto;
  padding: 32px 32px 72px;
}

/* 关于面板：路径可能很长，允许换行且不撑破列宽 */
.path-text {
  min-width: 0;
  overflow-wrap: anywhere;
}

/* 项目主页链接：看起来是链接，但用 button 走宿主的外链通道（不能直接导航） */
.about__link {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--dv-ui-accent);
  font-size: inherit;
  cursor: pointer;
  overflow-wrap: anywhere;
  text-align: left;
}

.about__link:hover {
  text-decoration: underline;
}

/* 更新操作区：按钮与进度在同一行，高度固定，切换阶段时不跳 */
.update-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
  min-height: 28px;
}

.update-progress {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 220px;
  flex: 1 1 220px;
}

.update-progress__label {
  color: var(--dv-ui-text-muted);
  font-size: 11.5px;
}

.update-progress__file {
  color: var(--dv-ui-text-dim);
  font-size: 10.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.update-progress__track {
  display: block;
  height: 3px;
  border-radius: 999px;
  background: var(--dv-ui-line-soft);
  overflow: hidden;
}

.update-progress__fill {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--dv-ui-accent);
  transition: width 160ms linear;
}

/* 没有总字节：流动条，避免「0% 卡住」被读成卡死 */
.update-progress__fill.is-indeterminate {
  width: 35%;
  animation: update-indeterminate 1.1s ease-in-out infinite;
}

@keyframes update-indeterminate {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(300%);
  }
}

.hint--inline {
  margin: 0;
}

.hint--error {
  color: var(--dv-ui-danger);
}

.hint--warn {
  color: var(--dv-ui-text-muted);
}

.settings__nav {
  display: flex;
  gap: 4px;
  margin-bottom: 16px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--dv-ui-line-soft);
}

.settings__nav-btn {
  height: 26px;
  padding: 0 11px;
  border: 1px solid transparent;
  border-radius: var(--dv-ui-radius-sm);
  background: transparent;
  color: var(--dv-ui-text-muted);
  font-size: 12px;
  cursor: pointer;
}

.settings__nav-btn:hover {
  background: var(--dv-ui-surface-2);
  color: var(--dv-ui-text-2);
}

.settings__nav-btn.is-on {
  background: var(--dv-ui-surface-3);
  color: var(--dv-ui-text);
}

.num {
  width: 84px;
  height: 24px;
  padding: 0 8px;
  border: 1px solid var(--dv-ui-line-soft);
  border-radius: var(--dv-ui-radius-sm);
  background: var(--dv-ui-bg);
  color: var(--dv-ui-text-2);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.hint-inline {
  margin-left: 2px;
  font-size: 11px;
  color: var(--dv-ui-text-dim);
}

.panel {
  margin-bottom: 16px;
  padding: 16px 18px;
  border: 1px solid var(--dv-ui-line-soft);
  border-radius: var(--dv-ui-radius-md);
  background: var(--dv-ui-surface-1);
}

.panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

.panel__title {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--dv-ui-text);
}

.row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 34px;
  padding: 5px 0;
  border-top: 1px solid var(--dv-ui-line-soft);
}

.row:first-of-type {
  border-top: none;
}

/* 与前一块（主题选择器）拉开距离：这里换的是另一个话题（编辑器排版） */
.row--spaced {
  margin-top: 18px;
  border-top: 1px solid var(--dv-ui-line-soft);
}

.row--block {
  display: block;
}

.row__label {
  flex: none;
  width: 110px;
  font-size: 12px;
  color: var(--dv-ui-text-muted);
}

.row__label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}

.row__value {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  color: var(--dv-ui-text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mono {
  font-family: var(--dv-ed-font, ui-monospace, monospace);
  font-size: 11.5px;
}

.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: none;
}

.dot--on {
  background: var(--dv-ui-ok, #4ea86b);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dv-ui-ok, #4ea86b) 18%, transparent);
}

.dot--off {
  background: var(--dv-ui-text-dim);
}

.code {
  margin: 0;
  padding: 10px 12px;
  border-radius: var(--dv-ui-radius-sm);
  background: var(--dv-ui-bg);
  border: 1px solid var(--dv-ui-line-soft);
  font-family: var(--dv-ed-font, ui-monospace, monospace);
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--dv-ui-text-2);
  overflow-x: auto;
  white-space: pre;
}

.hint {
  margin: 8px 0 0;
  font-size: 11.5px;
  line-height: 1.65;
  color: var(--dv-ui-text-dim);
}

.hint--warn {
  color: color-mix(in srgb, var(--dv-ui-danger, #d14343) 78%, var(--dv-ui-text-dim));
}

.alert {
  margin: 8px 0 0;
  padding: 8px 10px;
  border-radius: var(--dv-ui-radius-sm);
  background: color-mix(in srgb, var(--dv-ui-danger, #d14343) 10%, transparent);
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--dv-ui-danger, #d14343);
}

.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  flex: none;
  padding: 0 12px;
  border: 1px solid transparent;
  border-radius: var(--dv-ui-radius-sm);
  font-size: 12px;
  font-weight: 540;
  cursor: pointer;
}

.btn--primary {
  background: var(--dv-ui-accent);
  color: var(--dv-ui-accent-fg);
}

.btn--primary:hover {
  background: var(--dv-ui-accent-strong);
}

.btn--ghost {
  border-color: var(--dv-ui-line-soft);
  background: transparent;
  color: var(--dv-ui-text-2);
}

.btn--ghost:hover {
  background: var(--dv-ui-surface-3);
}

.btn:disabled {
  opacity: 0.45;
  cursor: default;
}

.icon-btn {
  width: 26px;
  height: 26px;
  flex: none;
  display: grid;
  place-items: center;
  border: none;
  border-radius: var(--dv-ui-radius-sm);
  background: transparent;
  color: var(--dv-ui-text-dim);
  cursor: pointer;
}

.icon-btn:hover {
  background: var(--dv-ui-surface-3);
  color: var(--dv-ui-text-2);
}

.icon-btn--danger:hover {
  color: var(--dv-ui-danger, #d14343);
}

.field-btn,
.link-btn {
  border: none;
  background: transparent;
  color: var(--dv-ui-accent);
  font-size: 11.5px;
  cursor: pointer;
  padding: 0;
}

.link-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.seg {
  height: 24px;
  padding: 0 12px;
  border: 1px solid var(--dv-ui-line-soft);
  border-radius: var(--dv-ui-radius-sm);
  background: transparent;
  color: var(--dv-ui-text-dim);
  font-size: 11.5px;
  cursor: pointer;
}

.seg.is-on {
  background: var(--dv-ui-surface-3);
  color: var(--dv-ui-text);
  border-color: transparent;
}

.switch {
  position: relative;
  width: 34px;
  height: 20px;
  flex: none;
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

.empty {
  margin: 14px 0 4px;
  font-size: 12px;
  color: var(--dv-ui-text-dim);
}

.shares {
  list-style: none;
  margin: 12px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.share {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 9px;
  border-radius: var(--dv-ui-radius-sm);
  background: var(--dv-ui-bg);
}

.share__kind {
  flex: none;
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  color: var(--dv-ui-text-dim);
}

.share__main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.share__path {
  font-size: 12px;
  color: var(--dv-ui-text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.share__url {
  color: var(--dv-ui-text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 端口输入：定宽数字框，宽度固定避免「1024 → 65535」时整行抖动 */
.port-input {
  width: 84px;
  height: 26px;
  padding: 0 7px;
  border: 1px solid var(--dv-ui-line-soft);
  border-radius: var(--dv-ui-radius-sm);
  background: var(--dv-ui-bg);
  color: var(--dv-ui-text);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  outline: none;
}

.port-input:focus {
  border-color: var(--dv-ui-accent);
}

/* 自启动命令行：可能很长，换行而不是横滚，方便用户核对路径 */
.hint--code {
  word-break: break-all;
  font-size: 10.5px;
}
</style>
