import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname } from 'node:path'

import type { ShareEntry } from '@docvi/shared'

import { dispatch, type McpDeps } from '../../../../packages/server/src/mcp.mjs'

/**
 * 服务进程的 HTTP 面。
 *
 * 三条路由：
 *  - `POST /mcp`   MCP 端点（Bearer 令牌；本机监听但仍要求令牌——防同机其它进程误连）
 *  - `GET  /s/<id>[/...]` 临时分享（链接即凭证：16 位随机 id 不可枚举）
 *  - `GET  /health` 健康检查（不带敏感信息，供端口探测与诊断）
 *
 * 令牌只对 MCP 生效：分享链接要能直接粘给别人，不能再要求额外凭证。
 */

const MCP_BODY_LIMIT = 256 * 1024
const SHARE_ID_RE = /^[a-f0-9]{16}$/

/** 可直出的静态类型：分享里的图片/PDF 等，不执行任何脚本 */
const ASSET_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
}

/** 分享路由真正用到的字段：url 由 store 在 list() 时拼（端口/局域网会变），路由不需要它 */
export type ShareTarget = Pick<ShareEntry, 'id' | 'path' | 'kind' | 'createdAt'>

export interface ShareLookup {
  list(): ShareEntry[]
  /** id → 记录；不存在返回 undefined */
  find(id: string): ShareTarget | undefined
}

export interface HttpOptions {
  token: string
  mcp: McpDeps
  shares: ShareLookup
  /** 读分享目标里的相对文件（目录分享）或整文件（文件分享） */
  readShareFile(
    share: ShareTarget,
    relPath: string,
  ): Promise<{ body: Buffer; type: string } | 'not-found'>
  /** 渲染一篇分享文档为 HTML（由调用方决定排版与主题） */
  renderShareDoc(share: ShareTarget, relPath: string): Promise<string | null>
  /** 分享根目录的导航（目录分享的首页）；文件分享返回 null */
  renderShareIndex(share: ShareTarget): Promise<string | null>
  log(level: 'info' | 'warn' | 'error', message: string): void
}

function send(res: ServerResponse, status: number, type: string, body: string | Buffer): void {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    // 分享页含用户内容：禁止被嵌入任意站点，也禁止嗅探类型
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'no-referrer',
  })
  res.end(body)
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(payload))
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    let settled = false
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      if (settled) return
      size += chunk.length
      if (size > limit) {
        settled = true
        reject(new Error('请求体超过大小上限'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', error => {
      if (settled) return
      settled = true
      reject(error)
    })
  })
}

/** 常量时间比较令牌（长度先比；两者长度不同直接拒绝） */
function tokenMatches(header: string | undefined, token: string): boolean {
  const prefix = 'Bearer '
  if (!header || !header.startsWith(prefix)) return false
  const provided = header.slice(prefix.length)
  if (provided.length !== token.length) return false
  let diff = 0
  for (let i = 0; i < token.length; i += 1) {
    diff |= provided.charCodeAt(i) ^ token.charCodeAt(i)
  }
  return diff === 0
}

/** 分享 URL 解析：/s/<id> 后面是可选相对路径（URL 解码 + 拆段） */
function parseSharePath(url: string): { id: string; rel: string[] } | null {
  const match = /^\/s\/([a-f0-9]{16})(?:\/(.*))?$/.exec(url)
  if (!match) return null
  const id = match[1] as string
  const raw = match[2] ?? ''
  const segments: string[] = []
  for (const part of raw.split('/')) {
    if (!part) continue
    let decoded: string
    try {
      decoded = decodeURIComponent(part)
    } catch {
      return null
    }
    if (decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\')) {
      return null
    }
    segments.push(decoded)
  }
  return { id, rel: segments }
}

export function createHttpServer(options: HttpOptions): Server {
  const server = createServer((req, res) => {
    void handle(req, res).catch(error => {
      options.log('error', `请求处理失败：${(error as Error).message}`)
      if (!res.headersSent) sendJson(res, 500, { error: '内部错误' })
    })
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? '/'
    const path = url.split('?')[0] ?? '/'

    if (path === '/health') {
      sendJson(res, 200, { ok: true, service: 'docvi' })
      return
    }

    if (path === '/mcp') {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST')
        sendJson(res, 405, { error: '只接受 POST' })
        return
      }
      if (!tokenMatches(req.headers.authorization, options.token)) {
        // 401 不提示令牌是否正确，只说缺失：避免给探测者额外信息
        res.setHeader('WWW-Authenticate', 'Bearer')
        sendJson(res, 401, { error: '缺少或无效的访问令牌' })
        return
      }
      let raw: string
      try {
        raw = await readBody(req, MCP_BODY_LIMIT)
      } catch {
        sendJson(res, 413, { error: '请求体超过大小上限' })
        return
      }
      let message: unknown
      try {
        message = JSON.parse(raw)
      } catch {
        sendJson(res, 400, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: '解析失败' },
        })
        return
      }
      if (Array.isArray(message)) {
        sendJson(res, 400, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32600, message: '不支持批量请求' },
        })
        return
      }
      const outcome = dispatch(message, options.mcp)
      if (outcome.kind === 'notification') {
        res.writeHead(202)
        res.end()
        return
      }
      // 已通过 dispatch 的形态校验：对象且带合法 jsonrpc/method；id 可能缺省（此时
      // 早被 dispatch 判为通知），故这里直接取属性
      const id = (message as { id?: unknown }).id ?? null
      if (outcome.kind === 'error') {
        sendJson(res, 200, {
          jsonrpc: '2.0',
          id,
          error: { code: outcome.code, message: outcome.message },
        })
        return
      }
      sendJson(res, 200, { jsonrpc: '2.0', id, result: outcome.result })
      return
    }

    const sharePath = parseSharePath(path)
    if (sharePath) {
      const share = options.shares.find(sharePath.id)
      if (!share) {
        send(res, 404, 'text/plain; charset=utf-8', '分享不存在或已失效')
        return
      }
      // 文件分享：根路径直接渲染该文件；子路径一律 404（文件分享没有子资源）
      if (share.kind === 'file') {
        if (sharePath.rel.length) {
          send(res, 404, 'text/plain; charset=utf-8', '分享不存在')
          return
        }
        const html = await options.renderShareDoc(share, '')
        if (html === null) {
          send(res, 404, 'text/plain; charset=utf-8', '文件不存在或不可读')
          return
        }
        send(res, 200, 'text/html; charset=utf-8', html)
        return
      }

      if (sharePath.rel.length === 0) {
        const index = await options.renderShareIndex(share)
        if (index === null) {
          send(res, 404, 'text/plain; charset=utf-8', '目录为空或不可读')
          return
        }
        send(res, 200, 'text/html; charset=utf-8', index)
        return
      }

      const rel = sharePath.rel.join('/')
      const ext = extname(rel).toLowerCase()

      // Markdown 文档：服务端渲染成完整页面；链接可直接省略 .md 扩展名
      if (ext === '.md' || ext === '') {
        const html = await options.renderShareDoc(share, rel)
        if (html !== null) {
          send(res, 200, 'text/html; charset=utf-8', html)
          return
        }
        // 目标不存在 / 目录没有落地页：是「没有这个文档」，不是「不允许访问」
        send(res, 404, 'text/plain; charset=utf-8', '文档不存在')
        return
      }

      // 其它类型：只放行图片/PDF/纯文本，且必须在分享目录内
      const type = ASSET_TYPES[ext]
      if (!type) {
        send(res, 403, 'text/plain; charset=utf-8', '不允许访问该类型文件')
        return
      }
      const asset = await options.readShareFile(share, rel)
      if (asset === 'not-found') {
        send(res, 404, 'text/plain; charset=utf-8', '文件不存在')
        return
      }
      send(res, 200, type, asset.body)
      return
    }

    send(res, 404, 'text/plain; charset=utf-8', '未找到')
  }

  return server
}

export { SHARE_ID_RE, MCP_BODY_LIMIT }
