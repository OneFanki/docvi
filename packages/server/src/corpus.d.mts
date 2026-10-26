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
}

export interface Corpus {
  /** 多词 AND 全文检索（标题命中优先） */
  search(query: string, limit: number): SearchHit[]
  /** 读取一篇 .md；absolute 路径需落在某个范围内；失败返回可读说明字符串 */
  readDoc(path: string): ReadDocResult | string
}

export declare function createCorpus(listScopes: () => CorpusScope[]): Corpus
