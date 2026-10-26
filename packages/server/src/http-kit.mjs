/**
 * HTTP 服务公共件：容器 deployer 与桌面服务层共用的最小原语。
 *
 * 为什么要有这一层（2026-10-20 用户要求「合并两套服务端」）：
 * 两侧的 httpd 各自实现了一遍 MIME 表、sendFile、resolveInRoot、请求体读取、
 * 壳静态资源兜底和分享代理。协议一旦在这儿漂移，症状是「桌面能看、容器白屏」
 * 这类只在某一端出现的怪问题——正是要靠单一实现消除的。
 *
 * 这里只放**无业务语义**的件：
 * - 传输原语（writeJson / sendFile / resolveInRoot / readJsonBody / isLoopback）
 * - 静态站点（壳资产 → 内容根静态文件 → index.html 兜底）
 * - 分享代理（/s/<id>/…：文件单文档 + 目录迷你站点，按真实路径实时读）
 *
 * 业务差异留在各自 httpd：deployer 的仓库/构建/运维，服务层的 health/control。
 */
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { buildTreePayload } from './share-site.mjs'

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wasm': 'application/wasm',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
}

export function mimeOf(path) {
  return MIME[extname(String(path)).toLowerCase()] ?? 'application/octet-stream'
}

/** JSON 应答（一律 no-cache：运维面板与壳都要求「改完即见」） */
export function writeJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache',
  })
  res.end(JSON.stringify(payload))
}

/** 文本应答（错误页 / 拒绝文案） */
export function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-cache' })
  res.end(text)
}

/** 文件应答；immutable 用于「版本段在 URL 里」的插件资产与构建产物 */
export function sendFile(res, file, { status = 200, immutable = false } = {}) {
  let stat
  try {
    stat = statSync(file)
    if (!stat.isFile()) throw new Error('not a file')
  } catch {
    res.writeHead(404)
    return res.end('not found')
  }
  res.writeHead(status, {
    'Content-Type': mimeOf(file),
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'Content-Length': String(stat.size),
  })
  createReadStream(file).pipe(res)
}

/**
 * 防穿越：把 URL 路径解析到 root 内。
 * 越界（.. / 绝对路径跳出）返回 null，由调用方给 404/403。
 */
export function resolveInRoot(root, urlPath) {
  let decoded
  try {
    decoded = decodeURIComponent(String(urlPath).split('?')[0])
  } catch {
    return null
  }
  const base = resolve(root)
  const target = resolve(base, `.${normalize(decoded)}`)
  if (target !== base && !target.startsWith(base + sep)) return null
  return target
}

/** 对端是否回环（IPv4 回环段、::1、IPv4 映射） */
export function isLoopback(address) {
  if (!address) return false
  const raw = address.replace(/^::ffff:/i, '')
  return raw === '::1' || raw === '::ffff:1' || /^127\./.test(raw)
}

export const DEFAULT_BODY_LIMIT = 256 * 1024

/**
 * 读取并解析 JSON 请求体。
 *
 * 超限即销毁连接（不继续读）——否则客户端还能把几 GB 塞进内存。
 * 空体返回 {}（PATCH 只带一个字段的场景很常见）。
 */
export function readJsonBody(req, { limit = DEFAULT_BODY_LIMIT } = {}) {
  return new Promise((resolveBody, reject) => {
    let size = 0
    let settled = false
    const chunks = []
    req.on('data', chunk => {
      if (settled) return
      size += chunk.length
      if (size > limit) {
        settled = true
        reject(new Error(`请求体超过 ${Math.round(limit / 1024)}KB 上限`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw.trim()) return resolveBody({})
      try {
        resolveBody(JSON.parse(raw))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', error => {
      if (settled) return
      settled = true
      reject(error)
    })
  })
}

/**
 * 构造静态站点伺服器（壳 SPA + 内容根静态资产）。
 *
 * 顺序：站点资产精确命中（assets 下 immutable）→ 内容根静态文件（.md 不走，
 * 文档由渲染层经宿主协议取）→ index.html 兜底（history 路由由前端解析）。
 *
 * @param {object} options
 * @param {string} options.shellRoot 站点产物目录（apps/desktop/dist-web）
 * @returns {(res: object, opts?: {contentRoot?: string|null, urlPath?: string, nested?: boolean}) => void}
 *   `nested: true` 表示本次入口挂在多层前缀下（分享页 `/s/<id>/`），调用方要
 *   自行改写 index.html（注入 `<base href>`）；默认不改写。
 */
export function createStaticSite({ shellRoot }) {
  const indexFile = join(shellRoot, 'index.html')

  return function serveStatic(res, { contentRoot = null, urlPath = '/', nested = false } = {}) {
    const clean = String(urlPath).split('?')[0]
    if (clean !== '/' && clean !== '') {
      // 壳资产精确命中
      const asset = resolveInRoot(shellRoot, clean)
      if (asset && existsSync(asset) && statSync(asset).isFile()) {
        return sendFile(res, asset, { immutable: asset.includes(`${sep}assets${sep}`) })
      }
      // 内容根静态文件（图片 / staticDirs 的自包含 HTML）；.md 不走此路径
      if (contentRoot) {
        const content = resolveInRoot(contentRoot, clean)
        if (
          content &&
          !content.toLowerCase().endsWith('.md') &&
          existsSync(content) &&
          statSync(content).isFile()
        ) {
          return sendFile(res, content)
        }
      }
    }
    // history 路由兜底
    if (!existsSync(indexFile)) {
      return sendText(res, 503, '站点资产缺失：请先执行 pnpm docvi:build:web')
    }
    if (!nested) return sendFile(res, indexFile)
    try {
      return sendText(
        res,
        200,
        withBaseHref(readFileSync(indexFile, 'utf8')),
        'text/html; charset=utf-8',
      )
    } catch {
      // 读失败退回静态发送（至少不阻断入口，错误由浏览器侧报出）
      return sendFile(res, indexFile)
    }
  }
}

/**
 * 给壳入口注入 `<base href="/">`。
 *
 * 为什么需要：分享页挂在 `/s/<id>/` 下，而桌面安装包用的是 app 变体产物
 * （资产写 `./assets/…`，为 file:// 而设）。浏览器会把相对请求解析成
 * `/s/<id>/assets/…`，服务端找不到就回落成壳 HTML，模块脚本拿到 text/html
 * 被拒，整页白屏。注入 base 后资产与 import map 一律回到站点根。
 * 站点变体本就是绝对路径，注入后行为不变。
 */
export function withBaseHref(html) {
  if (/<base\s/i.test(html)) return html
  const tag = '<base href="/">'
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, match => `${match}${tag}`)
  }
  if (/<html[^>]*>/i.test(html)) {
    return html.replace(/<html[^>]*>/i, match => `${match}<head>${tag}</head>`)
  }
  // 无 head / html 的极简文档（测试夹具、被裁过的产物）：<base> 只对
  // 它之后的元素生效，因此必须插在文档最前（doctype 之后）
  return html.replace(/^(<!doctype[^>]*>)?/i, (doctype = '') => `${doctype}${tag}`)
}

/**
 * 构造临时分享代理（/s/<id>/…）。
 *
 * 语义是「本地路径的代理」：不复制内容，每次请求按真实路径现读；目标移动或
 * 分享停用后链接失效（失效页文案区分三因，由调用方提供 gonePage）。
 *
 * 路由面（与壳的 ShareContentSource 协议对齐）：
 *   /s/<id>/api/meta                     名称/类型/标题
 *   /s/<id>/api/doc                      文件分享：文档原文
 *   /s/<id>/assets/<rel>                 文件分享：与文档同目录的资产
 *   /s/<id>/api/tree                     目录分享：目录树
 *   /s/<id>/api/search-index             目录分享：搜索索引
 *   /s/<id>/docs/<rel>.md                目录分享：文档原文
 *   /s/<id>/<rel>                        目录分享：目录内静态资产
 *   其余                                  壳入口（前端路由）
 *
 * @param {object} options
 * @param {object} options.shares 分享服务（resolveShare / buildIndex）
 * @param {(res) => void} options.serveShell 壳入口应答（分享前缀下由调用方决定是否注入 base）
 * @param {() => Promise<{tree: object, searchIndex: object}|null>} [options.buildIndex]
 *   目录索引构建器；不注入时回落到现场扫描（桌面端无 docs-core 索引语料）
 * @param {(reason: string, kind?: string) => string} [options.gonePage]
 */
export function createShareProxy({ shares, serveShell, buildIndex, gonePage }) {
  return async function handleShare(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' })
      return res.end()
    }
    const segments = pathname.split('/').filter(Boolean) // ['s', id, ...rest]
    const id = segments[1] ?? ''
    const resolved = shares.resolveShare(id)
    if (!id || resolved.error) {
      return sendText(
        res,
        404,
        gonePage ? gonePage(resolved.error, resolved.entry?.kind) : '分享不可用',
        'text/html; charset=utf-8',
      )
    }
    const { entry } = resolved
    let rest
    try {
      rest = segments.slice(2).map(decodeURIComponent)
    } catch {
      return sendText(res, 400, 'bad path')
    }
    const inner = rest.join('/')

    if (inner === 'api/meta') {
      return writeJson(res, 200, {
        id: entry.id,
        name: entry.name,
        kind: entry.kind,
        title: entry.kind === 'file' ? entry.name.replace(/\.md$/i, '') : entry.name,
      })
    }

    if (entry.kind === 'file') {
      if (inner === 'api/doc') {
        res.writeHead(200, {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Cache-Control': 'no-cache',
        })
        return createReadStream(entry.path).pipe(res)
      }
      // 文档同目录资产：/s/<id>/assets/<相对路径>（相对图片的落点，防穿越限同目录）
      if (rest[0] === 'assets' && rest.length >= 2) {
        const baseDir = entry.path.slice(0, Math.max(entry.path.lastIndexOf(sep), 0)) || '.'
        const target = resolveInRoot(baseDir, `/${rest.slice(1).join('/')}`)
        if (target && existsSync(target) && statSync(target).isFile()) return sendFile(res, target)
        return sendText(res, 404, 'asset not found')
      }
      return serveShell(res)
    }

    // dir 模式：迷你站点
    if (inner === 'api/tree' || inner === 'api/search-index') {
      let built
      try {
        built = buildIndex ? await shares.buildIndex(entry, buildIndex) : null
      } catch (error) {
        return writeJson(res, 500, { error: `目录索引失败：${error.message}` })
      }
      if (inner === 'api/tree') {
        if (built) return writeJson(res, 200, built.tree)
        // 无索引语料（桌面端）：现场扫描兜底，树仍可用
        try {
          return writeJson(res, 200, buildTreePayload(entry.path))
        } catch (error) {
          return writeJson(res, 500, { error: `目录索引失败：${error.message}` })
        }
      }
      // 搜索索引：无构建器时明确 404，壳据此隐藏搜索入口
      if (!built?.searchIndex) return writeJson(res, 404, { error: 'search-index-unavailable' })
      return writeJson(res, 200, built.searchIndex)
    }
    if (rest[0] === 'docs' && inner.endsWith('.md')) {
      const target = resolveInRoot(entry.path, `/${rest.slice(1).join('/')}`)
      if (!target || !existsSync(target) || !statSync(target).isFile()) {
        return sendText(res, 404, 'not found')
      }
      return sendFile(res, target)
    }
    // 目录内静态资产（图片等；.md 不走此路径）
    if (inner && !inner.startsWith('api/')) {
      const target = resolveInRoot(entry.path, `/${inner}`)
      if (target && !target.toLowerCase().endsWith('.md') && existsSync(target)) {
        if (statSync(target).isFile()) return sendFile(res, target)
      }
    }
    return serveShell(res)
  }
}
