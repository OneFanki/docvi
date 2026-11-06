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
 * ══ 为什么图解要经「沙箱宿主页」中转，而不是直接 srcdoc / Blob ══
 *
 * 应用入口页带 `meta CSP`（`script-src 'self'`），而 **srcdoc / data: / blob:
 * 子帧会继承创建者的策略**（Electron 实测：三者都会，只有独立文档不会）。
 * 图解的内联 `<script>` 因此被整片拦掉，页面只剩静态骨架——图表全空。
 *
 * 修法不是放宽应用 CSP（那会把整个应用的内联脚本策略打开），而是把图解交给
 * 一个**独立文档**承载：`embed-sandbox.html`（渲染层 public，自带
 * `default-src 'none'; script-src 'unsafe-inline'`），它再把 HTML 塞进自己的
 * 二级 `sandbox="allow-scripts"` iframe。图解脚本能跑，且读不到应用页的
 * DOM / 存储 / 身份——安全边界与原先的 srcdoc 方案完全一致。
 *
 * 三种呈现共用一个投递协议：宿主按一次性 token 重试投递 `html`，沙箱页回执
 * `mounted`。用「重试 + 回执」而不是「沙箱页宣告就绪」，是因为新窗口态下宿主
 * 会立刻切断 `opener`（窗口互访本就是攻击面），沙箱页拿不到 opener 就发不出
 * 就绪通知，而回执走 `event.source`，天然不依赖 opener。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

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

/** 沙箱页与宿主之间的投递通道名（两端写死同一串，改一处必须改两处） */
const CHANNEL = 'docvi-html-embed'
/** 每次投递的重试窗口：超时说明沙箱页没起来（站点未部署该文件 / 被拦） */
const DELIVERY_TIMEOUT = 8000
/** 重试间隔：既要不漏掉沙箱页安装监听的时刻，也要避免把消息风暴打进队列 */
const RETRY_INTERVAL = 150

const fetchedHtml = ref('')
const loading = ref(false)
const loadError = ref('')
const opened = ref(false)
const hostRef = ref<HTMLElement | null>(null)
/** 图解宿主页始终没回执（多半是站点没部署 embed-sandbox.html） */
const sandboxError = ref('')

/** 页内覆盖层兜底（宿主拦截新窗口时）：整体放大查看，Esc / 按钮关闭 */
const overlay = ref(false)
const overlayNote = ref('')

/** 内联模式直接有内容；src 模式要等拉取完成 */
const resolvedHtml = computed(() => props.html || fetchedHtml.value)

/** 是否需要（且尚未）拉取外部文件 */
const needsFetch = computed(() => Boolean(props.src) && !fetchedHtml.value)

/** 不用 crypto.randomUUID：容器站点常以 http://<内网 IP> 提供，非安全上下文拿不到 */
function randomToken(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** 沙箱页地址：站点根下的固定文件，带一次性 token 防止不同实例串话 */
function sandboxUrl(token: string): string {
  const base = new URL('/embed-sandbox.html', window.location.href)
  base.searchParams.set('t', token)
  return base.href
}

const inlineToken = ref(randomToken())
const inlineFrame = ref<HTMLIFrameElement | null>(null)
const overlayToken = ref('')
const overlayFrame = ref<HTMLIFrameElement | null>(null)
const overlaySrc = computed(() => (overlayToken.value ? sandboxUrl(overlayToken.value) : ''))

/* ---------- 投递机制：重试发送 + 等回执 ---------- */

type DeliveryKey = 'inline' | 'overlay' | 'popup'

interface Delivery {
  token: string
  /** 每次尝试时重新取目标：窗口/iframe 可能在过程中被替换或关闭 */
  target: () => Window | null
  timer: number | null
  /** 第一次成功投递的时间；内容还没到时不计时 */
  startedAt: number
  onTimeout: () => void
}

const deliveries = new Map<DeliveryKey, Delivery>()
/** 已被回执确认的投递：重试停止，后续 iframe load 不再重复投递 */
const settled = new Set<DeliveryKey>()

function stopDelivery(key: DeliveryKey): void {
  const entry = deliveries.get(key)
  if (!entry) return
  if (entry.timer !== null) window.clearTimeout(entry.timer)
  deliveries.delete(key)
}

function stopAllDeliveries(): void {
  for (const key of Array.from(deliveries.keys())) stopDelivery(key)
}

/**
 * 开始向某个沙箱页投递图解内容（内容 / 目标谁先到都等），直到收到回执或超时。
 *
 * 一个循环包住三种等待，避免「内容未到先起循环、内容到了再重启循环」那种
 * 需要额外同步的状态机：
 * - 内容未就绪（src 模式还在 fetch）→ 静默等待，**不计时**，否则大文件会在
 *   下载途中被判超时；
 * - 目标窗口还没出现 → 同样静默等待；
 * - 两者都在 → 每 RETRY_INTERVAL 重投一次 `html`，等沙箱页回执 `mounted`。
 *   不用「就绪握手」是因为新窗口态下 opener 已被切断，沙箱页发不出通知。
 */
function startDelivery(
  key: DeliveryKey,
  token: string,
  target: () => Window | null,
  onTimeout: () => void,
): void {
  stopDelivery(key)
  settled.delete(key)
  const entry: Delivery = { token, target, timer: null, startedAt: 0, onTimeout }
  deliveries.set(key, entry)

  const tick = (): void => {
    // 被替换 / 停止 / 已回执：静默退出循环
    if (deliveries.get(key) !== entry) return
    if (loadError.value) {
      stopDelivery(key)
      return
    }
    const html = resolvedHtml.value
    const win = entry.target()
    if (html && win) {
      if (!entry.startedAt) entry.startedAt = Date.now()
      win.postMessage(
        {
          channel: CHANNEL,
          token,
          type: 'html',
          html,
          title: props.title || 'HTML 图解',
        },
        '*',
      )
      if (Date.now() - entry.startedAt > DELIVERY_TIMEOUT) {
        stopDelivery(key)
        onTimeout()
        return
      }
    }
    entry.timer = window.setTimeout(tick, RETRY_INTERVAL)
  }
  tick()
}

function handleMessage(event: MessageEvent): void {
  const data = event.data as { channel?: string; token?: string; type?: string } | null | undefined
  if (!data || data.channel !== CHANNEL || data.type !== 'mounted') return

  for (const [key, entry] of deliveries) {
    if (data.token !== entry.token) continue
    // 只认自己的目标窗口：token 已经够独特，多一道身份校验不吃亏
    const win = entry.target()
    if (event.source && win && event.source !== win) continue
    stopDelivery(key)
    settled.add(key)
    if (key === 'popup') flashOpened()
    if (key === 'inline') sandboxError.value = ''
    if (key === 'overlay') overlayNote.value = ''
    return
  }
}

async function ensureLoaded(): Promise<void> {
  if (!props.src || fetchedHtml.value || loading.value) return
  loading.value = true
  try {
    // 路径含中文/空格时浏览器不会自动编码，这里统一编码后再请求
    const response = await fetch(encodeURI(props.src))
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    fetchedHtml.value = await response.text()
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    /*
     * 桌面端的 src 由渲染管线改写成 `docvi://asset/<工作区>/…`。仍报 Failed to
     * fetch 时几乎总是同一类原因：该目录没在内容根的 `docs.config.yaml` 里被
     * 服务端放行（容器端）或工作区没登记（桌面端）。把这条线索直接给出来，
     * 比让作者面对一句 "Failed to fetch" 自己猜要省事。
     */
    loadError.value = detail.includes('Failed to fetch')
      ? `无法读取 ${props.src}——请确认该文件在内容根内、且所在目录已声明进 docs.config.yaml 的 staticDirs`
      : detail
  } finally {
    loading.value = false
  }
}

/**
 * 内嵌 iframe 的 load 时机 —— 投递起点。
 *
 * 为什么不在组件挂载时就开始投递：iframe 带 `loading="lazy"`，正文下方的图解
 * 在滚动到附近之前根本不会加载，提前计时必然误报「宿主页未就绪」。
 * src 模式同理：内容可能还在下载，投递循环会先静默等内容再开始计时。
 */
function onInlineLoad(): void {
  sandboxError.value = ''
  if (settled.has('inline')) return
  startDelivery(
    'inline',
    inlineToken.value,
    () => inlineFrame.value?.contentWindow ?? null,
    () => {
      sandboxError.value = '图解宿主页未响应：请确认站点已部署 embed-sandbox.html'
    },
  )
}

function onOverlayLoad(): void {
  if (settled.has('overlay')) return
  startDelivery(
    'overlay',
    overlayToken.value,
    () => overlayFrame.value?.contentWindow ?? null,
    () => {
      overlayNote.value = '图解宿主页未响应：请确认站点已部署 embed-sandbox.html'
    },
  )
}

let observer: IntersectionObserver | null = null

onMounted(() => {
  window.addEventListener('keydown', onOverlayKeydown)
  window.addEventListener('message', handleMessage)

  if (!props.src) return
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
  window.removeEventListener('message', handleMessage)
  observer?.disconnect()
  stopAllDeliveries()
})

/* ---------- 新窗口 ---------- */

let popupTarget: Window | null = null
let popupToken = ''

/**
 * 新窗口打开。
 *
 * 两条路径 + 一条兜底：
 * 1. Electron：`window.open` 被 `setWindowOpenHandler` 接管，沙箱页按精确路径
 *    白名单放行成应用内独立窗口（它跑在 `docvi://` 下，系统浏览器打不开）；
 * 2. Web 宿主：`window.open` 直接浏览器新标签。不用 'noopener' 特性串——
 *    noopener 让返回值恒为 null，无法区分「打开成功」与「被拦截」；
 *    打开成功后同步切断 opener（子窗口回执走 `event.source`，不依赖它）；
 * 3. 被弹窗拦截器 / 宿主吞掉（返回 null、窗口被关、迟迟不回执）：页内覆盖层兜底。
 */
function flashOpened() {
  opened.value = true
  window.setTimeout(() => {
    opened.value = false
  }, 2500)
}

async function openInNewWindow() {
  if (typeof window === 'undefined') return

  popupToken = randomToken()
  // window.open 必须同步执行保住用户激活（异步前置会丢激活导致被拦）
  const win = window.open(sandboxUrl(popupToken), '_blank')
  if (!win) {
    // 被拦：补加载后落到覆盖层兜底
    await ensureLoaded()
    if (resolvedHtml.value) openOverlay('当前环境拦截了新窗口，已改为页内放大查看')
    return
  }
  popupTarget = win
  try {
    // 与原先一致：不给子窗口留反向操作本页的入口。回执不依赖 opener。
    win.opener = null
  } catch {
    /* 个别宿主 opener 不可写，忽略 */
  }

  await ensureLoaded()
  if (!resolvedHtml.value) {
    // 内容拉取失败：占位已显示错误，关掉空白窗口
    try {
      win.close()
    } catch {
      /* 已关闭 */
    }
    popupTarget = null
    return
  }

  startDelivery(
    'popup',
    popupToken,
    () => (popupTarget && !popupTarget.closed ? popupTarget : null),
    () => {
      // 宿主不认这个地址 / 窗口被吞：别留一块空白，改页内放大
      popupTarget = null
      openOverlay('新窗口未能打开，已改为页内放大查看')
    },
  )
}

/* ---------- 覆盖层 ---------- */

function closeOverlay() {
  overlay.value = false
  overlayToken.value = ''
  stopDelivery('overlay')
  settled.delete('overlay')
}

function openOverlay(note: string) {
  overlayNote.value = note
  overlayToken.value = randomToken()
  overlay.value = true
}

function onOverlayKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && overlay.value) closeOverlay()
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

    <p v-else-if="sandboxError" class="at-htmlembed__state at-htmlembed__state--error">
      {{ sandboxError }}
    </p>

    <div v-else-if="needsFetch" class="at-htmlembed__state">
      <span>{{ loading ? '正在加载图解…' : '滚动到此处自动加载' }}</span>
      <button v-if="!loading" type="button" class="at-htmlembed__trigger" @click="ensureLoaded">
        立即加载
      </button>
    </div>

    <template v-else>
      <!--
        沙箱页承载：应用 CSP 不会被继承，图解的内联脚本可执行。
        sandbox="allow-scripts" 让沙箱页跑自己的投递脚本，同时碰不到应用页。
      -->
      <iframe
        ref="inlineFrame"
        class="at-htmlembed__frame"
        :style="{ height }"
        :src="inlineToken ? sandboxUrl(inlineToken) : undefined"
        sandbox="allow-scripts"
        loading="lazy"
        :title="title || 'HTML 图解'"
        @load="onInlineLoad"
      />
      <!--
        导出用的内容副本：导出是把离屏 DOM 克隆成独立 HTML 文件，那份文件里
        没有沙箱页可加载，导出流程会把这个副本（textContent 即原始 HTML）
        回填成 srcdoc。用 div 而不是 script 标签：Vue 模板编译器会直接
        忽略 `<script>`（"Tags with side effect are ignored"），拿不到副本。
      -->
      <div class="at-htmlembed__payload" aria-hidden="true">{{ resolvedHtml }}</div>
    </template>

    <!-- 新窗口被宿主拦截时的页内兜底：铺满视口放大查看，Esc 或按钮关闭 -->
    <Teleport to="body">
      <div
        v-if="overlay"
        class="at-htmlembed-overlay doc-surface"
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
          v-if="overlaySrc"
          ref="overlayFrame"
          class="at-htmlembed-overlay__frame"
          :src="overlaySrc"
          sandbox="allow-scripts"
          :title="(title || 'HTML 图解') + '（放大查看）'"
          @load="onOverlayLoad"
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

/* 导出副本不参与布局；屏幕态由沙箱页 iframe 呈现 */
.at-htmlembed__payload {
  display: none;
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

/* 覆盖层（Teleport 到 body，不受组件裁剪；scoped 样式因 Teleport 仍跟随组件 hash）。
   顶边让到标题栏以下：窗口按钮画在那条带上（Windows 右上 / macOS 左上），
   覆盖层自己的「关闭」按钮会与之重叠。
   ⚠️ 元素上必须同时带 `doc-surface` 类：组件只消费 --at-* 角色 token，而它们由
   `.doc-surface` 作用域提供；Teleport 到 body 后就脱离了这个作用域，漏掉这层
   类名会让底色与所有控件样式一起掉成默认值（透明 + 无边框）。 */
.at-htmlembed-overlay {
  position: fixed;
  inset: var(--at-overlay-top, 0px) 0 0 0;
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
