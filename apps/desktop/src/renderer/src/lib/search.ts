import { reactive } from 'vue'

import { startTask, type TaskHandle } from './tasks'

import type { SearchResponse, SearchHit } from '../workers/search.worker'

/**
 * 搜索索引客户端：管理 worker 生命周期、请求配对，并对**所有工作区**建同一份索引。
 *
 * 两种宿主两种实现：
 *  - 桌面：主进程按工作区给整库原文，这里在 worker 里建 minisearch 索引；
 *  - 容器：服务端构建时已生成索引，宿主提供 `searchQuery`，这里只做查询。
 *
 * 分支只在这一处判断（`usesHostIndex`），上层组件拿到的都是同一份 state。
 *
 * 请求带自增 id，只接受最新一次查询的结果——输入框逐字触发查询时，
 * 旧查询可能后到并覆盖新结果（乱序返回），这是搜索框最常见的竞态。
 *
 * 为什么是一份索引而不是每工作区一份：搜索面板是唯一入口，同一个输入框要同时
 * 搜「当前」和「其他」工作区。分成多份再合并只是多一层排序逻辑，收益为零；
 * 命中里带 workspaceId 就足以让面板分组。
 */
export interface SearchState {
  ready: boolean
  indexing: boolean
  /** 已索引文档数 */
  count: number
  /** 已建索引的工作区数 / 工作区总数（面板据此显示索引进度） */
  indexedWorkspaces: number
  totalWorkspaces: number
  query: string
  hits: SearchHit[]
  error: string | null
  /** 索引由宿主提供（容器）：面板据此换掉「打开工作区才能搜」的引导文案 */
  external: boolean
}

interface CorpusDoc {
  workspaceId: string
  path: string
  text: string
}

/** 宿主自带索引（容器）：不需要语料，也不需要 worker */
const usesHostIndex = typeof window.docvi.searchQuery === 'function'

export function useSearchIndex() {
  const state = reactive<SearchState>({
    ready: false,
    indexing: false,
    count: 0,
    indexedWorkspaces: 0,
    totalWorkspaces: 0,
    query: '',
    hits: [],
    error: null,
    external: usesHostIndex,
  })

  let worker: Worker | null = null
  let seq = 0
  /** 当前只接受这个 id 的结果 */
  let awaited = 0
  /** 已进索引的工作区 */
  const indexed = new Set<string>()
  /** 语料按工作区累积；每次追加后整体重建（理由见 rebuild） */
  const corpus = new Map<string, CorpusDoc[]>()
  /** 建索引串行执行：并发读多个大目录只会互相抢 IO，进度也会乱跳 */
  let queue: string[] = []
  let running: Promise<void> | null = null

  /**
   * 外部改动后的延迟重建定时器（按工作区）。
   *
   * AI 写一篇文档常常连着触发好几种事件；每批都全库重读 + 重建，会让索引队列
   * 一直跑、底栏任务反复闪。合并成「安静一段时间后重建一次」。
   */
  const reindexTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** 每个工作区外部重读的世代号（并发重读时只接受最新一次的结果） */
  const refreshSeq = new Map<string, number>()

  function ensureWorker(): Worker {
    if (worker) return worker
    worker = new Worker(new URL('../workers/search.worker.ts', import.meta.url), {
      type: 'module',
      name: 'docvi-search',
    })
    worker.onmessage = (event: MessageEvent<SearchResponse>) => {
      const message = event.data
      if (message.type === 'indexed') {
        state.count = message.count
        state.indexing = false
        state.ready = true
        /*
         * 重建完成后补一次查询。
         *
         * 索引重建期间用户可能已经敲了几个字：那次查询跑在旧索引上（甚至是空索引），
         * 结果为空且**不会自己再变**——表现为「搜索框明明有关键词，结果区一直空着」，
         * 直到用户再多按一个键才发现内容其实在。这里是唯一的补救点。
         */
        if (state.query.trim()) search(state.query)
        return
      }
      // 丢弃过期查询的结果
      if (message.id !== awaited) return
      state.hits = message.hits
    }
    return worker
  }

  /**
   * 整体重建索引。
   *
   * 不做增量删除：工作区里的文档会增删改名，增量维护要跟踪每个 path 的归属，
   * 一旦漏删就是「搜得到但打不开」的脏命中。几百篇规模整体重建只要几十毫秒。
   */
  function rebuild(): void {
    const docs: CorpusDoc[] = []
    for (const list of corpus.values()) docs.push(...list)
    ensureWorker().postMessage({ type: 'index', docs })
  }

  async function indexOne(workspaceId: string, task: TaskHandle | null): Promise<void> {
    if (indexed.has(workspaceId)) return
    if (task?.isCancelled()) return
    state.indexing = true
    const result = await window.docvi.searchCorpus(workspaceId)
    if (!result.ok) {
      state.error = result.error.message
      state.indexing = false
      return
    }
    if (task?.isCancelled()) {
      state.indexing = false
      return
    }
    indexed.add(workspaceId)
    corpus.set(
      workspaceId,
      result.data.map(doc => ({ workspaceId, path: doc.path, text: doc.text })),
    )
    state.indexedWorkspaces = indexed.size
    rebuild()
  }

  /**
   * 索引队列（带底栏进度）。
   *
   * 关键行为：**调用方 await 它只为「搜得到」**——打开工作区/文档绝不 await。
   * 之前的实现里 ensureTabReady 会等整库读完才继续，大库上表现为「点开工作区
   * 后界面卡住没有任何反应」；现在打开是即时的，索引进度在底栏显示。
   */
  function runQueue(): Promise<void> {
    if (running) return running
    running = (async () => {
      const total = queue.length
      let done = 0
      const task = startTask(
        {
          key: 'search-index',
          label: labelOf('indexing'),
          ratio: total ? 0 : null,
          detail: total ? `${0}/${total}` : undefined,
        },
        { cancellable: true },
      )
      try {
        while (queue.length) {
          if (task.isCancelled()) break
          const next = queue.shift()
          if (!next) break
          await indexOne(next, task)
          done += 1
          task.update({
            ratio: total ? done / total : null,
            detail: `${done}/${total}`,
          })
        }
      } finally {
        // 取消时也收尾：底栏不该留着一条永远不动的任务
        task.update({ done: true })
        running = null
      }
    })()
    return running
  }

  /** 进度文案（此处不引 i18n 依赖：检索层不认识界面语言，由调用方注入） */
  let labelOf: (key: 'indexing') => string = () => '正在建立搜索索引'

  /** 由 App 注入当前语言的文案 */
  function setLabels(next: { indexing: string }): void {
    labelOf = () => next.indexing
  }

  /** 确保某个工作区已索引（幂等，可重复调用） */
  function index(workspaceId: string): Promise<void> {
    // 服务端已建好索引：这条路径只服务于「本地建索引」的桌面宿主
    if (usesHostIndex) return Promise.resolve()
    if (indexed.has(workspaceId)) return Promise.resolve()
    if (!queue.includes(workspaceId)) queue.push(workspaceId)
    return runQueue()
  }

  /**
   * 其余工作区在空闲时补建索引。
   *
   * 当前工作区由调用方先行 `index`（要能搜出结果就得先有数据）；
   * 其余工作区不该抢当前交互的 IO，推到空闲回调里逐个补。
   */
  function indexRest(workspaceIds: string[], activeId: string | null): void {
    if (usesHostIndex) return
    state.totalWorkspaces = workspaceIds.length
    const rest = workspaceIds.filter(id => id !== activeId && !indexed.has(id))
    if (!rest.length) return
    const run = (): void => {
      for (const id of rest) void index(id)
    }
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(run, { timeout: 2000 })
      return
    }
    setTimeout(run, 300)
  }

  function search(text: string): void {
    state.query = text
    if (!text.trim()) {
      state.hits = []
      return
    }
    seq += 1
    const current = seq
    if (usesHostIndex) {
      // 服务端索引：查询是异步 HTTP，仍按 seq 丢弃过期结果
      void window.docvi.searchQuery?.(text).then(result => {
        if (current !== seq) return
        if (!result.ok) {
          state.error = result.error.message
          state.hits = []
          return
        }
        state.error = null
        // 首次查询顺带把总篇数带回：面板的「已索引 N 篇」不依赖逐仓建索引
        if (result.data.total) state.count = result.data.total
        state.ready = true
        state.hits = result.data.hits.map(hit => ({
          id: `${hit.workspaceId ?? ''}:${hit.path}`,
          workspaceId: hit.workspaceId,
          path: hit.path,
          title: hit.title,
          score: hit.score,
          snippet: hit.snippet,
        }))
      })
      return
    }
    awaited = seq
    ensureWorker().postMessage({ type: 'query', id: seq, text })
  }

  function clear(): void {
    for (const timer of reindexTimers.values()) clearTimeout(timer)
    reindexTimers.clear()
    indexed.clear()
    corpus.clear()
    queue = []
    state.ready = false
    state.count = 0
    state.indexedWorkspaces = 0
    state.totalWorkspaces = 0
    state.hits = []
    worker?.postMessage({ type: 'clear' })
  }

  /**
   * 作废某个工作区的索引（拉取更新 / 切分支 / 外部改动之后）。
   *
   * 索引是按工作区缓存的，工作区内容在磁盘上变了而 id 没变时，`index()` 会因为
   * 「已索引」直接返回——搜索面板就会一直拿旧语料回答。作废后下次 `index()` 重读。
   */
  function invalidate(workspaceId: string): void {
    if (!indexed.delete(workspaceId) && !corpus.has(workspaceId)) return
    corpus.delete(workspaceId)
    state.indexedWorkspaces = indexed.size
    rebuild()
  }

  /**
   * 外部改动后的延迟重建。
   *
   * 与 `invalidate` 的区别有两点：
   *  1. **等安静下来再重建**。AI 一次批量写十几个文件会连着推好几批事件，
   *     每批都整库重读会让索引任务一直在跑、底栏与面板反复闪。1.2s 内没有
   *     新事件才动手，一批写盘只读一遍。
   *  2. **旧索引不提前丢弃**。搜索在重建完成前仍能命中旧内容——短暂搜到旧结果，
   *     远好过「输入关键词、结果区空了 1.2 秒再出现」。
   *
   * 重建期间可能又来一批事件（用户连续保存）：按世代号丢弃过期的读取结果，
   * 否则先发起、后返回的那次会用更旧的语料覆盖新语料。
   */
  function invalidateSoon(workspaceId: string, delay = 1200): void {
    if (usesHostIndex) return
    const existing = reindexTimers.get(workspaceId)
    if (existing) clearTimeout(existing)
    reindexTimers.set(
      workspaceId,
      setTimeout(() => {
        reindexTimers.delete(workspaceId)
        void refresh(workspaceId)
      }, delay),
    )
  }

  /** 重读某个工作区的语料并整体替换（成功后一次性重建，不留空窗） */
  async function refresh(workspaceId: string): Promise<void> {
    refreshSeq.set(workspaceId, (refreshSeq.get(workspaceId) ?? 0) + 1)
    const seq = refreshSeq.get(workspaceId) ?? 0
    state.indexing = true
    const result = await window.docvi.searchCorpus(workspaceId)
    // 期间又发起了更新的一次：这次结果已过时
    if (seq !== refreshSeq.get(workspaceId)) return
    if (!result.ok) {
      state.error = result.error.message
      state.indexing = false
      return
    }
    indexed.add(workspaceId)
    corpus.set(
      workspaceId,
      result.data.map(doc => ({ workspaceId, path: doc.path, text: doc.text })),
    )
    state.indexedWorkspaces = indexed.size
    rebuild()
  }

  function dispose(): void {
    for (const timer of reindexTimers.values()) clearTimeout(timer)
    reindexTimers.clear()
    worker?.terminate()
    worker = null
  }

  return {
    state,
    index,
    indexRest,
    search,
    clear,
    invalidate,
    invalidateSoon,
    dispose,
    setLabels,
  }
}

/** 全应用共享一份索引：切换面板不重建 */
export const searchIndex = useSearchIndex()
