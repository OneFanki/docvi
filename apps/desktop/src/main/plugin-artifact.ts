/**
 * 插件市场「拉产物」链路的纯逻辑（无网络、无文件 IO）。
 *
 * 为什么不是下载 tarball：桌面安装包里**不带 node_modules**（见 plugin-store.ts
 * 的设计说明），没有解压库可用。而插件产物本身就是几个纯文本文件
 * （入口 JS + 样式 CSS + manifest），逐个 URL 拉下来直接落盘即可，
 * 既不需要解压，也天然支持按文件校验。
 *
 * 单独成文件的理由与 update-plan.ts 相同：主逻辑要 import electron，纯 Node
 * 单测加载不到；而这里的东西恰恰最该被测试守住——URL 解析错了装不上，
 * 路径校验漏了会把文件写到插件目录之外。
 */

/** 注册表条目里声明「产物在哪」的那一段 */
export interface MarketArtifact {
  /** 预构建 manifest 的绝对地址（plugin.json / manifest.json） */
  manifest: string
  /** manifest 文件本身的 SHA-256（十六进制，大小写不敏感） */
  sha256?: string
}

export interface ArtifactFile {
  /** 包内相对路径（正斜杠），如 `dist/index.js` */
  path: string
  /** 绝对下载地址 */
  url: string
}

/**
 * 默认可信的产物托管域。
 *
 * 与更新下载（update-plan.ts）同一套后缀匹配：插件产物由作者用 GitHub Actions
 * 自动构建后随 Release / 仓库发布，因此默认只认 GitHub 自己的域名。
 * 自建市场用 `DOCVI_MARKET_ALLOW_HOSTS` 追加（逗号分隔），不写死在代码里。
 */
const DEFAULT_TRUSTED_HOSTS = ['github.com', 'githubusercontent.com']

/**
 * 允许的产物域名。环境变量是**追加**而不是覆盖：自建市场不该顺手把 GitHub
 * 关掉，那会让同一个客户端在不同网络下行为不一致。
 */
export function trustedArtifactHosts(extra = process.env.DOCVI_MARKET_ALLOW_HOSTS): string[] {
  const added = String(extra ?? '')
    .split(',')
    .map(item => item.trim().toLowerCase())
    .filter(Boolean)
  return [...DEFAULT_TRUSTED_HOSTS, ...added]
}

/**
 * 绝对地址 + 可信域；任何不合规都返回 null（不抛，坏条目跳过）。
 *
 * **协议规则**：默认只认 https。清单本身可以来自 http 内网镜像，但产物必须走
 * TLS——否则同一网段的中间人可以替换插件代码。
 *
 * 唯一的例外是**显式配置**的域名：把内网地址写进 `DOCVI_MARKET_ALLOW_HOSTS`
 * 的人，是在自己承担这个风险（私有市场部署在内网、没有证书是常见情况）。
 * 这个开关必须显式打开，不能因为「host 是 127.0.0.1」就自动放宽——
 * 自动放宽等于给本地端口开了后门。
 */
export function trustedArtifactUrl(value: unknown, extraHosts?: string): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    return null
  }
  const host = url.hostname.toLowerCase()
  const extra = String(extraHosts ?? process.env.DOCVI_MARKET_ALLOW_HOSTS ?? '')
    .split(',')
    .map(item => item.trim().toLowerCase())
    .filter(Boolean)
  // https 且落在默认白名单；或 http 且落在**显式配置**的域名（内网私有市场）
  const trustedDefault = trustedArtifactHosts('').some(
    base => host === base || host.endsWith(`.${base}`),
  )
  const trustedExtra = extra.some(base => host === base || host.endsWith(`.${base}`))
  if (url.protocol === 'https:' && (trustedDefault || trustedExtra)) return url.toString()
  if (url.protocol === 'http:' && trustedExtra) return url.toString()
  return null
}

/** 解析注册表条目里的 artifact 段；缺字段或地址不可信都返回 null */
export function parseArtifact(raw: unknown, extraHosts?: string): MarketArtifact | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const manifest = trustedArtifactUrl(record.manifest, extraHosts)
  if (!manifest) return null
  const sha256 = typeof record.sha256 === 'string' ? record.sha256.trim() : ''
  return { manifest, ...(sha256 ? { sha256: sha256.toLowerCase() } : {}) }
}

/**
 * 包内相对路径的安全校验。
 *
 * 市场条目的 manifest 是**外部内容**：入口写成 `../../evil.js` 就能把文件写到
 * 插件目录之外。这里只允许相对路径，且不许出现 `..`、绝对路径、反斜杠
 * （统一用正斜杠，避免 Windows 上被当成合法分隔符绕过检查）。
 */
export function safePackagePath(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const raw = value.trim().replaceAll('\\', '/')
  if (!raw || raw.includes('\0')) return null
  if (raw.startsWith('/')) return null
  /*
   * 盘符必须单独拒绝：`C:/Windows/x.dll` 在 POSIX 眼里是一串普通字符，
   * 但在 Windows 上是**绝对路径**——`resolve(base, it)` 会直接跳出去。
   * 冒号在 Windows 文件名里本来也非法，统一按「含冒号即拒绝」处理最省事。
   */
  if (raw.includes(':')) return null
  // 协议版本里的两段式检查：任何一段是 .. 都可能在解析后跳出包目录
  const segments = raw.split('/')
  if (segments.some(segment => segment === '..' || segment === '.' || segment === '')) return null
  return segments.join('/')
}

/**
 * manifest 里需要下载的文件清单（入口 + 样式）。
 *
 * 只取这两个位置：插件产物就是「一颗 JS + 若干 CSS」，其余（示例文档、图标）
 * 都是仓库里的开发资源，运行时不读。少拉文件既快也少一点校验面。
 */
export function artifactFiles(
  manifest: { entry?: unknown; styles?: unknown },
  manifestUrl: string,
): ArtifactFile[] {
  const paths: string[] = []
  const entry = safePackagePath(manifest.entry)
  if (entry) paths.push(entry)
  if (Array.isArray(manifest.styles)) {
    for (const item of manifest.styles) {
      const path = safePackagePath(item)
      if (path && !paths.includes(path)) paths.push(path)
    }
  }
  const out: ArtifactFile[] = []
  for (const path of paths) {
    // manifest 在 <base>/plugin.json，entry 是 <base>/dist/index.js：
    // 以 manifest 地址为基准解析最省事，也让作者能用相对路径写清单
    let url: string
    try {
      url = new URL(path, manifestUrl).toString()
    } catch {
      continue
    }
    out.push({ path, url })
  }
  return out
}

/**
 * 下载回来的内容像不像 HTML。
 *
 * 404 页、登录墙、CDN 的错误页都是 200 + text/html。直接把它们当 JS 写进
 * dist，插件会加载失败并报一个与真实原因无关的语法错——必须当场识别。
 */
export function looksLikeHtml(body: string): boolean {
  const head = body.slice(0, 512).trimStart().toLowerCase()
  return head.startsWith('<!doctype html') || head.startsWith('<html')
}

/**
 * 校验远端 manifest 与本机清单条目一致。
 *
 * 注册表说「这是 A 插件的 1.2.0」，但远端 manifest 写的是 B 或别的版本——
 * 说明清单被改过或产物地址配错。这种不一致必须拒绝：否则用户以为装的是 A，
 * 实际装进来的是 B 的代码。
 */
export function manifestMatchesEntry(
  manifest: { name?: unknown; version?: unknown },
  entry: { name: string; version: string },
): { ok: true } | { ok: false; reason: string } {
  if (manifest.name !== entry.name) {
    return {
      ok: false,
      reason: `manifest 的 name（${String(manifest.name)}）与清单（${entry.name}）不一致`,
    }
  }
  if (manifest.version !== entry.version) {
    return {
      ok: false,
      reason: `manifest 的 version（${String(manifest.version)}）与清单（${entry.version}）不一致`,
    }
  }
  return { ok: true }
}

/**
 * 从仓库地址推出 GitHub 的 `owner/repo`，用于补作者与 star 数。
 *
 * 消费者是市场清单的每日刷新（`scripts/market-refresh.mjs`）：非 GitHub 托管
 * 的仓库拿不到 star 数，刷新时据此跳过，不做「猜一个接口」的尝试。
 */
export function githubRepoOf(repository: unknown): { owner: string; repo: string } | null {
  if (typeof repository !== 'string') return null
  let url: URL
  try {
    url = new URL(repository.trim())
  } catch {
    return null
  }
  const host = url.hostname.toLowerCase()
  if (host !== 'github.com' && host !== 'www.github.com') return null
  const [owner, repo] = url.pathname.split('/').filter(Boolean)
  if (!owner || !repo) return null
  // 去掉 `.git` 后缀与结尾斜杠产生的空段
  const name = repo.replace(/\.git$/i, '')
  if (!name) return null
  return { owner, repo: name }
}
