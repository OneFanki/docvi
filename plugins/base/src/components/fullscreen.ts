import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { Ref } from 'vue'

/**
 * useFullscreen —— 组件级全屏切换（原生 API 优先，失败退化为 fixed 覆盖层）。
 *
 * 两个嵌入环境的坑都收在这里，调用方只需 `const { isFullscreen, overlay, toggle } = useFullscreen(rootRef)`：
 * 1. `requestFullscreen` 在隐藏 webview 里可能**悬挂**（既不 resolve 也不 reject）→
 *    Promise.race 900ms 超时，与 reject 一起收进覆盖层降级路径；
 * 2. `fullscreenchange` 在部分嵌入环境不触发、且 promise resolve 时 `fullscreenElement`
 *    可能尚未落定 → 主动同步 + 150ms 延迟兜底。
 *
 * 覆盖层模式：整个组件以 `position: fixed; inset: 0` 铺满视口，Esc 退出；
 * 组件侧给根元素挂 `is-overlay` 类（与本 composable 的 overlay 状态同名约定）。
 */
export function useFullscreen(rootRef: Ref<HTMLElement | null>) {
  const nativeActive = ref(false)
  const overlay = ref(false)
  const isFullscreen = computed(() => nativeActive.value || overlay.value)
  let syncTimer: number | undefined
  let hangTimer: number | undefined

  function sync() {
    if (typeof document === 'undefined') return
    nativeActive.value = document.fullscreenElement === rootRef.value
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && overlay.value) overlay.value = false
  }

  async function toggle() {
    if (typeof document === 'undefined') return
    if (overlay.value) {
      overlay.value = false
      return
    }
    if (document.fullscreenElement === rootRef.value) {
      await document.exitFullscreen()
      sync()
      return
    }
    try {
      await Promise.race([
        rootRef.value?.requestFullscreen(),
        new Promise<never>((_, reject) => {
          hangTimer = window.setTimeout(() => reject(new Error('fullscreen-unsupported')), 900)
        }),
      ])
      sync()
      window.clearTimeout(syncTimer)
      syncTimer = window.setTimeout(sync, 150)
    } catch {
      // 嵌入式页面拿不到 Fullscreen 权限、或请求悬挂时的退化路径
      overlay.value = true
    } finally {
      window.clearTimeout(hangTimer)
    }
  }

  onMounted(() => {
    document.addEventListener('fullscreenchange', sync)
    document.addEventListener('keydown', onKeydown)
  })

  onBeforeUnmount(() => {
    window.clearTimeout(syncTimer)
    window.clearTimeout(hangTimer)
    document.removeEventListener('fullscreenchange', sync)
    document.removeEventListener('keydown', onKeydown)
  })

  return { isFullscreen, overlay, toggle }
}
