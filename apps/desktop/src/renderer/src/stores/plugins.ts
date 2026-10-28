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
    /*
     * 作者与 star 直接来自清单的 `repo` 字段（每日 CI 批量刷新，见
     * .github/workflows/market-refresh.yml）——这里不做任何客户端 GitHub
     * API 调用：未认证限额 60 次/小时按 IP 共享，逐仓查询必然撞死。
     */
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

  /** 正在安装的插件名（界面据此给按钮转圈并防重复点击） */
  const installing = ref<string | null>(null)

  /**
   * 从市场安装：主进程拉产物 → 校验 → 落盘，回来后刷新已装列表。
   *
   * 与 `install()`（选本地目录）分开：这条要走网络、有明确的失败原因，
   * 界面需要把错误原样告诉用户（「manifest 校验值不一致」这类信息不能吞掉）。
   */
  /**
   * 从市场安装：主进程拉产物 → 校验 → 落盘，回来后刷新已装列表。
   *
   * 与 `install()`（选本地目录）分开：这条要走网络、有明确的失败原因，
   * 界面需要把错误原样告诉用户（「manifest 校验值不一致」这类信息不能吞掉）。
   *
   * ⚠️ 传给 IPC 前必须**深拷贝成纯对象**：`entry` 来自 pinia 的 reactive 数组，
   * 是 Proxy，跨进程结构化克隆会直接抛 `An object could not be cloned.`——
   * 而这个异常在渲染层被 async 函数吞成 rejected promise，界面只表现为
   * 「点了没反应」，控制台连一条错都不会有（实测踩到）。
   */
  async function installFromMarket(entry: MarketEntry): Promise<boolean> {
    if (installing.value) return false
    installing.value = entry.name
    error.value = null
    try {
      // 只带主进程真正需要的三个字段，顺带剥掉 Proxy 与多余数据
      const plain = {
        name: entry.name,
        version: entry.version,
        ...(entry.artifact ? { artifact: { ...entry.artifact } } : {}),
      }
      const result = await window.docvi.pluginInstallFromMarket(plain as MarketEntry)
      if (!result.ok) {
        // 错误文案由界面拼（store 不认识当前语言）
        error.value = result.error.message
        return false
      }
      records.value = result.data
      return true
    } catch (thrown) {
      /*
       * 走到这里说明请求根本没发出去（最典型就是上面那个 Proxy 克隆失败）。
       * 必须转成界面能显示的文案：静默吞掉会让用户以为按钮坏了。
       */
      error.value = `安装请求发送失败：${thrown instanceof Error ? thrown.message : String(thrown)}`
      return false
    } finally {
      installing.value = null
    }
  }

  /** 补仓库元信息（作者 / star）：拿不到就保持原样，不影响清单展示 */
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
    installing,
    installFromMarket,
    isInstalled,
    remove,
    setEnabled,
    setComponentEnabled,
  }
})
