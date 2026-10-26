<script setup lang="ts">
/**
 * HtmlEmbed —— 单文件 HTML 图解的内嵌渲染。
 *
 * 借鉴 show-me skill 的「HTML 图解」视图：当 Mermaid 表达不了
 * （多面板布局、状态对比、需要交互的概念图）时，允许内容作者手写一个
 * 自包含 HTML 文件（内联 CSS/JS，零外部请求），用本组件内嵌进课程页。
 *
 * 两种用法，按文件大小选：
 *
 * 1. 小图解（几十 KB 以内）——内联，随页面一起下载：
 *    ```
 *    import demo from './snippets/demo.html?raw'
 *    <HtmlEmbed title="声环六模板同屏对比" :html="demo" height="520px" />
 *    ```
 *
 * 2. 大图解（数百 KB，如含 PixiJS 构建产物）——静态托管 + 按需拉取：
 *    HTML 放进本课程的 `assets/`（该目录不进目录树），在内容根 `docs.config.yaml`
 *    的 `staticDirs` 声明它，然后按站点绝对路径引用：
 *    ```
 *    <HtmlEmbed title="实时演示" src="/技术教程/xxx/assets/demo.html" height="420px" />
 *    ```
 *    这种方式不产生模块预取（动态 import 会被浏览器 preload，只省渲染不省下载），
 *    真正滚动到视口才发一次请求。
 *
 * 触发方式：进入视口自动加载，也可点击占位上的按钮立即加载（IntersectionObserver
 * 在部分嵌入/无合成环境下不回调，必须有手动入口，否则图解会一直停在占位）。
 *
 * 安全边界：iframe 带 sandbox="allow-scripts"（无 allow-same-origin）——
 * 图解可以带交互脚本，但读不到课程页 DOM/存储，也拿不到父源身份。
 * 「新窗口打开」三宿主三路径（见 openInNewWindow）：桌面端走 Rust 命令开系统浏览器
 * （webview 内 window.open 被 wry 静默取消）、Web 走 Blob URL 新窗口、被拦截时
 * 页内覆盖层兜底——三种路径都零外部请求。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

interface Props {
  /** 自包含 HTML 明文（小文件：`import html from './snippets/xx.html?raw'`） */
  html?: string
  /** 静态托管的站点绝对路径（大文件：内容根 staticDirs 声明的目录下） */
  src?: string
  /** 图解标题（缺省显示「HTML 图解」） */
  title?: string
  /** 内嵌高度（任意 CSS 高度值，默认 460px） */
  height?: string
  /** 出处徽标文案（可选） */
  source?: string
}

const props = withDefaults(defineProps<Props>(), {
  html: '',
  src: '',
  title: '',
  height: '460px',
  source: '',
})

const fetchedHtml = ref('')
const loading = ref(false)
const loadError = ref('')
const opened = ref(false)
const hostRef = ref<HTMLElement | null>(null)

/** 页内覆盖层兜底（宿主拦截新窗口时）：整体放大查看，Esc / 按钮关闭 */
const overlay = ref(false)
const overlayNote = ref('')
const overlayUrl = ref('')

/** 内联模式直接有内容；src 模式要等拉取完成 */
const resolvedHtml = computed(() => props.html || fetchedHtml.value)

/** 内联走 srcdoc（内容随页面到），src 模式拉取后转 Blob（不进模块图、不预取） */
const frameSrcdoc = computed(() => (props.src ? undefined : props.html || undefined))
const blobUrl = ref('')
const frameSrc = computed(() => blobUrl.value || undefined)

/** 是否需要（且尚未）拉取外部文件 */
const needsFetch = computed(() => Boolean(props.src) && !fetchedHtml.value)

async function ensureLoaded() {
  if (!props.src || fetchedHtml.value || loading.value) return
  loading.value = true
  try {
    // 路径含中文/空格时浏览器不会自动编码，这里统一编码后再请求
    const response = await fetch(encodeURI(props.src))
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    fetchedHtml.value = await response.text()
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : String(error)
  } finally {
    loading.value = false
  }
}

// 拉取成功后把内容交给 sandbox iframe（Blob 比 srcdoc 少一次 HTML 序列化）
let stopWatch: (() => void) | null = null
let observer: IntersectionObserver | null = null

onMounted(() => {
  window.addEventListener('keydown', onOverlayKeydown)
  if (!props.src) return
  // watch 而非直接 await：内容到达后才创建 Blob URL，避免空 iframe 先渲染一帧
  stopWatch = watch(fetchedHtml, html => {
    if (html && !blobUrl.value) {
      blobUrl.value = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }))
    }
  })

  const host = hostRef.value
  if (!host || typeof IntersectionObserver === 'undefined') {
    void ensureLoaded()
    return
  }
  observer = new IntersectionObserver(
    entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        observer?.disconnect()
        observer = null
        void ensureLoaded()
      }
    },
    { rootMargin: '300px' },
  )
  observer.observe(host)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onOverlayKeydown)
  observer?.disconnect()
  stopWatch?.()
  if (blobUrl.value) URL.revokeObjectURL(blobUrl.value)
  if (overlayUrl.value) URL.revokeObjectURL(overlayUrl.value)
})

/**
 * 新窗口打开 —— 三种宿主三种路径，全部零外部请求、必有可见反馈：
 *
 * 1. Tauri 桌面端：webview 内 window.open 由 wry 静默取消（未注册 on_new_window
 *    处理器时对 NewWindowRequested 一律 SetHandled(true)，见 wry webview2/mod.rs），
 *    唯一可靠路径是 Rust 命令 `open_diagram_in_browser`——写临时文件 + 系统浏览器打开；
 * 2. Web 宿主（HTTP/单文件 viewer）：Blob URL + window.open 开新窗口。注意两点：
 *    a. 不用 'noopener' 特性串（noopener 会让返回值恒为 null，无法区分「打开成功」
 *       与「被拦截」），改为打开后立即切断 opener（同步设 null，无窗口期）；
 *    b. window.open 必须在用户激活的程序化调用链里同步执行——内容尚未拉取时先开
 *       空白窗保住激活，加载完成后再把空白窗导航到 Blob URL；
 * 3. 被弹窗拦截器/嵌入宿主吞掉（返回 null / 空白窗被关）：页内覆盖层兜底，
 *    把图解放大到整个视口查看。
 */
function flashOpened() {
  opened.value = true
  window.setTimeout(() => {
    opened.value = false
  }, 2500)
}

function makeBlobUrl(html: string): string {
  return URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }))
}

function closeOverlay() {
  overlay.value = false
  if (overlayUrl.value) {
    URL.revokeObjectURL(overlayUrl.value)
    overlayUrl.value = ''
  }
}

function openOverlay(note: string) {
  if (overlayUrl.value) URL.revokeObjectURL(overlayUrl.value)
  const html = resolvedHtml.value
  overlayUrl.value = html ? makeBlobUrl(html) : ''
  overlayNote.value = note
  overlay.value = true
}

function onOverlayKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && overlay.value) closeOverlay()
}

async function openInNewWindow() {
  if (typeof window === 'undefined') return

  // 路径 1：桌面 app（Electron）。window.open 会被 setWindowOpenHandler 拦成系统浏览器
  // 打一个 about:blank，拿不到自包含 HTML，所以必须走宿主命令把页面落盘再交给系统浏览器。
  // 类型在此就地断言：宿主桥的全局声明属于壳包，组件包不依赖壳的类型。
  const bridge = (
    window as unknown as {
      docsStudioHost?: {
        kind: string
        invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>
      }
    }
  ).docsStudioHost
  if (bridge?.kind === 'electron') {
    await ensureLoaded()
    const html = resolvedHtml.value
    if (!html) return
    try {
      await bridge.invoke('open_diagram_in_browser', { html, name: props.title || 'diagram' })
      flashOpened()
    } catch {
      // 命令失败（宿主版本过旧等）→ 落到覆盖层
      openOverlay('无法唤起系统浏览器，已改为页内放大查看')
    }
    return
  }

  // 路径 2：Web 宿主。window.open 同步执行保住用户激活（异步前置会丢激活导致被拦）
  const readyHtml = resolvedHtml.value
  const readyUrl = readyHtml ? makeBlobUrl(readyHtml) : ''
  const win = window.open(readyUrl || '', '_blank')
  if (!win) {
    if (readyUrl) URL.revokeObjectURL(readyUrl)
    // 被拦：补加载后落到覆盖层兜底
    await ensureLoaded()
    if (resolvedHtml.value) openOverlay('当前环境拦截了新窗口，已改为页内放大查看')
    return
  }
  try {
    win.opener = null
  } catch {
    /* 个别宿主 opener 不可写，忽略 */
  }

  if (readyUrl) {
    // 新窗口已带着内容打开；延迟回收 Blob URL（立即回收会打断其异步加载）
    window.setTimeout(() => URL.revokeObjectURL(readyUrl), 30_000)
    flashOpened()
    return
  }

  // 空白窗填充：等图解内容拉取完成再导航（加载失败则关掉空白窗，页面占位已显示错误）
  await ensureLoaded()
  const html = resolvedHtml.value
  if (!html) {
    win.close()
    return
  }
  if (win.closed) {
    // 宿主假装返回了窗口、或用户抢先关掉：落到覆盖层
    openOverlay('新窗口未能打开，已改为页内放大查看')
    return
  }
  const url = makeBlobUrl(html)
  try {
    win.location.replace(url)
  } catch {
    URL.revokeObjectURL(url)
    openOverlay('新窗口未能打开，已改为页内放大查看')
    return
  }
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
  flashOpened()
}
</script>

<template>
  <figure ref="hostRef" class="at-htmlembed">
    <header class="at-htmlembed__head">
      <span class="at-htmlembed__title">{{ title || 'HTML 图解' }}</span>
      <span v-if="source" class="at-htmlembed__src">{{ source }}</span>
      <button
        type="button"
        class="at-htmlembed__open"
        aria-label="在新窗口打开图解"
        @click="openInNewWindow"
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
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
          <path d="M15 3h6v6" />
          <path d="M10 14 21 3" />
        </svg>
        {{ opened ? '已打开' : '新窗口打开' }}
      </button>
    </header>

    <p v-if="loadError" class="at-htmlembed__state at-htmlembed__state--error">
      图解加载失败：{{ loadError }}
    </p>

    <div v-else-if="needsFetch" class="at-htmlembed__state">
      <span>{{ loading ? '正在加载图解…' : '滚动到此处自动加载' }}</span>
      <button v-if="!loading" type="button" class="at-htmlembed__trigger" @click="ensureLoaded">
        立即加载
      </button>
    </div>

    <iframe
      v-else
      class="at-htmlembed__frame"
      :style="{ height }"
      :srcdoc="frameSrcdoc"
      :src="frameSrc"
      sandbox="allow-scripts"
      loading="lazy"
      :title="title || 'HTML 图解'"
    />

    <!-- 新窗口被宿主拦截时的页内兜底：铺满视口放大查看，Esc 或按钮关闭 -->
    <Teleport to="body">
      <div
        v-if="overlay"
        class="at-htmlembed-overlay"
        role="dialog"
        :aria-label="title || 'HTML 图解'"
      >
        <header class="at-htmlembed-overlay__head">
          <span class="at-htmlembed-overlay__title">{{ title || 'HTML 图解' }}</span>
          <span class="at-htmlembed-overlay__note">{{ overlayNote }}</span>
          <button
            type="button"
            class="at-htmlembed-overlay__close"
            aria-label="关闭放大查看"
            @click="closeOverlay"
          >
            关闭 ✕
          </button>
        </header>
        <iframe
          v-if="overlayUrl"
          class="at-htmlembed-overlay__frame"
          :src="overlayUrl"
          sandbox="allow-scripts"
          :title="(title || 'HTML 图解') + '（放大查看）'"
        />
      </div>
    </Teleport>
  </figure>
</template>

<style scoped>
.at-htmlembed {
  margin: 1rem 0;
  border: 1px solid var(--at-border);
  border-radius: var(--at-radius-lg);
  overflow: hidden;
  background: var(--at-surface);
}

.at-htmlembed__head {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  padding: 0.5rem 0.9rem;
  border-bottom: 1px solid var(--at-border);
}

.at-htmlembed__title {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--at-text-muted);
  letter-spacing: 0.02em;
  margin-right: auto;
}

.at-htmlembed__src {
  color: var(--at-text-muted);
  font-size: 0.78rem;
}

.at-htmlembed__open,
.at-htmlembed__trigger {
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

.at-htmlembed__open:hover,
.at-htmlembed__trigger:hover {
  border-color: var(--at-accent);
  color: var(--at-accent);
}

.at-htmlembed__frame {
  display: block;
  width: 100%;
  border: 0;
  background: var(--at-code-bg);
}

/* 按需加载占位：给宿主一个最小高度，IntersectionObserver 才有可靠的可观察区域 */
.at-htmlembed__state {
  margin: 0;
  padding: 0.9rem;
  min-height: 4.5rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  color: var(--at-text-muted);
  font-size: 0.82rem;
  background: var(--at-code-bg);
}

.at-htmlembed__state--error {
  color: var(--at-danger, #e5484d);
}

/* 覆盖层（Teleport 到 body，不受组件裁剪；scoped 样式因 Teleport 仍跟随组件 hash） */
.at-htmlembed-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  flex-direction: column;
  background: var(--at-bg);
  box-shadow: var(--at-shadow);
}

.at-htmlembed-overlay__head {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  padding: 0.5rem 0.9rem;
  border-bottom: 1px solid var(--at-border);
  flex: none;
}

.at-htmlembed-overlay__title {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--at-text-muted);
  letter-spacing: 0.02em;
}

.at-htmlembed-overlay__note {
  margin-right: auto;
  font-size: 0.78rem;
  color: var(--at-text-muted);
}

.at-htmlembed-overlay__close {
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

.at-htmlembed-overlay__close:hover {
  border-color: var(--at-accent);
  color: var(--at-accent);
}

.at-htmlembed-overlay__frame {
  display: block;
  flex: 1 1 auto;
  min-height: 0;
  width: 100%;
  border: 0;
  background: var(--at-code-bg);
}
</style>
