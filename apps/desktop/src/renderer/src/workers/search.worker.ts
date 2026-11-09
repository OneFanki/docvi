/// <reference lib="webworker" />
import MiniSearch from 'minisearch'

/**
 * 搜索索引 worker。
 *
 * 为什么放 worker：索引与查询都是 CPU 活，整库几万字文档建索引会在主线程
 * 上卡住阅读滚动；worker 里跑完只回传命中列表。
 *
 * 字段设计：`title` 权重最高（文档标题就是最准的意图），`text` 兜底，
 * `path` 用于展示与排序兜底。prefix + fuzzy 让「输一半」和「打错一个字母」
 * 都能命中——本地搜索没有服务器帮忙纠错，模糊匹配是必要补偿。
 *
 * **一份索引装所有工作区**，所以主键不能只用 path：相对路径在不同工作区里
 * 会重名（两个仓库都有 `rules/code-constraints.md`），必须拼上 workspaceId。
 */

export interface IndexDoc {
  id: string
  /** 工作区 id；单文件（不在工作区内）为 null */
  workspaceId: string | null
  path: string
  title: string
  text: string
}

export interface SearchHit {
  id: string
  workspaceId: string | null
  path: string
  title: string
  score: number
  /** 命中位置的上下文片段（纯文本，前端自己决定高亮） */
  snippet: string
}

export type SearchRequest =
  /**
   * 用一批文档替换某个工作区的全部索引内容（新增 / 改动 / 删除一次说清）。
   *
   * 刻意不提供「整体重建」：以前每加入一个工作区就把所有工作区拼起来重建一次，
   * 三个仓库启动要 30 秒单核；而且任何一次外部改动走的也是同一条路。
   * 现在只动送来的这一个工作区，其余分片原样保留。
   */
  | { type: 'replace'; workspaceId: string; docs: Array<{ path: string; text: string }> }
  /** 整库作废（clear 或工作区被移除） */
  | { type: 'drop'; workspaceId: string }
  | { type: 'query'; id: number; text: string }
  | { type: 'clear' }

export type SearchResponse =
  { type: 'indexed'; count: number } | { type: 'results'; id: number; hits: SearchHit[] }

/**
 * 一份索引装所有工作区（主键 `workspaceId:path`），但**按工作区记账**：
 * `owned` 记录每个工作区贡献了哪些 id，替换时只 discard 这一片。
 */
let mini = new MiniSearch<IndexDoc>({
  fields: ['title', 'text', 'path'],
  storeFields: ['path', 'title', 'workspaceId'],
  searchOptions: {
    boost: { title: 3, path: 1.5 },
    prefix: true,
    fuzzy: 0.2,
    combineWith: 'AND',
  },
})
/** 各工作区已进索引的 doc id（替换时据此精确移除旧版本） */
const owned = new Map<string, string[]>()
/** 原文单独留在 worker 里：摘要需要它，但不进索引（避免同一份文本两份结构化副本） */
let bodies = new Map<string, string>()

function docId(workspaceId: string, path: string): string {
  return `${workspaceId}:${path}`
}

/** 标题兜底：文件名去扩展名与目录前缀（README 之类用末段） */
function titleOf(path: string): string {
  const base = path.split('/').pop() ?? path
  return base.replace(/\.md$/i, '')
}

/** 把某个工作区的旧分片摘掉（索引与正文两份都要摘，否则摘要会留着旧文本） */
function dropWorkspace(workspaceId: string): void {
  for (const id of owned.get(workspaceId) ?? []) {
    mini.discard(id)
    bodies.delete(id)
  }
  owned.delete(workspaceId)
}

/** 用一批文档替换某个工作区的分片：先摘旧片，再把新文档加进同一份索引 */
function replaceWorkspace(workspaceId: string, docs: Array<{ path: string; text: string }>): void {
  dropWorkspace(workspaceId)
  const ids: string[] = []
  for (const doc of docs) {
    const id = docId(workspaceId, doc.path)
    ids.push(id)
    bodies.set(id, doc.text)
    mini.add({
      id,
      workspaceId,
      path: doc.path,
      title: titleOf(doc.path),
      text: doc.text,
    })
  }
  owned.set(workspaceId, ids)
}

/**
 * 摘要：取第一个命中词附近的一段，前后各留一点上下文。
 * 返回纯文本——高亮交给前端做，worker 不产出 HTML（避免注入面）。
 */
function snippetOf(text: string, terms: string[]): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const lower = flat.toLowerCase()
  let at = -1
  for (const term of terms) {
    const index = lower.indexOf(term.toLowerCase())
    if (index >= 0 && (at < 0 || index < at)) at = index
  }
  if (at < 0) return flat.slice(0, 96)
  const start = Math.max(0, at - 32)
  return `${start > 0 ? '…' : ''}${flat.slice(start, start + 110)}`
}

self.onmessage = (event: MessageEvent<SearchRequest>) => {
  const request = event.data
  if (request.type === 'replace') {
    replaceWorkspace(request.workspaceId, request.docs)
    const response: SearchResponse = { type: 'indexed', count: mini.documentCount }
    self.postMessage(response)
    return
  }
  if (request.type === 'drop') {
    dropWorkspace(request.workspaceId)
    // discard 只打删除标记，词表条目仍留着；攒够了一批再回收，避免每次改动都全量压缩
    mini.vacuum()
    const response: SearchResponse = { type: 'indexed', count: mini.documentCount }
    self.postMessage(response)
    return
  }
  if (request.type === 'clear') {
    mini = new MiniSearch<IndexDoc>({
      fields: ['title', 'text', 'path'],
      storeFields: ['path', 'title', 'workspaceId'],
      searchOptions: {
        boost: { title: 3, path: 1.5 },
        prefix: true,
        fuzzy: 0.2,
        combineWith: 'AND',
      },
    })
    owned.clear()
    bodies = new Map()
    const response: SearchResponse = { type: 'indexed', count: 0 }
    self.postMessage(response)
    return
  }
  const results = mini.search(request.text).slice(0, 60)
  const hits: SearchHit[] = results.map(result => {
    const fields = mini?.getStoredFields(result.id) as
      { path: string; title: string; workspaceId: string | null } | undefined
    const terms = result.terms ?? []
    const path = fields?.path ?? String(result.id)
    return {
      id: result.id,
      workspaceId: fields?.workspaceId ?? null,
      path,
      title: fields?.title ?? path,
      score: result.score,
      snippet: snippetOf(bodies.get(result.id) ?? '', terms),
    }
  })
  const response: SearchResponse = { type: 'results', id: request.id, hits }
  self.postMessage(response)
}
