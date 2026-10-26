/**
 * 临时分享服务（内容不复制、按真实路径实时读取；设计见 docs/design/平台临时分享.md）。
 *
 * 与宿主的唯一差异在这里收口：
 * - 共享根（`shareRoots`）为空 = 桌面 app 模式：分享目标由用户在本机文件选择器里显式挑选，
 *   不再做根目录约束（本来就没有「运维面泄露」的攻击面）。
 * - 共享根非空 = 容器模式：目标必须落在挂载进来的共享目录内。
 *
 * 存储：`<dataDir>/shares.json`（高频增删、生命周期独立于平台配置）。
 * 兼容：容器旧版用 YAML（shares.yaml），读到则按旧格式解析、下次写入自动转 JSON。
 * 审计：`audit(type, payload)` 由宿主注入（容器写 audit.log，桌面可空实现）。
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import { parse as yamlParse } from 'yaml'

/** 分享 id：16 位 hex（不可枚举；随机 64bit） */
export const SHARE_ID_RE = /^[a-f0-9]{16}$/

export class ShareError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

/** Windows 盘符路径大小写不敏感；路径比较用归一后的 key */
function pathKey(path) {
  const resolved = resolve(path)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/**
 * @param {object} options
 * @param {string} options.dataDir 数据目录（shares.json 落点）
 * @param {string[]} [options.shareRoots] 允许分享的根目录；空数组 = 不限制（桌面模式）
 * @param {(type: string, payload: object) => void} [options.audit] 审计回调
 */
export function createSharesService({ dataDir, shareRoots = [], audit = () => {} }) {
  const file = join(dataDir, 'shares.json')
  const legacyFile = join(dataDir, 'shares.yaml')
  const roots = shareRoots.map(root => resolve(root))
  const restrict = roots.length > 0

  function load() {
    if (existsSync(file)) {
      try {
        const data = JSON.parse(readFileSync(file, 'utf8')) ?? {}
        return {
          // 保留整份文档：port / lan 等宿主字段不能因为一次分享增删被抹掉
          ...data,
          shares: Array.isArray(data.shares) ? data.shares.filter(s => s?.id && s?.path) : [],
        }
      } catch {
        // 损坏的 shares.json 不阻塞服务启动：按空列表处理，后续写入会覆盖
        return { shares: [] }
      }
    }
    // 容器旧版存储：读到 YAML 就按旧格式解析（下次写入转 JSON）
    if (existsSync(legacyFile)) {
      try {
        const data = yamlParse(readFileSync(legacyFile, 'utf8')) ?? {}
        return {
          shares: Array.isArray(data.shares) ? data.shares.filter(s => s?.id && s?.path) : [],
        }
      } catch {
        return { shares: [] }
      }
    }
    return { shares: [] }
  }

  function save(data) {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(file, `${JSON.stringify({ ...data, shares: data.shares }, null, 2)}\n`, 'utf8')
  }

  /** 目标必须在任一共享根内（含根自身）；桌面模式恒真 */
  function insideRoot(target) {
    if (!restrict) return true
    const key = pathKey(target)
    return roots.some(root => {
      const rootKey = pathKey(root)
      return key === rootKey || key.startsWith(rootKey + sep)
    })
  }

  /** 列表（附运行时状态：目标是否仍存在——链接失效的判据） */
  function list() {
    return load().shares.map(entry => {
      const exists = existsSync(entry.path)
      return {
        ...entry,
        exists,
        isDir: exists ? statSync(entry.path).isDirectory() : null,
      }
    })
  }

  /** 创建：校验共享根与存在性；kind 按实际类型自动判定（file=单文档 / dir=迷你站点） */
  function create({ path, name }) {
    const raw = String(path ?? '').trim()
    if (!raw) throw new ShareError('PATH_REQUIRED', 'path 必填')
    const abs = resolve(raw)
    if (!insideRoot(abs)) {
      throw new ShareError(
        'OUTSIDE_ROOTS',
        `路径必须在共享根内（${roots.join('、')}）——本机路径请先挂载进容器再分享`,
      )
    }
    if (!existsSync(abs)) throw new ShareError('TARGET_MISSING', `路径不存在：${abs}`, 404)
    const stat = statSync(abs)
    const kind = stat.isDirectory() ? 'dir' : 'file'
    const entry = {
      id: randomBytes(8).toString('hex'),
      name: String(name ?? '').trim() || basename(abs),
      path: abs,
      kind,
      enabled: true,
      createdAt: new Date().toISOString(),
    }
    const data = load()
    data.shares.push(entry)
    save(data)
    audit('share.create', { id: entry.id, path: abs, kind })
    return entry
  }

  function toggle(id, enabled) {
    const data = load()
    const entry = data.shares.find(s => s.id === id)
    if (!entry) throw new ShareError('NOT_FOUND', `分享不存在：${id}`, 404)
    entry.enabled = Boolean(enabled)
    save(data)
    audit('share.toggle', { id, enabled: entry.enabled })
    return entry
  }

  function remove(id) {
    const data = load()
    const before = data.shares.length
    data.shares = data.shares.filter(s => s.id !== id)
    if (data.shares.length === before) throw new ShareError('NOT_FOUND', `分享不存在：${id}`, 404)
    save(data)
    audit('share.remove', { id })
    return { ok: true }
  }

  /** 解析（公开访问路径用）：不存在/未启用/目标消失都返回明确原因 */
  function resolveShare(id) {
    if (!SHARE_ID_RE.test(String(id ?? ''))) return { error: 'not-found' }
    const entry = load().shares.find(s => s.id === id)
    if (!entry) return { error: 'not-found' }
    if (!entry.enabled) return { error: 'disabled', entry }
    if (!existsSync(entry.path)) return { error: 'missing', entry }
    return { entry, stat: statSync(entry.path) }
  }

  /**
   * 目录分享的树 + 搜索索引（5 秒 TTL 缓存）。
   * 容器注入 docs-core 的 buildDocsIndex（带搜索）；桌面不注入时由 httpd 回落到
   * share-site 的现场扫描（无搜索，壳自动隐藏搜索框）。
   */
  const indexCache = new Map()
  async function buildIndex(entry, buildDocsIndex) {
    const cached = indexCache.get(entry.id)
    if (cached && Date.now() - cached.at < 5000) return cached.built
    const built = await buildDocsIndex(entry.path, { autoscan: true })
    indexCache.set(entry.id, { at: Date.now(), built })
    return built
  }

  /** 内容指纹（诊断用：路径 + mtime） */
  function fingerprint(path) {
    return `${resolve(path)}:${statSync(path).mtimeMs}`
  }

  return {
    list,
    create,
    toggle,
    remove,
    resolveShare,
    buildIndex,
    fingerprint,
    shareRoots: roots,
  }
}
