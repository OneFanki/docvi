import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import type { MarketCatalog, MarketEntry, PluginRecordView } from '@docvi/shared'

/**
 * 插件状态（渲染进程）。
 *
 * 主进程负责发现/安装/启停；渲染进程只消费「已启用插件」的贡献点。
 * 这里刻意不缓存 manifest 解析结果——插件目录可能在外部被改动，
 * 每次刷新都从主进程重读是最省心的正确做法。
 */
export const usePluginStore = defineStore('plugins', () => {
  const records = ref<PluginRecordView[]>([])
  /** 市场清单（远端配置文件里的条目；拉取失败时为空） */
  const market = ref<MarketEntry[]>([])
  /** 市场元信息：拉取时间、来源地址、离线原因（界面要显示「这是几点的副本」） */
  const marketMeta = ref<MarketCatalog | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)

  const enabled = computed(() => records.value.filter(record => record.enabled && !record.error))

  /** 已启用插件贡献的主题（按 id 覆盖内置同名主题） */
  const themes = computed(() =>
    enabled.value.flatMap(record =>
      (record.contributes?.themes ?? []).map(theme => ({ ...theme, plugin: record.name })),
    ),
  )

  /** 已启用插件声明的 Markdown 语法扩展（围栏语言 → 组件 kind） */
  const syntax = computed(() =>
    enabled.value.flatMap(record =>
      (record.contributes?.markdownSyntax ?? []).map(item => ({ ...item, plugin: record.name })),
    ),
  )

  function unwrap<T>(
    result: { ok: true; data: T } | { ok: false; error: { message: string } },
  ): T | null {
    if (result.ok) return result.data
    error.value = result.error.message
    return null
  }

  async function load(): Promise<void> {
    loading.value = true
    try {
      const list = unwrap(await window.docvi.pluginList())
      if (list) records.value = list
    } finally {
      loading.value = false
    }
  }

  async function install(): Promise<void> {
    const record = unwrap(await window.docvi.pluginInstall())
    if (record) await load()
  }

  /** 读市场清单（与 load 分开：市场要走网络，失败不该拖垮已装列表） */
  async function loadMarket(refresh = false): Promise<void> {
    const result = await window.docvi.pluginMarket({ refresh })
    if (!result.ok) {
      // 市场不可用不该弹错：已装插件照常展示，市场分区显示空态
      market.value = []
      return
    }
    market.value = (result.data as MarketCatalog).plugins
    marketMeta.value = result.data as MarketCatalog
  }

  /**
   * 市场条目是否已安装（按包名匹配，不看版本——版本升级走重新安装）。
   *
   * 两边的名字口径不同：市场清单写**包名**（`docs-plugin-base`），已装记录里
   * manifest.name 也是包名，所以这里能对上；早先对不上是因为 merged-table 的
   * manifest 写的 `merged-table` 而市场写 `docs-plugin-merged-table`。
   */
  function isInstalled(name: string): boolean {
    return records.value.some(record => record.name === name)
  }

  async function remove(id: string): Promise<void> {
    const list = unwrap(await window.docvi.pluginUninstall(id))
    if (list) records.value = list
  }

  async function setEnabled(id: string, value: boolean): Promise<void> {
    const list = unwrap(await window.docvi.pluginSetEnabled(id, value))
    if (list) records.value = list
  }

  async function setComponentEnabled(id: string, kind: string, value: boolean): Promise<void> {
    const list = unwrap(await window.docvi.pluginSetComponentEnabled(id, kind, value))
    if (list) records.value = list
  }

  return {
    records,
    market,
    marketMeta,
    enabled,
    themes,
    syntax,
    loading,
    error,
    load,
    loadMarket,
    install,
    isInstalled,
    remove,
    setEnabled,
    setComponentEnabled,
  }
})
