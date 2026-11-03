/**
 * `packages/server/src/doc-write.mjs` 的类型声明。
 */
/** 单篇写入上限（与语料层读取上限一致） */
export declare const DOC_WRITE_MAX_BYTES: number

/** 支持的写入模式 */
export declare const WRITE_MODES: readonly string[]

export interface WriteDocInput {
  /** 工作区根目录（绝对路径） */
  root: string
  /** 工作区内的相对路径（.md / .markdown） */
  relPath: string
  /** 完整内容（append 模式下为追加内容） */
  text: string
  /** 缺省 create */
  mode?: 'create' | 'overwrite' | 'append'
  /** overwrite 必填：read_doc 返回的 mtime */
  baseMtime?: number
}

export interface WriteDocOutput {
  status: 'created' | 'updated' | 'appended'
  relPath: string
  mtime: number
  size: number
  bytes: number
}

/** 写一篇文档；失败抛带 code 的错误（E_INVALID / E_EXISTS / E_NOT_FOUND / E_CONFLICT / E_TOO_LARGE / E_IO） */
export declare function writeDocText(input: WriteDocInput): WriteDocOutput
