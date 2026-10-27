/**
 * 目录变化批次 → 「哪些已打开文档要重读」的判定（纯函数）。
 *
 * 主进程的递归监视把一批相对路径交给渲染层（400ms 内的多次写盘合成一批）。
 * 渲染层不能简单地「全刷」：一个工作区里可能开着十几篇文档，而 AI 一次只写了
 * 其中一篇；也不能「只刷当前那篇」：git checkout 会同时改写多篇。
 *
 * 所以按路径匹配，规则有三条：
 *  1. 命中的是文档本身（内容变化）；
 *  2. 命中的是它的祖先目录（目录改名 / 整体移动，树里所有文档路径都变了）；
 *  3. 批次里没有任何路径（平台不提供文件名，目录被整体替换）——只能保守全刷。
 *
 * 抽成纯函数是因为这类规则错了不报错：只会表现为「某篇文档停在旧内容上」，
 * 或者反过来把整库文档每 400ms 重读一遍。
 */

/** Windows 路径大小写不敏感，且两处可能一个用正斜杠一个用反斜杠 */
function normalizePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
}

/** 内容树只列 Markdown 与目录；其余文件的变化不影响树 */
const TREE_CONFIG_FILENAME = 'docs.config.yaml'

/**
 * 这批变化是否需要重扫目录树。
 *
 * 目录树只由「Markdown 文件 / 目录 / 内容根配置」决定。图片、附件、脚本写进来
 * 不该触发整树重扫——一次重扫要遍历整个内容根，大库上是实打实的 IO。
 *
 * 判据只能靠名字：`fs.watch` 不告诉我们是文件还是目录。所以：
 *  - 没有扩展名 → 可能是目录，要重扫；
 *  - `.md` → 文档，要重扫；
 *  - `docs.config.yaml` → 树结构由它决定，要重扫；
 *  - 其余带扩展名的（.png / .json / …）→ 树里本来就没有它，跳过。
 */
export function affectsTree(changed: readonly string[]): boolean {
  if (!changed.length) return true
  for (const raw of changed) {
    if (!raw) return true
    const base = normalizePath(raw).split('/').pop() ?? ''
    if (!base) return true
    if (base === TREE_CONFIG_FILENAME) return true
    const dot = base.lastIndexOf('.')
    // 没有扩展名：可能是新建目录（树里要出现一行），保守重扫
    if (dot <= 0) return true
    if (base.endsWith('.md')) return true
  }
  return false
}

/**
 * 某篇文档（工作区内相对路径）是否落在这批变化里。
 *
 * `changed` 为空表示平台没告知具体路径，按「全部受影响」处理。
 */
export function affectsDocument(relPath: string, changed: readonly string[]): boolean {
  if (!changed.length) return true
  const target = normalizePath(relPath)
  if (!target) return true
  for (const raw of changed) {
    // 单个空串同样表示「不知道具体改了什么」
    if (!raw) return true
    const path = normalizePath(raw)
    if (!path) return true
    if (target === path) return true
    // 祖先目录被改动（改名 / 移动 / 删除）：其下所有文档都要重新对账
    if (target.startsWith(`${path}/`)) return true
  }
  return false
}
