<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  BookOpen,
  Columns2,
  Maximize2,
  Minimize2,
  PencilLine,
  Palette,
  Code2,
  WrapText,
  X,
} from 'lucide-vue-next'

import type { DocPayload } from '@docvi/shared'
import { isStandaloneDoc } from '@docvi/shared'

import { useI18n } from '../lib/i18n'
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
}>()

const emit = defineEmits<{
  setMode: [mode: 'read' | 'live' | 'source' | 'split']
  openService: []
  toggleContentWidth: []
  toggleEditorWrap: []
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
</script>

<template>
  <footer class="status">
    <span v-tooltip="rootLabel" class="status__item status__item--muted">{{ rootLabel }}</span>
    <span v-if="pathLabel" v-tooltip="pathLabel" class="status__item status__item--path">
      {{ pathLabel }}
    </span>
    <span class="status__spacer" />

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
      <!--
        折行开关只在源码/分屏下有意义：实时预览本来就不显示原始换行，
        阅读态更是没有源码可折。放在模式按钮之后，语义上属于「当前编辑方式」。
      -->
      <button
        v-if="mode === 'source' || mode === 'split'"
        v-tooltip="t('status.editorWrap')"
        class="status__btn"
        :class="{ 'is-on': editorWrap === 'nowrap' }"
        type="button"
        :aria-label="t('status.editorWrap')"
        @click="emit('toggleEditorWrap')"
      >
        <WrapText :size="12" :stroke-width="1.8" aria-hidden="true" />
        <span>{{ editorWrap === 'nowrap' ? t('status.wrapOff') : t('status.wrapOn') }}</span>
      </button>
      <span v-if="dirty" class="status__dirty">{{ t('status.dirty') }}</span>
    </template>
    <button
      v-tooltip="`${t('status.contentWidth')} (Ctrl+Alt+W)`"
      class="status__btn"
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
    -->
    <button
      ref="themeButton"
      v-tooltip="`${t('status.chooseTheme')} (Ctrl+Shift+L)`"
      class="status__btn"
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
      class="status__service"
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
  gap: 10px;
  padding: 0 10px;
  background: var(--dv-ui-surface-1);
  border-top: 1px solid var(--dv-ui-line-soft);
  font-size: 11px;
  color: var(--dv-ui-text-dim);
  user-select: none;
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
}

.status__item--path {
  max-width: 40vw;
  color: var(--dv-ui-text-muted);
  direction: rtl;
  text-align: left;
}

.status__spacer {
  flex: 1;
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
  padding: 0 6px;
  border: none;
  border-radius: 3px;
  background: transparent;
  color: var(--dv-ui-text-dim);
  font-size: 11px;
  cursor: pointer;
  transition:
    background var(--dv-dur-1) var(--dv-ease),
    color var(--dv-dur-1) var(--dv-ease);
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
  padding: 0 6px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--dv-ui-accent) 18%, transparent);
  color: var(--dv-ui-accent);
  font-size: 10.5px;
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
