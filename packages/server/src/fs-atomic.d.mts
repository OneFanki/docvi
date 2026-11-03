/**
 * `packages/server/src/fs-atomic.mjs` 的类型声明。
 */
/** 原子写入文本（父目录不存在时自动创建）；失败抛原始 fs 错误 */
export declare function atomicWriteText(file: string, text: string): void
