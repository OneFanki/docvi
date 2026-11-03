/**
 * `packages/server/src/doc-paths.mjs` 的类型声明。
 */
/** 扫描排除的目录名（树、搜索索引与写入校验共用） */
export declare const EXCLUDED_DIRS: Set<string>

/** 名字是否被扫描排除（点开头 / 排除目录） */
export declare function isExcludedName(name: string): boolean

/** 校验写入用的相对路径，返回规范化结果；非法时抛 code=E_INVALID 的错误 */
export declare function validateDocRelativePath(raw: string): string
