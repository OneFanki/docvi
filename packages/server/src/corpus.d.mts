/**
 * `packages/server/src/corpus.mjs` 的类型声明（桌面服务进程用；deployer / server 直接跑 JS）。
 */
export interface CorpusScope {
  /** 展示用范围名：桌面 = 工作区名；容器 = `<仓库名>@<分支>` */
  workspace: string
  /** 范围根目录（检索只在此根内进行，符号链接逃逸会被拒绝） */
  root: string
  /** 展示路径前缀（容器 = `<slug>/`；桌面省略） */
  prefix?: string
  /** AI 未指定位置时的落笔处（内建默认工作区）；容器不设 */
  default?: boolean
}

export interface SearchHit {
  workspace: string
  path: string
  title: string
  snippet: string
}

export interface ReadDocResult {
  workspace: string
  path: string
  title: string
  text: string
  /** 文件 mtime（毫秒）。写入时作为 baseMtime 做冲突判定；取不到为 null */
  mtime: number | null
}

/** resolveWrite 的成功结果：已解析到唯一工作区与其中的相对路径 */
export interface ResolvedWriteTarget {
  workspace: string
  root: string
  relPath: string
}

export interface Corpus {
  /** 多词 AND 全文检索（标题命中优先） */
  search(query: string, limit: number): SearchHit[]
  /** 读取一篇 .md；absolute 路径需落在某个范围内；失败返回可读说明字符串 */
  readDoc(path: string): ReadDocResult | string
  /**
   * 解析写入目标。解析顺序：显式 workspace → 容器前缀 → 既有文件唯一命中 →
   * 唯一工作区 → default 标记 → 报错。
   */
  resolveWrite(rawPath: string, workspace?: string): ResolvedWriteTarget | { error: string }
}

export declare function createCorpus(listScopes: () => CorpusScope[]): Corpus
