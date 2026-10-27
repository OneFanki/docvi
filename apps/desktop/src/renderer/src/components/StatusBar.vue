<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  BookOpen,
  Columns2,
  Maximize2,
  Minimize2,
  PencilLine,
  Palette,
  Code2,
  RefreshCw,
  WrapText,
  X,
} from 'lucide-vue-next'

import type { DocPayload } from '@docvi/shared'
import { isStandaloneDoc } from '@docvi/shared'

import { useI18n } from '../lib/i18n'
import { fitPathTail } from '../lib/path-elide'
import { taskState } from '../lib/tasks'
import { useThemeOptions } from '../lib/theme-options'
import ThemeMenu from './ThemeMenu.vue'

/**
 * 底部状态栏：24px，信息 + 少量全局开关。
 *
 * 只放「当前上下文」与阅读/编辑相关开关（模式、文档主题）。
 * 面板显隐（目录树 / 大纲）属于窗口 chrome，统一放在标题栏右上角。
 * 不放业务操作——状态栏一旦混入操作按钮就会持续增长，最终变成第二个工具栏。
 */
const props = defineProps<{
  doc: DocPayload | null
  workspaceRoot: string | null
  docTheme?: string
  mode?: 'read' | 'live' | 'source' | 'split'
  dirty?: boolean
  /** 本地服务（MCP）是否运行中 */
  serviceRunning?: boolean
  /** 服务端口（运行时才有） */
  servicePort?: number | null
  /** 正文宽度：铺满 / 收窄 */
  contentWidth?: 'full' | 'measure'
  /** 源码折行：wrap / nowrap */
  editorWrap?: 'wrap' | 'nowrap'
  /** 只读宿主（容器版）：隐藏编辑模式与服务芯片——两者在那里都不存在 */
  readonly?: boolean
  /** 正在按磁盘重读当前文档（按钮转起来，避免重复点击） */
  reloading?: boolean
}>()

const emit = defineEmits<{
  setMode: [mode: 'read' | 'live' | 'source' | 'split']
  openService: []
  toggleContentWidth: []
  toggleEditorWrap: []
  /** 按磁盘重读当前文档 */
  reload: []
  /** 在下拉里选了某一套主题（id） */
  selectTheme: [id: string]
}>()

const { t } = useI18n()
const themeOptions = useThemeOptions()
const themeButton = ref<HTMLElement | null>(null)
/** 主题下拉：开着没有 + 展开方向以按钮上沿为基线（状态栏在底部，向下没空间） */
const themeMenu = ref<{
  open: boolean
  anchor: { left: number; right: number; top: number } | null
}>({ open: false, anchor: null })

/** 按按钮当前的位置展开（点击与快捷键共用，避免两处各算一遍锚点） */
function openThemeMenu(): void {
  const button = themeButton.value
  if (!button) return
  const rect = button.getBoundingClientRect()
  themeMenu.value = {
    open: true,
    anchor: { left: rect.left, right: rect.right, top: rect.top },
  }
}

function toggleThemeMenu(): void {
  if (themeMenu.value.open) themeMenu.value = { open: false, anchor: null }
  else openThemeMenu()
}

defineExpose({ openThemeMenu })

/** 当前主题的显示名：查不到（插件刚被停用）时退回 id，不至于显示空白 */
const themeTitle = computed(
  () => themeOptions.value.find(item => item.id === props.docTheme)?.title ?? props.docTheme ?? '',
)

const pathLabel = computed(() => props.doc?.path ?? '')
/** 单文件（工作区外）时 path 就是绝对路径，再显示根目录会变成两遍一样的路径 */
const isStandalone = computed(() => (props.doc ? isStandaloneDoc(props.doc) : false))
const rootLabel = computed(() => {
  if (isStandalone.value) return t('status.standalone')
  return props.workspaceRoot ?? t('status.noWorkspace')
})

/**
 * 内容宽度按钮的文字：写**点击后会变成什么**，不写当前状态。
 *
 * 铺满是默认档位，按钮上写「铺满」只是在复述用户已经看见的布局；写「收窄」
 * 才告诉他这里还能做什么。旁边的主题按钮本来就是同一套语义（深色时显示太阳，
 * 表示点了会变浅），两个开关不该一个说状态、一个说动作。
 *
 * 也正因为标签是动作，这个按钮不加选中高亮：亮着的「铺满」会被读成「铺满已选中」。
 */
const widthLabel = computed(() =>
  props.contentWidth === 'measure' ? t('status.widthFull') : t('status.widthMeasure'),
)

/**
 * 服务芯片文案：运行中显示端口，未运行显示「未运行」。
 *
 * 不写「MCP」：这个进程同时提供 MCP 端点和分享链接两件事，MCP 只是其中一半。
 * 用户在状态栏关心的是「对外那条通道开着没」，不是它用了哪个协议；
 * 具体端点与令牌点进去就在设置里。
 */
const serviceLabel = computed(() => {
  if (!props.serviceRunning) return t('status.serviceOff')
  return props.servicePort
    ? t('status.serviceOn', { port: props.servicePort })
    : t('status.serviceRunning')
})

const serviceTitle = computed(() => {
  if (!props.serviceRunning) return t('status.serviceOffHint')
  return t('status.serviceOnHint', { port: props.servicePort ?? 0 })
})

/**
 * 底栏进度区：后台任务优先，其次显示刚才完成的那条。
 *
 * 位置固定在 spacer 之后、模式按钮之前——它是「系统在做的事」，
 * 与右侧「用户能点的开关」分开，扫一眼就知道谁在动。
 */
const taskLabel = computed(() => {
  if (taskState.current) {
    const { label, detail } = taskState.current
    return detail ? `${label}（${detail}）` : label
  }
  return taskState.finished ? t('status.taskDone', { label: taskState.finished.label }) : null
})

const taskRatio = computed(() => taskState.current?.ratio ?? null)

function cancelTask(): void {
  taskState.cancel?.()
}

/* ---------- 路径尾部优先 ---------- */

/** 路径文本容器：宽度变化后重算显示形态 */
const pathEl = ref<HTMLElement | null>(null)
/** 可用宽度（容器实测宽度）；0 = 还没量到 */
const pathWidth = ref(0)
/** 实际显示的路径（可能是截断后的） */
const pathDisplay = ref('')

/**
 * 文字宽度测量：用 canvas 而不是插入隐藏节点。
 *
 * 隐藏节点会触发一次布局抖动，而每次宽度变化都要重算——measureText 是纯计算，
 * 不受布局影响。
 */
let measureCtx: CanvasRenderingContext2D | null = null
function measureText(value: string): number {
  if (!measureCtx) {
    const canvas = document.createElement('canvas')
    measureCtx = canvas.getContext('2d')
  }
  if (!measureCtx) return value.length * 6
  // 与状态栏同一套字号：这里改了那边必须同步
  measureCtx.font = '11px ui-sans-serif, system-ui, sans-serif'
  return measureCtx.measureText(value).width
}

function updatePathDisplay(): void {
  const text = pathLabel.value
  if (!text) {
    pathDisplay.value = ''
    return
  }
  const available = pathWidth.value
  pathDisplay.value = available > 0 ? fitPathTail(text, available, measureText) : text
}

/**
 * 路径列的宽度由 flex 决定（它吃掉剩余空间），所以只能观测不能预设。
 *
 * 用 ResizeObserver 而不是 window resize：状态栏变窄不一定是窗口变小
 * （侧栏展开、控件增减都会），只听窗口尺寸会漏掉这些。
 *
 * ⚠️ 必须 watch `pathEl` 而不是只在 onMounted 里 observe：这个元素带
 * `v-if="pathLabel"`，挂载时通常还没有打开文档 → ref 是 null，观察器什么都没挂上，
 * 之后宽度怎么变都不会重算（实测症状：长路径原样溢出，截断完全没生效）。
 */
let pathObserver: ResizeObserver | null = null

function observePath(el: HTMLElement | null): void {
  pathObserver?.disconnect()
  pathObserver = null
  if (!el || typeof ResizeObserver === 'undefined') return
  pathObserver = new ResizeObserver(entries => {
    const width = entries[0]?.contentRect.width ?? 0
    if (Math.abs(width - pathWidth.value) < 1) return
    pathWidth.value = width
    updatePathDisplay()
  })
  pathObserver.observe(el)
}

watch(pathEl, el => {
  observePath(el)
  updatePathDisplay()
})

onMounted(() => {
  observePath(pathEl.value)
  updatePathDisplay()
})

watch(pathLabel, () => updatePathDisplay())

/* ---------- 控件区横向滚动 ---------- */

/**
 * 窄窗口下按钮区可横向滚动。
 *
 * **原生滚动条一个像素都不能参与布局**：状态栏只有 24px，Windows 的原生横向
 * 滚动条要占 10px 左右，`overflow-x: auto` 会把它算进容器高度，控件区从 18px
 * 变成 28px——实测就是「状态栏被撑高、按钮整体上移」。所以这里彻底关掉原生
 * 滚动条（`scrollbar-width: none` + `::-webkit-scrollbar { display: none }`），
 * 自己画一条**绝对定位**的悬浮指示条：只在 hover 时出现，位置浮在状态栏底边，
 * 不占任何布局空间。
 *
 * 滚动本身仍然可用：触控板横扫、Shift+滚轮、按住拖动都能滚。
 */
const controlsEl = ref<HTMLElement | null>(null)
const controlsOverflow = ref(false)
/** 悬浮指示条：宽度与位置按滚动比例算 */
const scrollThumb = ref({ left: 0, width: 0 })

function syncControlsOverflow(): void {
  const el = controlsEl.value
  if (!el) return
  // 1px 容差：小数宽度会让 scrollWidth 总比 clientWidth 大一点点
  controlsOverflow.value = el.scrollWidth - el.clientWidth > 1
  syncThumb()
}

function syncThumb(): void {
  const el = controlsEl.value
  if (!el || el.scrollWidth <= 0) {
    scrollThumb.value = { left: 0, width: 0 }
    return
  }
  const ratio = el.clientWidth / el.scrollWidth
  const width = Math.max(18, Math.round(el.clientWidth * ratio))
  const maxScroll = el.scrollWidth - el.clientWidth
  const progress = maxScroll > 0 ? el.scrollLeft / maxScroll : 0
  const left = Math.round(progress * (el.clientWidth - width))
  scrollThumb.value = { left, width }
}

/** Shift+滚轮 → 横向滚动（鼠标用户的常规路径；触控板本来就支持横扫） */
function onControlsWheel(event: WheelEvent): void {
  const el = controlsEl.value
  if (!el || !controlsOverflow.value) return
  if (!event.shiftKey && Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return
  event.preventDefault()
  el.scrollLeft += event.shiftKey ? event.deltaY : event.deltaX
}

let controlsObserver: ResizeObserver | null = null

function observeControls(el: HTMLElement | null): void {
  controlsObserver?.disconnect()
  controlsObserver = null
  if (!el || typeof ResizeObserver === 'undefined') return
  controlsObserver = new ResizeObserver(() => syncControlsOverflow())
  controlsObserver.observe(el)
}

watch(controlsEl, el => {
  observeControls(el)
  syncControlsOverflow()
})

onMounted(() => {
  observeControls(controlsEl.value)
  syncControlsOverflow()
})

/** 控件数量变化（模式按钮 / 折行开关显隐）后重新判断是否需要滚动 */
watch(
  () => [props.mode, props.doc, props.readonly, props.editorWrap, taskLabel.value] as const,
  () => void nextTick(syncControlsOverflow),
)

onBeforeUnmount(() => {
  pathObserver?.disconnect()
  pathObserver = null
  controlsObserver?.disconnect()
  controlsObserver = null
})
</script>

<template>
  <footer class="status">
    <span v-tooltip="rootLabel" class="status__item status__item--muted">{{ rootLabel }}</span>
    <!--
      路径列：吃掉剩余宽度，显示时**从尾部优先**（见 lib/path-elide.ts）。
      完整路径始终在 hover 提示里，所以截断不会丢信息。
    -->
    <span
      v-if="pathLabel"
      ref="pathEl"
      v-tooltip="pathLabel"
      class="status__item status__item--path"
    >
      {{ pathDisplay }}
    </span>
    <span class="status__spacer" />

    <!--
      右侧控件区：窄窗口下可横向滚动。
      滚动条是**自绘的悬浮条**（末尾那个 span）：绝对定位在状态栏底边，
      只在 hover 时显形，不参与布局——原生滚动条会把 24px 的状态栏撑高。
    -->
    <div class="status__scroll">
      <div
        ref="controlsEl"
        class="status__controls"
        :class="{ 'has-overflow': controlsOverflow }"
        @scroll="syncThumb"
        @wheel="onControlsWheel"
      >
        <!--
        ⚠️ 顺序即稳定性契约：**会随状态增减或改变宽度的东西一律放最左**。

        整排是右对齐的，所以往最右侧插一个按钮会把左边所有按钮一起推走——
        用户报的「点了实时预览，模式按钮全被往左挤」就是这个：折行开关只在
        源码/分屏下出现，却排在模式按钮右边。

        现在的顺序：变宽/变身的（任务进度、脏标记、折行）→ 永远四个的模式按钮
        → 固定宽度的操作（重载、宽度、主题、服务）。模式按钮左边再多东西，
        它们相对右边缘的位置也不会动。
      -->

        <!--
        后台任务进度：索引 / 同步这类长任务在跑时必须可见，否则用户点完只能
        凭猜——「是不是没反应？」。不确定进度（ratio = null）时显示流动条。
      -->
        <span v-if="taskLabel" class="status__task" :title="taskLabel">
          <span class="status__task-text">{{ taskLabel }}</span>
          <span class="status__task-bar" aria-hidden="true">
            <span
              class="status__task-fill"
              :class="{ 'is-indeterminate': taskRatio === null }"
              :style="taskRatio === null ? undefined : { width: `${Math.round(taskRatio * 100)}%` }"
            />
          </span>
          <button
            v-if="taskState.current && taskState.cancel"
            class="status__task-cancel"
            type="button"
            :aria-label="t('status.taskCancel')"
            @click="cancelTask"
          >
            <X :size="10" :stroke-width="2.2" aria-hidden="true" />
          </button>
        </span>

        <span v-if="dirty && !readonly" class="status__dirty">{{ t('status.dirty') }}</span>

        <!--
        折行开关：只在源码/分屏下有意义（实时预览不显示原始换行、阅读态没有源码）。
        它是唯一会凭空出现/消失的控件，所以必须排在模式按钮**左边**。
      -->
        <button
          v-if="doc && !readonly && (mode === 'source' || mode === 'split')"
          v-tooltip="t('status.editorWrap')"
          class="status__btn status__btn--fixed"
          :class="{ 'is-on': editorWrap === 'nowrap' }"
          type="button"
          :aria-label="t('status.editorWrap')"
          @click="emit('toggleEditorWrap')"
        >
          <WrapText :size="12" :stroke-width="1.8" aria-hidden="true" />
          <span>{{ editorWrap === 'nowrap' ? t('status.wrapOff') : t('status.wrapOn') }}</span>
        </button>

        <template v-if="doc && !readonly">
          <button
            v-tooltip="t('status.mode.read')"
            class="status__btn"
            :class="{ 'is-on': mode === 'read' }"
            type="button"
            :aria-label="t('status.mode.read')"
            @click="emit('setMode', 'read')"
          >
            <BookOpen :size="12" :stroke-width="1.8" aria-hidden="true" />
            <span>{{ t('status.mode.read') }}</span>
          </button>
          <button
            v-tooltip="`${t('status.mode.live')} (Ctrl+E)`"
            class="status__btn"
            :class="{ 'is-on': mode === 'live' }"
            type="button"
            :aria-label="t('status.mode.live')"
            @click="emit('setMode', 'live')"
          >
            <PencilLine :size="12" :stroke-width="1.8" aria-hidden="true" />
            <span>{{ t('status.mode.live') }}</span>
          </button>
          <button
            v-tooltip="t('status.mode.source')"
            class="status__btn"
            :class="{ 'is-on': mode === 'source' }"
            type="button"
            :aria-label="t('status.mode.source')"
            @click="emit('setMode', 'source')"
          >
            <Code2 :size="12" :stroke-width="1.8" aria-hidden="true" />
            <span>{{ t('status.mode.source') }}</span>
          </button>
          <button
            v-tooltip="`${t('status.mode.split')} (Ctrl+\\)`"
            class="status__btn"
            :class="{ 'is-on': mode === 'split' }"
            type="button"
            :aria-label="t('status.mode.split')"
            @click="emit('setMode', 'split')"
          >
            <Columns2 :size="12" :stroke-width="1.8" aria-hidden="true" />
            <span>{{ t('status.mode.split') }}</span>
          </button>
        </template>

        <!--
        重新载入：文件被外部改动（AI 写盘 / git 拉取 / 别的编辑器）时的唯一显式
        入口。watcher 大多数情况能自动跟上，但监视可能因目录权限、网络盘或事件
        丢失而失效——没有手动入口，用户只能关掉标签再打开。

        放在只读判断之外：容器读者面同样需要它（服务端内容随仓库更新/换分支变化）。
      -->
        <button
          v-if="doc"
          v-tooltip="t('doc.reloadHint')"
          class="status__btn status__btn--fixed"
          type="button"
          :disabled="reloading"
          :aria-label="t('doc.reload')"
          @click="emit('reload')"
        >
          <RefreshCw
            :size="12"
            :stroke-width="1.8"
            aria-hidden="true"
            :class="{ 'is-spinning': reloading }"
          />
          <span>{{ t('doc.reload') }}</span>
        </button>
        <!--
        宽度按钮给固定宽度：标签在「铺满 / 收窄」之间切换，宽度不同会把
        主题与服务芯片推来推去。
      -->
        <button
          v-tooltip="`${t('status.contentWidth')} (Ctrl+Alt+W)`"
          class="status__btn status__btn--fixed"
          type="button"
          :aria-label="t('status.widthAction', { action: widthLabel })"
          @click="emit('toggleContentWidth')"
        >
          <Minimize2
            v-if="contentWidth !== 'measure'"
            :size="12"
            :stroke-width="1.8"
            aria-hidden="true"
          />
          <Maximize2 v-else :size="12" :stroke-width="1.8" aria-hidden="true" />
          <span>{{ widthLabel }}</span>
        </button>
        <!--
        主题按钮：显示当前主题名并展开完整列表。
        不做「点一下翻到另一套」——主题早就不止两套（插件可带任意多套），
        翻转在 n 套下没有定义，那个动作本身也是深浅二分的残留。
        插件主题名可能很长，限宽并省略，避免把服务芯片挤出去。
      -->
        <button
          ref="themeButton"
          v-tooltip="`${t('status.chooseTheme')} (Ctrl+Shift+L)`"
          class="status__btn status__btn--fixed status__btn--truncate"
          type="button"
          :class="{ 'is-on': themeMenu.open }"
          :aria-label="t('status.chooseTheme')"
          :aria-expanded="themeMenu.open"
          :aria-haspopup="'menu'"
          @click="toggleThemeMenu"
        >
          <Palette :size="12" :stroke-width="1.8" aria-hidden="true" />
          <span>{{ themeTitle }}</span>
        </button>
        <!--
        本地服务状态芯片：常驻可见、点击进设置的服务分区。
        服务是独立进程，用户需要一眼看到「对外那条通道开着没」，而不是进设置才发现它挂了。
      -->
        <button
          v-if="!readonly"
          v-tooltip="serviceTitle"
          class="status__service status__btn--fixed"
          type="button"
          :class="{ 'is-off': !serviceRunning }"
          :aria-label="serviceTitle"
          @click="emit('openService')"
        >
          <!--
          圆点用 CSS 画，不用 lucide 的 Circle 图标：那个 svg 的圆形**撑满整个
          viewBox**（半径 10/24，加上 2 的描边正好贴边），缩到 7px 后左右两极
          落在像素边界上，抗锯齿会把它们削掉一半——看起来就是左边被裁了。
          一个实心圆点本来也不需要矢量图标，7px 的 div 反而更准。
        -->
          <span class="status__dot" aria-hidden="true" />
          <span>{{ serviceLabel }}</span>
        </button>
      </div>

      <!--
        悬浮滚动指示条：绝对定位在状态栏底边，不参与任何布局。
        宽度按「可见比例」算、位置按滚动进度算，与原生滚动条的语义一致，
        但它在 DOM 里是浮层——出现/消失都不会让按钮移动一个像素。
      -->
      <span
        v-if="controlsOverflow && scrollThumb.width > 0"
        class="status__thumb"
        :style="{ left: `${scrollThumb.left}px`, width: `${scrollThumb.width}px` }"
        aria-hidden="true"
      />
    </div>

    <ThemeMenu
      :open="themeMenu.open"
      :anchor="themeMenu.anchor"
      :options="themeOptions"
      :current="docTheme ?? ''"
      @close="themeMenu = { open: false, anchor: null }"
      @select="emit('selectTheme', $event)"
    />
  </footer>
</template>

<style scoped>
.status {
  height: var(--dv-ui-statusbar-h);
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px;
  background: var(--dv-ui-surface-1);
  border-top: 1px solid var(--dv-ui-line-soft);
  font-size: 11px;
  color: var(--dv-ui-text-dim);
  user-select: none;
  /* 状态栏本身永不滚：窄窗口下只让右侧控件区自己滚 */
  overflow: hidden;
}

.status__item {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status__item--muted {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--dv-ui-text-dim);
  /* 作用域名是次要信息：宁可让它先被压扁，也要保住路径 */
  flex: 0 1 auto;
  max-width: 22%;
}

/*
 * 路径列：吃掉剩余宽度。
 *
 * 截断由脚本按**尾部优先**算好（lib/path-elide.ts），这里不再用 CSS 的
 * text-overflow——那样会砍掉尾部，而尾部（文件名）恰恰是最该保留的部分。
 */
.status__item--path {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--dv-ui-text-muted);
}

/*
 * 右侧控件区：窄窗口下可横向滚动。
 *
 * **原生滚动条一个像素都不能参与布局**：状态栏只有 24px，原生横向滚动条要占
 * 10px 左右，`overflow-x: auto` 会把它算进容器高度——控件区从 18px 涨到 28px，
 * 实测就是「状态栏被撑高、整个界面被推上去一点」。
 *
 * 所以这里彻底关掉原生滚动条（`scrollbar-width: none` + `::-webkit-scrollbar`），
 * 滚动能力仍然保留（触控板横扫 / Shift+滚轮），可视反馈由外层的 `.status__thumb`
 * 自绘悬浮条提供。
 */
.status__scroll {
  position: relative;
  display: flex;
  align-items: center;
  flex: 0 1 auto;
  min-width: 0;
}

.status__controls {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: 0 1 auto;
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}

.status__controls::-webkit-scrollbar {
  display: none;
}

/*
 * 悬浮滚动指示条：绝对定位在状态栏底边，`pointer-events: none` 让它不抢点击。
 * 只在鼠标移入控件区时显形——平时整条状态栏保持干净。
 */
.status__thumb {
  position: absolute;
  bottom: 0;
  height: 2px;
  border-radius: 999px;
  background: var(--dv-ui-text-dim);
  opacity: 0;
  transition: opacity var(--dv-dur-1) var(--dv-ease);
  pointer-events: none;
}

.status__scroll:hover .status__thumb {
  opacity: 0.45;
}

.status__spacer {
  flex: 1 1 auto;
  min-width: 4px;
}

/* ---------- 后台任务进度 ---------- */

.status__task {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 34vw;
  color: var(--dv-ui-text-muted);
}

.status__task-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10.5px;
}

.status__task-bar {
  flex: none;
  position: relative;
  width: 54px;
  height: 3px;
  border-radius: 2px;
  background: var(--dv-ui-surface-3);
  overflow: hidden;
}

.status__task-fill {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--dv-ui-accent);
  transition: width var(--dv-ui-dur-2) var(--dv-ui-ease);
}

/* 不确定进度：一条来回滑动的短条（比转圈省地方，也不会在 24px 里糊成一团） */
.status__task-fill.is-indeterminate {
  width: 40%;
  animation: status-task-slide 1.1s var(--dv-ui-ease) infinite;
}

@keyframes status-task-slide {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(250%);
  }
}

@media (prefers-reduced-motion: reduce) {
  .status__task-fill.is-indeterminate {
    animation: none;
    width: 100%;
    opacity: 0.5;
  }
}

.status__task-cancel {
  flex: none;
  display: grid;
  place-items: center;
  width: 14px;
  height: 14px;
  padding: 0;
  border: none;
  border-radius: 3px;
  background: transparent;
  color: var(--dv-ui-text-dim);
  cursor: pointer;
}

.status__task-cancel:hover {
  background: var(--dv-ui-surface-3);
  color: var(--dv-ui-text);
}

.status__btn {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 18px;
  /* 更紧凑：状态栏是常驻信息条，不是工具栏，横向要留给路径 */
  padding: 0 5px;
  border: none;
  border-radius: 3px;
  background: transparent;
  color: var(--dv-ui-text-dim);
  font-size: 11px;
  white-space: nowrap;
  /* 可滚动区里的子项一律不收缩：被压扁的按钮比出现滚动条更难用 */
  flex: none;
  cursor: pointer;
  transition:
    background var(--dv-dur-1) var(--dv-ease),
    color var(--dv-dur-1) var(--dv-ease);
}

/*
 * 宽度恒定的按钮：高亮态（is-on）会加粗视觉重量，但盒子宽度不能变，
 * 否则点一下模式，右边所有按钮都会跟着挪。
 */
.status__btn--fixed {
  justify-content: center;
  min-width: 58px;
}

/* 主题名可能很长（插件主题）：限宽并省略，不推挤后面的服务芯片 */
.status__btn--truncate {
  max-width: 92px;
}

.status__btn--truncate > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status__btn:hover {
  background: var(--dv-ui-surface-2);
  color: var(--dv-ui-text-2);
}

.status__btn.is-on {
  background: var(--dv-ui-surface-3);
  color: var(--dv-ui-text);
}

.status__dirty {
  flex: none;
  padding: 0 6px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--dv-ui-accent) 18%, transparent);
  color: var(--dv-ui-accent);
  font-size: 10.5px;
  white-space: nowrap;
}

/* 重新载入进行中：图标转起来，同时按钮禁用，避免连点堆多次读盘 */
.status__btn .is-spinning {
  animation: status-spin 0.9s linear infinite;
}

@keyframes status-spin {
  to {
    transform: rotate(360deg);
  }
}

/* 实心圆点：flex 子项不参与收缩，否则窄屏下会被压成椭圆 */
.status__dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--dv-ui-success);
}

.status__service.is-off .status__dot {
  background: var(--dv-ui-text-dim);
}

/* 服务芯片：常驻、可点、状态用颜色区分（运行绿点 / 未运行灰点） */
.status__service {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 18px;
  padding: 0 7px;
  border: 1px solid transparent;
  border-radius: 999px;
  background: transparent;
  color: var(--dv-ui-text-muted);
  font: inherit;
  font-size: 11px;
  white-space: nowrap;
  cursor: pointer;
  transition:
    background var(--dv-ui-dur-1) var(--dv-ui-ease),
    border-color var(--dv-ui-dur-1) var(--dv-ui-ease);
}

.status__service:hover {
  border-color: var(--dv-ui-line-soft);
  background: var(--dv-ui-surface-2);
  color: var(--dv-ui-text-2);
}

.status__service.is-off {
  color: var(--dv-ui-text-dim);
}
</style>
