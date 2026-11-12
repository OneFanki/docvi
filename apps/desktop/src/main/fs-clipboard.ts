/**
 * 文件级剪贴板：让 docvi 里的文件能被粘贴到资源管理器 / 微信 / 其它应用。
 *
 * 为什么必须走主进程：
 * 渲染层的 `navigator.clipboard` 只有 text / html / png 三种表示，「一个文件引用」
 * 不是其中任何一种。把路径当文本写进去，粘到微信是一串字，不是文件。
 *
 * 为什么用 `text/uri-list` 而不是手写 `CF_HDROP`：
 * Electron 44 的剪贴板 API 已换成 W3C 风格（`ClipboardItem` + MIME），旧的
 * `clipboard.writeBuffer(format, buffer)` 被移除。手写 DROPFILES 二进制结构
 * 需要它才能落地。而新版**已经把 `text/uri-list` 映射到各平台的原生「已复制文件」
 * 格式**（Windows `CF_HDROP`、macOS `NSFilenamesPboardType`、Linux `text/uri-list`）——
 * 这正是我们想要的效果，而且三个平台都成立，不需要按平台分支。
 *
 * 安全边界：只接受真实存在的工作区内绝对路径。路径校验由 IPC handler 用
 * `resolveInside` 完成（realpath containment），本模块只负责写剪贴板。
 */
import { clipboard, ClipboardItem } from 'electron'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * 把绝对路径写进系统剪贴板，使其可作为「文件」粘贴。
 *
 * 返回写入的条目数（调用方据此回一句「已复制 N 项」）。
 * 不存在的路径直接跳过而不是抛错：多选里某项刚被外部删掉时，整次失败比
 * 「少复制一个」更让人困惑。
 */
export async function copyFilesToClipboard(absolutePaths: string[]): Promise<number> {
  const existing = absolutePaths
    .filter(path => typeof path === 'string' && path.length > 0)
    .map(path => resolve(path))
    .filter(path => {
      try {
        return existsSync(path)
      } catch {
        return false
      }
    })

  if (!existing.length) return 0

  // file:// URL 是 `text/uri-list` 的规范形态：每行一个 URI，CRLF 分隔
  const uriList = existing.map(path => pathToFileURL(path).href).join('\r\n')
  await clipboard.write([
    new ClipboardItem({
      'text/uri-list': uriList,
      // 同时给一份纯文本路径：粘到编辑器 / 终端时得到的是可用路径而不是 URL，
      // 而按 MIME 优先级取数据的应用（微信、资源管理器）仍拿 uri-list 当文件。
      'text/plain': existing.join('\r\n'),
    }),
  ])
  return existing.length
}
