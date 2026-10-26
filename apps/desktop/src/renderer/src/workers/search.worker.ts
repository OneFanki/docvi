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
  | { type: 'index'; docs: Array<{ workspaceId: string; path: string; text: string }> }
  | { type: 'query'; id: number; text: string }
  | { type: 'clear' }

export type SearchResponse =
  { type: 'indexed'; count: number } | { type: 'results'; id: number; hits: SearchHit[] }

let mini: MiniSearch<IndexDoc> | null = null
/** 原文单独留在 worker 里：摘要需要它，但不进索引（避免同一份文本两份结构化副本） */
let bodies = new Map<string, string>()

/** 标题兜底：文件名去扩展名与目录前缀（README 之类用末段） */
function titleOf(path: string): string {
  const base = path.split('/').pop() ?? path
  return base.replace(/\.md$/i, '')
}

function build(
  docs: Array<{ workspaceId: string; path: string; text: string }>,
): MiniSearch<IndexDoc> {
  const engine = new MiniSearch<IndexDoc>({
    fields: ['title', 'text', 'path'],
    storeFields: ['path', 'title', 'workspaceId'],
    searchOptions: {
      boost: { title: 3, path: 1.5 },
      prefix: true,
      fuzzy: 0.2,
      combineWith: 'AND',
    },
  })
  engine.addAll(
    docs.map(doc => ({
      id: `${doc.workspaceId}:${doc.path}`,
      workspaceId: doc.workspaceId,
      path: doc.path,
      title: titleOf(doc.path),
      text: doc.text,
    })),
  )
  return engine
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
  if (request.type === 'index') {
    mini = build(request.docs)
    bodies = new Map(request.docs.map(doc => [`${doc.workspaceId}:${doc.path}`, doc.text]))
    const response: SearchResponse = { type: 'indexed', count: request.docs.length }
    self.postMessage(response)
    return
  }
  if (request.type === 'clear') {
    mini = null
    bodies = new Map()
    const response: SearchResponse = { type: 'indexed', count: 0 }
    self.postMessage(response)
    return
  }
  if (!mini) {
    const response: SearchResponse = { type: 'results', id: request.id, hits: [] }
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
