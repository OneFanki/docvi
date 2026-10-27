<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { AlertTriangle, ChevronDown, ChevronUp, FileText, Search, Share2, X } from 'lucide-vue-next'
import {
  highlightPass,
  mermaidPass,
  mountDeclarativeComponents,
  mountPluginBlocks,
  renderMarkdown,
  type DeclarativeMount,
  type OutlineEntry,
  type RenderResult,
} from '@docvi/renderer-core'

import type { DocPayload } from '@docvi/shared'
import { isStandaloneDoc } from '@docvi/shared'
import ImageLightbox from '@plugins/base/src/components/ImageLightbox.vue'
import { createHostRegistry } from '../lib/component-registry'
import { isReadOnlyHost } from '../lib/host'
import { usePluginStore } from '../stores/plugins'
import { useI18n } from '../lib/i18n'
import { clearMatches, collectMatches, paintMatches, scrollToRange } from '../lib/find-in-doc'

/**
 * 阅读视图：Markdown → HTML → 组件挂载 → 异步高亮/图表。
 *
 * 三条时序约束（都来自旧实现踩过的坑）：
 *  1. 组件挂载必须在 DOM 插入后的 nextTick，且切文档前先 dispose——
 *     否则 Vue 实例叠在同一个容器上，表现为「换文档后旧组件还活着」。
 *  2. 高亮与 mermaid 是异步的，必须用渲染代际令牌防止过期任务覆盖新文档。
 *  3. 滚动位置只在渲染完全结束后恢复：提前设置会被内容撑高时的浏览器
 *     滚动锚定改写（clamp 到顶部）。
 */
const props = defineProps<{
  doc: DocPayload | null
  docTheme: string
  /** 单文件标签：提示该文件不在工作区内（不显示目录树） */
  showTreeHint?: boolean
  /**
   * 站内链接的前缀（容器版为 `/<仓库>`，桌面版为空）。
   *
   * 链接与图片的地址空间可以不同，所以不能跟 `assetPrefix` 合并成一个。
   */
  linkPrefix?: string
  /**
   * 正文内相对资源（图片）的前缀。
   *
   * 容器版文档挂在 `/<仓库>/<路径>` 下，图片的相对路径要补上仓库段才能落到
   * 部署器的内容根；桌面版没有这样的 URL 空间，改用 `docvi://asset/<工作区>/`
   * 由主进程按登记的工作区根伺服——不能留空，留空会拼成 `docvi://app/…`，
   * 落到渲染产物目录里变成破图。
   */
  assetPrefix?: string
  /**
   * 给块级元素标注源行（`data-source-line`）。
   *
   * 阅读视图**始终标注**：切视图时要按源行恢复阅读位置（`getTopLine`），没有
   * 这些属性就无从知道「用户正在看第几行」。导出走的是另一条渲染路径
   * （`lib/export-doc.ts`），不会把内部标记带进产物，所以这里开着没有副作用。
   *
   * 这个 prop 保留只是为了兼容既有调用点（分屏）；行为上与「始终开启」等价。
   */
  sourceLines?: boolean
}>()

const emit = defineEmits<{
  outline: [entries: OutlineEntry[]]
  error: [message: string]
  /** 空状态里的「打开文件…」：由 App 决定走文件选择框 */
  pickFile: []
  /** 正文异步渲染全部完成（此时高度已稳定，可以恢复滚动位置） */
  rendered: [payload: { path: string; title: string }]
  /** 分享当前文档：链接生成、复制都在宿主做（这里只管按钮位置） */
  share: []
  /** 正文里的站内链接（绝对路径）：容器版交给 App 走 SPA 路由，避免整页刷新 */
  navigate: [path: string]
}>()

const scroller = ref<HTMLElement | null>(null)
const host = ref<HTMLElement | null>(null)
const rendered = ref<RenderResult | null>(null)
const copiedLang = ref<string | null>(null)

const plugins = usePluginStore()
const { t } = useI18n()
/**
 * 组件注册表：按插件启用状态决定注册哪些内置组件（规则见 lib/component-registry）。
 * 组件首次创建时注册；插件启停后由 App 用 key 强制重建本组件。
 */
const registry = createHostRegistry()

let mount: DeclarativeMount | null = null
let generation = 0

const wordCount = computed(() => {
  if (!props.doc) return 0
  return props.doc.text.replace(/\s+/g, '').length
})

const readingMinutes = computed(() => Math.max(1, Math.round(wordCount.value / 400)))

/**
 * 面包屑：工作区文档按库内路径逐段拆开；单文件把目录合并成一段。
 *
 * 单文件的 path 是绝对路径，逐段拆开会得到 `C: / Users / <用户名> / AppData / …`，
 * 一屏面包屑比正文还长——这不是导航信息，是噪音。
 */
const breadcrumb = computed(() => {
  if (!props.doc) return []
  const path = props.doc.path.replaceAll('\\', '/')
  const segments = path.split('/').filter(Boolean)
  if (!isStandaloneDoc(props.doc)) return segments
  const file = segments.pop() ?? path
  const dir = segments.join('/')
  return dir ? [dir.replace(/^\//, '') || '/', file] : [file]
})

/* ---------- 文档内查找 ---------- */

const findOpen = ref(false)
const findQuery = ref('')
const findRanges = ref<Range[]>([])
const findIndex = ref(0)
const findInput = ref<HTMLInputElement | null>(null)

const findCount = computed(() => findRanges.value.length)

function repaint(): void {
  paintMatches(findRanges.value, findIndex.value)
}

function runFind(reset = true): void {
  const surface = host.value?.querySelector<HTMLElement>('.at-doc')
  if (!surface) {
    findRanges.value = []
    clearMatches()
    return
  }
  if (reset) findIndex.value = 0
  findRanges.value = collectMatches(surface, findQuery.value)
  if (findIndex.value >= findRanges.value.length) findIndex.value = 0
  repaint()
  const current = findRanges.value[findIndex.value]
  if (current) scrollToRange(current)
}

function step(delta: number): void {
  if (!findRanges.value.length) return
  const size = findRanges.value.length
  findIndex.value = (findIndex.value + delta + size) % size
  repaint()
  const current = findRanges.value[findIndex.value]
  if (current) scrollToRange(current)
}

function closeFind(): void {
  findOpen.value = false
  findQuery.value = ''
  findRanges.value = []
  clearMatches()
}

/** 对外：Ctrl+F 打开查找条 */
function openFind(): void {
  findOpen.value = true
  void nextTick(() => {
    findInput.value?.focus()
    findInput.value?.select()
    if (findQuery.value) runFind()
  })
}

watch(findQuery, () => runFind())

/* ---------- 大图查看（图片 / mermaid） ---------- */

/**
 * 看图状态。`svg` 存 mermaid 渲染产物的 outerHTML，`image` 存 URL。
 *
 * 触发方式统一为事件委托：mermaid 的 `<svg>` 是渲染 pass 注入的 DOM、图片是
 * markdown 渲染出的 `<img>`，两者都没有 Vue 组件边界，各写一套监听必然会漏。
 */
const lightbox = ref<{
  open: boolean
  src: string
  kind: 'image' | 'svg'
  title: string
}>({ open: false, src: '', kind: 'image', title: '' })

/** 点击图片或 mermaid 图 → 打开大图 */
function openViewer(target: HTMLElement): boolean {
  // mermaid：点击 svg 内任意位置（节点 / 文字 / 连线都算）
  const diagram = target.closest<HTMLElement>('.at-mermaid')
  const svg = diagram?.querySelector('svg')
  if (diagram && svg) {
    const label = svg.getAttribute('aria-roledescription') ?? 'mermaid'
    lightbox.value = {
      open: true,
      src: svg.outerHTML,
      kind: 'svg',
      title: label === 'mermaid' ? '流程图' : label,
    }
    return true
  }
  const img = target.closest<HTMLImageElement>('img')
  if (img?.src) {
    lightbox.value = { open: true, src: img.currentSrc || img.src, kind: 'image', title: img.alt }
    return true
  }
  return false
}

/* ---------- 渲染 ---------- */

/**
 * 挂载一页里的全部 Vue 组件：frontmatter 声明式组件 + 插件结构化块。
 *
 * 两者共用一个 ComponentRegistry 与同一条卸载语义——分成两套容器管理，
 * 「切文档时漏掉一种」是必然会发生的错误。
 */
function mountAll(
  surface: HTMLElement,
  declaration: Record<string, Record<string, unknown>> | null,
): void {
  const missing: string[] = []
  const declarative = mountDeclarativeComponents(surface, declaration, registry, {
    onMissing: info => {
      missing.push(info.reason === 'no-data' ? `缺少数据：${info.key}` : `未注册组件：${info.kind}`)
    },
  })
  const pluginBlocks = mountPluginBlocks(surface, registry, {
    onMissing: info => emit('error', `插件组件未启用：${info.kind}`),
    onInvalid: info => emit('error', `::: ${info.syntax} 数据解析失败：${info.message}`),
  })
  if (missing.length) emit('error', missing.join('；'))

  mount = {
    dispose: () => {
      pluginBlocks.dispose()
      declarative.dispose()
    },
    get count() {
      return declarative.count + pluginBlocks.count
    },
  }
}

/** 主题变了要重渲染：mermaid 的深浅配色与块级组件配色都在渲染期决定 */
const themeTick = ref(0)

watch(
  () => props.docTheme,
  () => {
    themeTick.value += 1
    if (findQuery.value) void nextTick(() => runFind())
  },
)

watch(
  () => [props.doc, props.assetPrefix, props.sourceLines, themeTick.value] as const,
  async ([doc]) => {
    // 换文档前先卸载旧组件，避免 Vue 实例泄漏到新容器
    mount?.dispose()
    mount = null
    clearMatches()
    findRanges.value = []
    findIndex.value = 0

    if (!doc) {
      rendered.value = null
      emit('outline', [])
      return
    }

    const current = ++generation
    const result = renderMarkdown(doc.text, doc.path, {
      // 插件声明的容器语法（::: merged 之类）：渲染成占位块，挂载交给 mountPluginBlocks
      containerSyntax: plugins.syntax.map(item => ({
        name: item.name,
        component: item.component,
        form: item.form,
      })),
      // 容器版：站内链接要补仓库段（SPA 路由按 /<仓库>/<路径> 解析）
      ...(props.linkPrefix ? { urlPrefix: props.linkPrefix } : {}),
      // 图片前缀与链接前缀**分开**：桌面端的链接不带前缀，图片必须带资产协议前缀
      assetPrefix: props.assetPrefix,
      // 始终标注源行：切视图要按源行恢复位置（见 props.sourceLines 的说明）
      sourceLines: true,
    })
    rendered.value = result
    emit('outline', result.outline)
    if (result.error) emit('error', result.error)

    await nextTick()
    if (current !== generation) return

    const surface = host.value?.querySelector<HTMLElement>('.at-doc')
    if (!surface) return

    mountAll(surface, result.frontmatter.components ?? null)

    // 异步 pass：代际令牌失效则直接丢弃结果
    try {
      await highlightPass(surface)
      if (current !== generation) return
      await mermaidPass(surface, props.docTheme !== 'paper')
    } catch (error) {
      console.warn('[reader] 异步渲染失败', error)
    }
    if (current !== generation) return

    // 查找条开着时，新文档要重新算命中
    if (findQuery.value) runFind()
    emit('rendered', { path: doc.path, title: result.h1 ?? doc.path.split('/').pop() ?? doc.path })
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  generation += 1
  mount?.dispose()
  mount = null
  clearMatches()
})

/** 代码块复制：事件委托，避免给每个块单独绑监听 */
async function onContentClick(event: MouseEvent): Promise<void> {
  const target = event.target as HTMLElement | null
  const button = target?.closest<HTMLElement>('.at-copy')
  if (!button) {
    /*
     * 正文里的每个 `<a>` 都必须在这里接管，两种宿主都一样。
     *
     * 桌面端不接管的表现是「点一下正文里的链接，整个界面空掉」：窗口真的
     * 导航到了目标地址——SPA 的 DOM 与内存状态全没了，地址栏还不存在，
     * 用户只能重启应用。站内链接交给 App 走标签内导航，站外交给系统浏览器。
     *
     * 带修饰键的点击（Ctrl/⌘/Shift/中键）保持浏览器/平台默认语义，不拦。
     */
    const anchor = target?.closest<HTMLAnchorElement>('a[href]')
    if (!anchor) {
      // 图片 / mermaid 图：打开大图查看（缩放 + 拖拽）
      if (target && openViewer(target)) event.preventDefault()
      return
    }
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    const href = anchor.getAttribute('href') ?? ''
    if (!href || href.startsWith('#')) {
      // 纯锚点：交给浏览器原生滚动（标题锚点属于这一类，不该走宿主路由）
      return
    }
    event.preventDefault()
    if (/^(https?:|mailto:)/i.test(href)) {
      await window.docvi.appOpenExternal(href)
      return
    }
    // 站内绝对路径（容器版的分享链接形态）：交给 App 按 SPA 路由打开
    if (href.startsWith('/') && !href.startsWith('//')) {
      emit('navigate', href)
      return
    }
    /*
     * 其余形态（相对路径、`.md`、以及 `file:` 之类）：
     * 渲染管线已把站内链接归一成根相对路径，走到这里说明是作者写了非常规链接。
     * 明示而不是静默失败——静默会让人以为「链接没写对」，实际是宿主没支持。
     */
    emit('error', `无法在应用内打开该链接：${href}`)
    return
  }
  const wrapper = button.closest<HTMLElement>('[class*="language-"]')
  const code = wrapper?.querySelector('pre code')?.textContent ?? ''
  try {
    await navigator.clipboard.writeText(code)
    button.dataset.copied = '1'
    copiedLang.value = wrapper?.className.match(/language-([\w-]+)/)?.[1] ?? null
    window.setTimeout(() => delete button.dataset.copied, 1400)
  } catch {
    emit('error', '复制失败：剪贴板不可用')
  }
}

/* 供父组件控制（标签切换保位 / 大纲跳转 / 全局快捷键） */
defineExpose({
  host,
  openFind,
  getScroll: () => scroller.value?.scrollTop ?? 0,
  /**
   * 视口顶部所在的 0-based 源行（来自最近一个已滚过视口顶部的块）。
   *
   * 与 `getScroll()` 的区别：像素只在同一个视图里有意义，源行可以跨视图搬运。
   * 切到编辑态时用它作为落位锚点——这就是「切视图不该把我正在看的内容甩走」
   * 的实现口径：不看 scrollTop 的绝对值，看的是**正在看哪一段文字**。
   */
  getTopLine: (): number => {
    const el = scroller.value
    const surface = host.value?.querySelector<HTMLElement>('.at-doc')
    if (!el || !surface) return 0
    const blocks = Array.from(surface.querySelectorAll<HTMLElement>('[data-source-line]'))
    if (!blocks.length) return 0
    const viewportTop = el.getBoundingClientRect().top
    let line = 0
    for (const block of blocks) {
      const value = Number(block.dataset.sourceLine)
      if (!Number.isFinite(value)) continue
      // 块的下沿还在视口上方 → 它已经完全滚过去了，取它的起始行
      if (block.getBoundingClientRect().bottom <= viewportTop + 1) line = value
      else break
    }
    return line
  },
  restoreScroll: (y: number) => {
    if (scroller.value) scroller.value.scrollTop = y
  },
  /**
   * 按比例滚动（0–1）：分屏时左侧源码滚到哪，右侧就滚到对应的相对位置。
   *
   * 用比例而不是像素：两侧内容高度差很大（源码里一个块可能只有一行，
   * 渲染后是几十行表格），像素对齐会让两边越滚越偏。
   */
  scrollToRatio: (ratio: number) => {
    const el = scroller.value
    if (!el) return
    const range = el.scrollHeight - el.clientHeight
    if (range <= 0) return
    el.scrollTop = Math.max(0, Math.min(1, ratio)) * range
  },
  /**
   * 按源行滚动：找「起始行 ≤ 目标行」的最后一个块，把它对到视口顶部。
   *
   * 这是分屏同步的主通道（比 scrollToRatio 精确）：两侧内容高度比例不同，
   * 百分比同步会随文档变长越滚越偏；源行是结构上唯一稳定的坐标系。
   * 目标行落在第一个块之前时回到顶部；返回 false 表示没有源行信息可用。
   */
  scrollToSourceLine: (line: number): boolean => {
    const el = scroller.value
    const surface = host.value?.querySelector<HTMLElement>('.at-doc')
    if (!el || !surface) return false
    const blocks = Array.from(surface.querySelectorAll<HTMLElement>('[data-source-line]'))
    if (!blocks.length) return false
    let target: HTMLElement | null = null
    let targetLine = -1
    for (const block of blocks) {
      const value = Number(block.dataset.sourceLine)
      if (!Number.isFinite(value) || value > line) continue
      // 同一行可能有嵌套块（列表容器与列表项）：取最内层，位置更贴近那行文字
      if (value >= targetLine) {
        target = block
        targetLine = value
      }
    }
    if (!target) {
      el.scrollTop = 0
      return true
    }
    const top = target.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop
    el.scrollTop = Math.max(0, top)
    return true
  },
  scrollTo: (selector: string) => {
    const target = host.value?.querySelector<HTMLElement>(selector)
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  },
})
</script>

<template>
  <!--
    查找条必须放在滚动容器**外面**。
    放在里面（原先写在 article 之后）时，sticky 的自然位置在文档末尾，
    表现是浮层贴到右下角、聚焦输入框还会把整篇文档滚到底。
  -->
  <div class="reader-host">
    <div ref="scroller" class="reader doc-surface">
      <div v-if="!doc" class="reader__empty">
        <FileText :size="28" :stroke-width="1.4" aria-hidden="true" />
        <p class="reader__empty-title">{{ t('empty.reader.title') }}</p>
        <p class="reader__empty-hint">{{ t('empty.reader.hint') }}</p>
        <p v-if="showTreeHint" class="reader__empty-hint">{{ t('file.outsideHint') }}</p>
        <button
          v-if="!isReadOnlyHost"
          class="reader__empty-action"
          type="button"
          @click="emit('pickFile')"
        >
          {{ t('empty.reader.open') }}
        </button>
      </div>

      <article v-else ref="host" class="reader__page" @click="onContentClick">
        <!--
          元信息（路径 / 字数 / 阅读时长 / 体积）放在正文**之前**：
          读者打开一篇长文档前就该知道要花多久，而不是滚到最底部才看到。
          文末不再重复一遍。
        -->
        <div class="reader__meta">
          <nav class="reader__crumb" aria-label="文档路径">
            <span v-for="(seg, i) in breadcrumb" :key="i" class="reader__crumb-item">
              {{ seg }}
            </span>
          </nav>
          <span class="reader__meta-right">
            <span class="reader__stats">
              {{ wordCount }} 字 · 约 {{ readingMinutes }} 分钟 ·
              {{ (doc.size / 1024).toFixed(1) }} KB
            </span>
            <button
              v-if="!isReadOnlyHost"
              v-tooltip="t('reader.share')"
              class="reader__share"
              type="button"
              :aria-label="t('reader.share')"
              @click="emit('share')"
            >
              <Share2 :size="13" :stroke-width="1.8" />
            </button>
          </span>
        </div>

        <div v-if="rendered?.error" class="reader__warn">
          <AlertTriangle :size="14" :stroke-width="1.8" />
          <span>{{ rendered.error }}</span>
        </div>

        <!-- eslint-disable-next-line vue/no-v-html -- 内容来自本地 Markdown 管线，非用户输入 -->
        <div class="at-doc" v-html="rendered?.html" />

        <footer v-if="copiedLang" class="reader__meta reader__meta--foot">
          <span class="reader__copied">已复制 {{ copiedLang }}</span>
        </footer>
      </article>
    </div>

    <!-- 画布右上角浮层：不参与滚动、不占文档高度 -->
    <div v-if="findOpen" class="findbar">
      <Search :size="13" :stroke-width="1.8" class="findbar__icon" />
      <input
        ref="findInput"
        v-model="findQuery"
        class="findbar__input"
        type="text"
        placeholder="在文档中查找"
        autocomplete="off"
        spellcheck="false"
        @keydown.enter.exact.prevent="step(1)"
        @keydown.shift.enter.prevent="step(-1)"
        @keydown.esc.prevent="closeFind"
      />
      <span class="findbar__count">
        {{ findCount ? `${findIndex + 1} / ${findCount}` : findQuery ? '无结果' : '' }}
      </span>
      <button
        class="findbar__btn"
        type="button"
        aria-label="上一个"
        :disabled="!findCount"
        @click="step(-1)"
      >
        <ChevronUp :size="14" :stroke-width="2" />
      </button>
      <button
        class="findbar__btn"
        type="button"
        aria-label="下一个"
        :disabled="!findCount"
        @click="step(1)"
      >
        <ChevronDown :size="14" :stroke-width="2" />
      </button>
      <button class="findbar__btn" type="button" aria-label="关闭查找" @click="closeFind">
        <X :size="14" :stroke-width="2" />
      </button>
    </div>

    <!-- 大图查看：图片与 mermaid 图共用（缩放 + 拖拽 + Esc 关闭） -->
    <ImageLightbox
      :open="lightbox.open"
      :src="lightbox.src"
      :kind="lightbox.kind"
      :title="lightbox.title"
      :downloadable="lightbox.kind === 'svg'"
      @close="lightbox.open = false"
    />
  </div>
</template>

<style scoped>
/* 画布容器：只负责给查找条提供定位基准，本身不滚动 */
.reader-host {
  position: relative;
  height: 100%;
  min-height: 0;
}

.reader {
  height: 100%;
  overflow-y: auto;
  overscroll-behavior: contain;
  background: var(--dv-doc-bg, var(--dv-ui-bg));
}

.reader__empty {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 0 24px;
  text-align: center;
  color: var(--dv-ui-text-dim);
  font-size: 12.5px;
}

.reader__empty p {
  margin: 0;
}

.reader__empty-title {
  font-size: 13.5px;
  color: var(--dv-ui-text-2);
}

.reader__empty-hint {
  max-width: 340px;
  line-height: 1.65;
}

.reader__empty-hint kbd {
  padding: 1px 4px;
  border: 1px solid var(--dv-ui-line);
  border-bottom-width: 2px;
  border-radius: 3px;
  background: var(--dv-ui-surface-2);
  font-family: var(--dv-ed-font, ui-monospace, monospace);
  font-size: 10.5px;
  color: var(--dv-ui-text-muted);
}

.reader__empty-action {
  margin-top: 6px;
  height: 30px;
  padding: 0 14px;
  border: 1px solid var(--dv-ui-line-soft);
  border-radius: var(--dv-ui-radius-sm);
  background: var(--dv-ui-surface-2);
  color: var(--dv-ui-text-2);
  font-size: 12px;
  cursor: pointer;
}

.reader__empty-action:hover {
  background: var(--dv-ui-surface-3);
  color: var(--dv-ui-text);
}

/*
 * 内容宽度跟随全局开关：`--dv-content-max` 在 tokens.css 里按
 * html[data-content-width] 切换（full = none，measure = 可读行宽）。
 *
 * ⚠️ 不要在这里写 `:global(html[...]) .reader__page`：Vue scoped CSS 要求
 * `:global()` 包裹**整条**选择器，写成「全局祖先 + 局部后代」会被编译成
 * 只对 html 生效——实测给 <html> 加了 40px padding，整个窗口缩成 604px。
 */
.reader__page {
  max-width: var(--dv-content-max, none);
  margin: 0 auto;
  padding: 40px 32px 96px;
}

/*
 * 元信息条：路径在左、字数/时长/体积在右，同一条基线。
 * 窄屏放不下时换行，路径仍在上、统计在下。
 */
.reader__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 6px 16px;
  margin-bottom: 22px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--dv-doc-border);
  font-size: 11.5px;
  color: var(--dv-doc-text-muted);
}

.reader__meta--foot {
  justify-content: flex-start;
  margin-top: 32px;
  margin-bottom: 0;
  padding-bottom: 0;
  border-bottom: none;
  border-top: 1px solid var(--dv-doc-border);
  padding-top: 14px;
}

.reader__crumb {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
}

.reader__crumb-item + .reader__crumb-item::before {
  content: '/';
  margin-right: 6px;
  opacity: 0.5;
}

.reader__stats {
  flex: none;
  font-variant-numeric: tabular-nums;
}

/* 元信息右端：字数统计 + 分享按钮。分享是可选动作，默认低对比，不抢正文注意力 */
.reader__meta-right {
  display: inline-flex;
  align-items: center;
  gap: 10px;
}

/*
 * ⚠️ 必须用 flex 居中，并让图标 display:block。
 *
 * 原先是 `display: grid; place-items: center`：lucide 图标是**行内**元素，
 * 放进网格轨道会被行盒撑高（实测行高 18.67px，而图标自身 13px），于是图标
 * 被挤得偏右 2px 多，视觉上就是「歪了」。去掉行盒、改用 flex 居中，
 * 水平与垂直留白才会严格相等。
 */
.reader__share {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  width: 22px;
  height: 22px;
  border: 1px solid transparent;
  border-radius: var(--dv-radius-sm);
  background: transparent;
  color: var(--dv-doc-text-muted);
  cursor: pointer;
  transition:
    background var(--dv-dur-1) var(--dv-ease),
    color var(--dv-dur-1) var(--dv-ease),
    border-color var(--dv-dur-1) var(--dv-ease);
}

.reader__share > svg {
  display: block;
}

.reader__share:hover {
  border-color: var(--dv-doc-border);
  background: color-mix(in srgb, var(--dv-doc-text-muted) 10%, transparent);
  color: var(--dv-doc-text);
}

.reader__warn {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 16px;
  padding: 9px 12px;
  border: 1px solid color-mix(in srgb, var(--dv-doc-danger) 30%, transparent);
  border-radius: var(--dv-radius-sm);
  background: color-mix(in srgb, var(--dv-doc-danger) 8%, transparent);
  color: var(--dv-doc-danger);
  font-size: 12.5px;
}

.reader__copied {
  color: var(--dv-doc-ok);
}

.findbar {
  position: absolute;
  top: 10px;
  right: 18px;
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 7px 5px 10px;
  border: 1px solid var(--dv-ui-line);
  border-radius: var(--dv-ui-radius-sm);
  background: var(--dv-ui-surface-2);
  box-shadow: var(--dv-ui-shadow-2);
}

.findbar__icon {
  color: var(--dv-ui-text-dim);
}

.findbar__input {
  width: 190px;
  border: none;
  background: transparent;
  color: var(--dv-ui-text);
  font-size: 12.5px;
  outline: none;
}

.findbar__count {
  min-width: 54px;
  text-align: right;
  font-size: 11px;
  color: var(--dv-ui-text-dim);
  font-variant-numeric: tabular-nums;
}

.findbar__btn {
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--dv-ui-text-muted);
  cursor: pointer;
}

.findbar__btn:hover:not(:disabled) {
  background: var(--dv-ui-surface-3);
  color: var(--dv-ui-text);
}

.findbar__btn:disabled {
  opacity: 0.35;
  cursor: default;
}
</style>
