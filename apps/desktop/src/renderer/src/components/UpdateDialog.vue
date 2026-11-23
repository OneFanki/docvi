<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Download, ExternalLink, RefreshCw, ShieldCheck } from 'lucide-vue-next'

import type { UpdateCheckResult, UpdateProgress } from '@docvi/shared'

import { useI18n } from '../lib/i18n'
import { toPlain } from '../lib/plain-request'
import { IS_MAC } from '../lib/shortcuts'

/**
 * 更新提示弹窗。
 *
 * 两条规则决定了它的形状：
 * 1. **只显示版本摘要**，不铺整篇 changelog。一大段文字正是让人不看就关掉
 *    更新的原因；完整内容在 Release 页面，给一条链接。
 * 2. 下载与安装都要用户点一下。校验发生在执行之前，界面上要说清这件事——
 *    静默下载并安装的行为在未签名的产物上风险不可接受。
 *
 * 与「关于」页的更新区是**两条独立的入口**，共用同一套 IPC：那条是用户主动
 * 问（错误就地显示在那儿，不弹窗），这条是后台发现（用户没问，所以要打断）。
 * 两处状态不共享——同一次会话里既可能在弹窗里下载，也可能在关于页下载。
 */
const props = defineProps<{ result: UpdateCheckResult }>()
const emit = defineEmits<{
  close: []
  /** 用户选了「以后再说」：把这个版本记下来，下次检查保持沉默 */
  dismissed: [version: string]
}>()

const { t, locale } = useI18n()

const phase = ref<'idle' | 'downloading' | 'verifying' | 'ready' | 'installing' | 'error'>('idle')
const progress = ref<UpdateProgress | null>(null)
const errorText = ref<string | null>(null)
let disposeProgress: (() => void) | null = null

const latest = computed(() => props.result.latest ?? '')
const canAutoInstall = computed(() => Boolean(props.result.asset?.sha256))
/**
 * 本地 const 而不是模板里直接用 import 的 `IS_MAC`。
 *
 * `<script setup>` 的 import 绑定在运行时模板里可见，但 vue-tsc 推断模板作用域
 * 时按组件实例形状走，会报「属性不存在」。落到 const 是这类常量最稳的写法
 * （SettingsView 里也是这么做的）。
 */
const isMac = IS_MAC

const percent = computed(() => {
  const current = progress.value
  if (!current?.total || (current.received ?? 0) <= 0) return null
  return Math.min(100, Math.round(((current.received ?? 0) / current.total) * 100))
})

const sizeLabel = computed(() => {
  const total = progress.value?.total ?? props.result.asset?.size ?? 0
  if (!total) return ''
  return `${Math.round(total / (1024 * 1024))} MB`
})

/**
 * 要展示的版本段，从旧到新。
 *
 * 用户可能隔了好几版才升级，只讲最新一版等于说「除此之外什么都没变」。
 * 有区间信息就逐版列出；取不到区间（API 不可达、只拿到单条）时退回
 * 清单里那一版 `notes`——宁可只给最新一版，也不能空着。
 */
const sections = computed(() => {
  const list = props.result.releases ?? []
  if (list.length > 0) {
    return list.map(release => ({
      version: release.version,
      url: release.url,
      lines: splitNotes(pickLanguage(release.notes)),
    }))
  }
  const fallback = pickLanguage(props.result.notes)
  return latest.value
    ? [{ version: latest.value, url: props.result.downloadUrl, lines: splitNotes(fallback) }]
    : []
})

/** 被上限折掉的旧版本数（跨了十几版时只列最近若干版） */
const omitted = computed(() => props.result.omittedReleases ?? 0)

const totalVersions = computed(() => sections.value.length + omitted.value)

/**
 * 取当前界面语言那一段摘要。
 *
 * Release 正文是「### 中文 / ### English」双段结构，整段原样显示会让用户
 * 在弹窗里读到一半看不懂的文字。层级从标题推断（CHANGELOG 里是 `###`，
 * GitHub 页面上会显得更深），到同级/更浅标题或「完整变更」为止。
 *
 * 与主进程的 `pickLanguageNotes` 是同一套规则，这里是渲染层的副本——
 * 因为主进程返回的是原始正文（它不知道用户当前选的界面语言，语言是渲染层
 * 的状态）。两份逻辑必须同步改。
 */
function pickLanguage(notes: string | undefined): string {
  if (!notes) return ''
  const alias = locale.value === 'zh' ? /^(中文|chinese|zh)$/i : /^(english|en)$/i
  const lines = notes.split(/\r?\n/)
  let level = 0
  let collecting = false
  const picked: string[] = []
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line)
    if (heading) {
      const depth = heading[1]?.length ?? 0
      const title = heading[2] ?? ''
      if (depth <= 3 && alias.test(title)) {
        if (level === 0) level = depth
        if (depth === level) {
          collecting = true
          continue
        }
      }
      if (collecting) {
        /*
         * 「完整变更」无论在哪一层都结束摘要——它是 `####`、比语言段 `###`
         * 更深，只按层级判会把几十条明细都收进弹窗。
         */
        if (/完整变更|full changelog|full changes/i.test(title)) break
        if (depth <= level) break
      }
      continue
    }
    if (collecting) picked.push(line)
  }
  const body = picked.join('\n').trim()
  return body.length > 0 ? body : notes.trim()
}

/** 摘要按行拆开：每条是一行「- 一句话」 */
function splitNotes(text: string): string[] {
  return text
    .split('\n')
    .map(line => line.replace(/^[-*]\s*/, '').trim())
    .filter(Boolean)
}

function later(): void {
  emit('dismissed', latest.value)
  emit('close')
}

function openReleasePage(): void {
  const url = props.result.downloadUrl
  if (url) void window.docvi.appOpenExternal(url)
}

async function startDownload(): Promise<void> {
  if (phase.value === 'downloading' || phase.value === 'verifying') return
  const asset = props.result.asset
  if (!asset) return
  errorText.value = null
  progress.value = { phase: 'downloading', received: 0, total: asset.size }
  phase.value = 'downloading'
  try {
    /*
     * 走 `toPlain` 而不是直接传：`props.result` 来自 IPC 事件，此刻确实不是
     * Proxy，但这条路径不该靠这个假设活着——同一个下载入口在「关于」页传的是
     * ref 里的响应式对象，那里必须剥（见 lib/plain-request.ts 的说明）。
     * 两处统一，将来谁改都不会再踩一次。
     */
    const result = await window.docvi.appUpdateDownload({
      asset: toPlain(asset),
      version: latest.value,
    })
    if (result.ok) {
      phase.value = 'ready'
      return
    }
    phase.value = 'error'
    errorText.value = result.error.message
  } catch (error) {
    // IPC 通道本身失败（主进程退出等）时 invoke 是 reject，不是回 Result
    phase.value = 'error'
    errorText.value = error instanceof Error ? error.message : String(error)
  }
}

async function install(): Promise<void> {
  phase.value = 'installing'
  try {
    const result = await window.docvi.appUpdateInstall()
    if (!result.ok) {
      phase.value = 'error'
      errorText.value = result.error.message
    }
  } catch (error) {
    phase.value = 'error'
    errorText.value = error instanceof Error ? error.message : String(error)
  }
}

const panel = ref<HTMLElement | null>(null)

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    later()
  }
}

onMounted(() => {
  // 焦点落在容器上而不是某个按钮：弹窗里按钮会随阶段变化，
  // 焦点落在按钮上时用户按空格会「自己点了下载」
  panel.value?.focus()
  disposeProgress = window.docvi.onUpdateProgress(next => {
    progress.value = next
    if (next.phase === 'error') {
      phase.value = 'error'
      errorText.value = next.message ?? null
    } else if (next.phase === 'ready') {
      phase.value = 'ready'
    } else if (next.phase === 'verifying' || next.phase === 'installing') {
      phase.value = next.phase
    }
  })
})

onBeforeUnmount(() => disposeProgress?.())

watch(
  () => props.result.latest,
  () => {
    // 弹窗开着的时候来了另一个版本：清掉上一轮的下载态，
    // 否则会变成一个「下载了 0.8.1、按钮说 0.8.2」的错位界面
    phase.value = 'idle'
    progress.value = null
    errorText.value = null
  },
)
</script>

<template>
  <div class="scrim" @click.self="later">
    <div
      ref="panel"
      class="dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="update-dialog-title"
      tabindex="-1"
      @keydown="onKeydown"
    >
      <header class="dialog__head">
        <h2 id="update-dialog-title" class="dialog__title">
          {{ t('update.title', { version: latest }) }}
        </h2>
        <p class="dialog__sub">{{ t('update.current', { current: result.current }) }}</p>
      </header>

      <div class="notes-wrap">
        <!--
          跨了多个版本时按版本逐段列出（旧→新）：用户跳着升级几版，
          只讲最新一版等于告诉他「除此之外什么都没变」。
        -->
        <p v-if="omitted > 0" class="omitted">
          {{ t('update.omitted', { count: omitted, total: totalVersions }) }}
        </p>
        <div class="releases">
          <section v-for="section in sections" :key="section.version" class="release">
            <h3 class="release__version">{{ section.version }}</h3>
            <ul v-if="section.lines.length" class="notes">
              <li v-for="(line, index) in section.lines" :key="index">{{ line }}</li>
            </ul>
            <p v-else class="notes notes--empty">{{ t('update.noNotes') }}</p>
          </section>
        </div>
        <button
          v-if="sections.length === 1 && sections[0]?.url"
          class="more"
          type="button"
          @click="openReleasePage"
        >
          <ExternalLink :size="11" aria-hidden="true" />
          {{ t('update.fullNotes') }}
        </button>
      </div>

      <p v-if="!canAutoInstall" class="warn">{{ t('update.noChecksum') }}</p>

      <!-- 下载中：进度条 + 数字 -->
      <div v-if="phase === 'downloading' || phase === 'verifying'" class="progress">
        <span class="progress__track" aria-hidden="true">
          <span
            class="progress__fill"
            :class="{ 'is-indeterminate': percent === null }"
            :style="percent === null ? undefined : { width: `${percent}%` }"
          />
        </span>
        <span class="progress__text">
          <template v-if="phase === 'verifying'">{{ t('about.verifying') }}</template>
          <template v-else>
            {{ t('about.downloading') }}
            <template v-if="percent !== null">· {{ percent }}%</template>
          </template>
          <template v-if="sizeLabel">· {{ sizeLabel }}</template>
        </span>
      </div>

      <p v-else-if="phase === 'ready'" class="state state--ok">
        <ShieldCheck :size="13" aria-hidden="true" />
        {{ t('update.ready', { version: latest }) }}
      </p>

      <p v-else-if="phase === 'installing'" class="state state--ok">
        <RefreshCw :size="13" class="spinning" aria-hidden="true" />
        {{ t('update.installing') }}
      </p>

      <p v-else-if="phase === 'error'" class="state state--error">
        {{ t('update.error') }}<template v-if="errorText"> · {{ errorText }}</template>
      </p>

      <p class="foot-note">{{ isMac ? t('about.updateNoteMac') : t('about.updateNote') }}</p>

      <footer class="dialog__actions">
        <button class="btn btn--ghost" type="button" @click="later">{{ t('update.later') }}</button>
        <button
          v-if="canAutoInstall"
          class="btn"
          type="button"
          :disabled="phase === 'downloading' || phase === 'verifying' || phase === 'installing'"
          @click="startDownload"
        >
          <Download :size="12" aria-hidden="true" />
          {{
            phase === 'error' ? t('update.retry') : t('about.downloadUpdate', { version: latest })
          }}
        </button>
        <button v-else-if="result.downloadUrl" class="btn" type="button" @click="openReleasePage">
          <ExternalLink :size="12" aria-hidden="true" />
          {{ t('about.openDownload') }}
        </button>
        <button
          v-if="canAutoInstall"
          class="btn btn--primary"
          type="button"
          :disabled="phase !== 'ready'"
          @click="install"
        >
          {{ isMac ? t('about.installNowMac') : t('about.installNow') }}
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.scrim {
  position: fixed;
  inset: 0;
  z-index: 78;
  display: grid;
  place-items: center;
  background: color-mix(in srgb, var(--dv-ui-bg) 58%, transparent);
}

.dialog {
  width: min(520px, calc(100vw - 64px));
  padding: 20px;
  border: 1px solid var(--dv-ui-line);
  border-radius: var(--dv-ui-radius-md);
  background: var(--dv-ui-surface-2);
  box-shadow: var(--dv-ui-shadow-2);
  outline: none;
}

.dialog__head {
  margin-bottom: 12px;
}

.dialog__title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--dv-ui-text);
}

.dialog__sub {
  margin: 4px 0 0;
  font-size: 11.5px;
  color: var(--dv-ui-text-dim);
}

.notes-wrap {
  padding: 10px 12px;
  border: 1px solid var(--dv-ui-line-soft);
  border-radius: var(--dv-ui-radius-sm);
  background: var(--dv-ui-surface-1);
}

/* 版本段整体滚动，而不是把按钮挤出弹窗 */
.releases {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 240px;
  overflow-y: auto;
}

.release {
  min-width: 0;
}

/* 段之间用细分隔线，让人一眼看出「这是另一版」 */
.release + .release {
  padding-top: 10px;
  border-top: 1px solid var(--dv-ui-line-soft);
}

.release__version {
  margin: 0 0 5px;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--dv-ui-text);
}

.omitted {
  margin: 0 0 8px;
  font-size: 10.5px;
  color: var(--dv-ui-text-dim);
}

.notes {
  margin: 0;
  padding-left: 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
  line-height: 1.65;
  color: var(--dv-ui-text-2);
}

.notes--empty {
  padding-left: 0;
  color: var(--dv-ui-text-dim);
}

.more {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-top: 7px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--dv-ui-accent);
  font-size: 11px;
  cursor: pointer;
}

.more:hover {
  text-decoration: underline;
}

.warn {
  margin: 10px 0 0;
  font-size: 11px;
  color: var(--dv-ui-warn, var(--dv-ui-accent));
}

.progress {
  margin-top: 12px;
}

.progress__track {
  display: block;
  height: 5px;
  border-radius: 999px;
  background: var(--dv-ui-surface-3);
  overflow: hidden;
}

.progress__fill {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: var(--dv-ui-accent);
  transition: width var(--dv-dur-2) var(--dv-ease);
}

.progress__fill.is-indeterminate {
  width: 40%;
  animation: slide 1.1s ease-in-out infinite;
}

.progress__text {
  display: block;
  margin-top: 6px;
  font-size: 11px;
  color: var(--dv-ui-text-dim);
}

.state {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 12px 0 0;
  font-size: 12px;
}

.state--ok {
  color: var(--dv-ui-ok, #6aa87a);
}

.state--error {
  color: var(--dv-ui-danger);
}

.foot-note {
  margin: 12px 0 0;
  font-size: 10.5px;
  line-height: 1.6;
  color: var(--dv-ui-text-dim);
}

.dialog__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}

.btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 30px;
  padding: 0 13px;
  border: 1px solid var(--dv-ui-line-soft);
  border-radius: var(--dv-ui-radius-sm);
  background: transparent;
  color: var(--dv-ui-text-2);
  font-size: 12px;
  cursor: pointer;
}

.btn--primary {
  border-color: transparent;
  background: var(--dv-ui-accent);
  color: var(--dv-ui-accent-fg);
}

.btn--ghost {
  border-color: transparent;
  color: var(--dv-ui-text-dim);
}

.btn:hover:not(:disabled) {
  background: var(--dv-ui-surface-3);
}

.btn--primary:hover:not(:disabled) {
  background: var(--dv-ui-accent);
  filter: brightness(1.08);
}

.btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@keyframes slide {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(250%);
  }
}

@media (prefers-reduced-motion: reduce) {
  .progress__fill.is-indeterminate {
    animation: none;
    width: 100%;
    opacity: 0.5;
  }
}
</style>
