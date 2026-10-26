import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import type { ServiceState, ShareEntry } from '@docvi/shared'

/**
 * 本地服务与临时分享（渲染层视图状态）。
 *
 * 服务是独立进程，这里只镜像它推上来的状态：不在渲染层做「是否运行」的推断——
 * 端口顺延、绑定失败都只有服务自己知道。分享列表同理，增删后整份替换。
 */
export const useServiceStore = defineStore('service', () => {
  const state = ref<ServiceState | null>(null)
  const shares = ref<ShareEntry[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)
  /** 令牌默认遮住：屏幕上出现「能连进来的凭证」不适合随手展示 */
  const tokenVisible = ref(false)

  const running = computed(() => state.value?.running === true)
  const endpoint = computed(() => state.value?.endpoint ?? '')
  const lan = computed(() => state.value?.lan === true)
  const maskedToken = computed(() => {
    const token = state.value?.token ?? ''
    if (!token) return ''
    return tokenVisible.value ? token : `${token.slice(0, 6)}${'•'.repeat(20)}`
  })

  function apply(next: ServiceState): void {
    state.value = next
  }

  function unwrap<T>(
    result: { ok: true; data: T } | { ok: false; error: { message: string } },
  ): T | null {
    if (result.ok) return result.data
    error.value = result.error.message
    return null
  }

  async function load(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const next = unwrap(await window.docvi.serviceState())
      if (next) apply(next)
      await loadShares()
    } finally {
      loading.value = false
    }
  }

  async function loadShares(): Promise<void> {
    const list = unwrap(await window.docvi.shareList())
    if (list) shares.value = list
  }

  async function restart(): Promise<void> {
    loading.value = true
    try {
      const next = unwrap(await window.docvi.serviceRestart())
      if (next) apply(next)
    } finally {
      loading.value = false
    }
  }

  async function setLan(value: boolean): Promise<void> {
    const next = unwrap(await window.docvi.serviceSetLan(value))
    if (next) apply(next)
  }

  /** 改首选端口：服务会重启，返回的状态里 port 是最终实际端口（可能顺延） */
  async function setPort(port: number): Promise<boolean> {
    loading.value = true
    try {
      const next = unwrap(await window.docvi.serviceSetPort(port))
      if (!next) return false
      apply(next)
      return true
    } finally {
      loading.value = false
    }
  }

  async function createShare(): Promise<ShareEntry | null> {
    const created = unwrap(await window.docvi.shareCreate())
    if (created) await loadShares()
    return created
  }

  /** 分享一个已知绝对路径（当前打开的文档） */
  async function createSharePath(absolutePath: string): Promise<ShareEntry | null> {
    const created = unwrap(await window.docvi.shareCreatePath(absolutePath))
    if (created) await loadShares()
    return created
  }

  async function removeShare(id: string): Promise<void> {
    const list = unwrap(await window.docvi.shareRemove(id))
    if (list) shares.value = list
  }

  async function openShare(id: string): Promise<void> {
    const result = await window.docvi.shareOpen(id)
    if (!result.ok) error.value = result.error.message
  }

  async function copy(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      error.value = '复制失败：剪贴板不可用'
      return false
    }
  }

  /** 主进程推来的状态变化（崩溃重启、端口顺延） */
  function subscribe(): () => void {
    return window.docvi.onServiceChanged(next => {
      apply(next)
      void loadShares()
    })
  }

  return {
    state,
    shares,
    loading,
    error,
    tokenVisible,
    running,
    endpoint,
    lan,
    maskedToken,
    load,
    loadShares,
    restart,
    setLan,
    setPort,
    createShare,
    createSharePath,
    removeShare,
    openShare,
    copy,
    subscribe,
  }
})
