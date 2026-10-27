/**
 * 磁盘外部改动的判定规则（纯函数）。
 *
 * 背景：主进程对「当前文档」挂目录 watcher，外部一改就推一条路径过来；渲染层
 * 拿到路径后**必须重读磁盘并回写缓冲区**，否则界面停在旧内容上。这条链路上
 * 真正容易出错的不是 IO，而是「三种情形怎么处理」的判断：
 *
 *  1. 内容没变（自己刚保存触发的 watcher 回响、被 touch、格式化工具原样写回）：
 *     什么都不该做，否则会把一次保存变成一次「外部改动」提示。
 *  2. 缓冲区干净（用户没输过东西）：静默采用磁盘版本，这是阅读态最常见的情形。
 *  3. 缓冲区有未保存改动：**绝不静默覆盖**，必须让用户选。
 *
 * 抽成纯函数是为了让这三条规则能被单测钉住——它们一旦被改错，丢的是用户
 * 刚敲进去的内容，而界面上不会有任何报错。
 */

export type ExternalChangeVerdict = 'ignored' | 'adopted' | 'conflict'

export interface BufferSnapshot {
  /** 缓冲区正文（界面正在显示的内容） */
  text: string
  /** 缓冲区基线（上次读盘 / 保存成功的正文） */
  savedText: string
  /** 已知的磁盘正文 */
  diskText: string
}

/**
 * 判定一次外部改动该怎么处理。
 *
 * 注意前两条只比**内容**：自保存的 watcher 回响与「只是 mtime 变了」在内容上
 * 都等于已知磁盘内容，两者都无需动缓冲区。调用方仍需对齐 mtime 基线，
 * 否则下一次保存会被主进程按 mtime 判成冲突。
 *
 * 「外部内容 == 缓冲区内容」单独判为采用：常见于 AI 把用户正在写的东西原样
 * 写回磁盘。此时采用不会丢任何字，只是把脏标记变成已保存——报冲突纯属打扰。
 */
export function decideExternalChange(
  buffer: BufferSnapshot,
  incoming: { text: string },
): ExternalChangeVerdict {
  if (incoming.text === buffer.diskText) return 'ignored'
  if (incoming.text === buffer.text) return 'adopted'
  if (buffer.text === buffer.savedText) return 'adopted'
  return 'conflict'
}

/**
 * 两个绝对路径是否指向同一篇文档。
 *
 * Windows 路径大小写不敏感，且同一条路径可能一处用正斜杠、一处用反斜杠
 * （主进程 watcher 回传的是小写后的原样字符串）。直接字符串比较会漏判，
 * 表现为「外部改了但界面不动」。
 */
export function sameDocumentPath(a: string, b: string): boolean {
  const normalize = (value: string): string => value.replaceAll('\\', '/').toLowerCase()
  return normalize(a) === normalize(b)
}
