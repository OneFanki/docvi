/**
 * 配置存储：/data/config.yaml 单文件两层结构（global + repos[]），仓库未显式
 * 覆盖的字段继承全局（PRD R8）。无数据库——容器重建从卷恢复全部状态（AC10）。
 */
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as yamlParse, stringify as yamlStringify } from 'yaml'

export const GLOBAL_DEFAULTS = {
  // webhook | poll | off：缺省 poll——单机/局域网部署开箱即自动同步；
  // 接入 GitLab 推送后可按仓库切 webhook（零延迟），off 则仅手动
  autoFetch: 'poll',
  fetchIntervalSec: 300,
  autoBuild: true,
  cleanupCron: '0 4 * * *',
  logTailLines: 200,
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/
// 保留段：壳资产与协议端点占用（docs = 文档原文 API 前缀、api = 运维 API、_ = 平台自渲染页、mcp = MCP 端点）
const RESERVED_SLUGS = new Set(['docs', 'api', 'assets', '_', 's', 'mcp'])
// file:// 供本地演练/deployer 自测使用；生产远端是 https/ssh
const URL_RE = /^(https?:\/\/|git@|ssh:\/\/|file:\/\/)/

/**
 * 粘贴配置的绝对路径防线（PRD R9）：配置必须假设本地也能用，引用文件系统绝对
 * 路径直接拒绝。只拦「真文件系统路径」——Windows 盘符，与 path/dir/root 键下的
 * POSIX 绝对值；nav link 这类站点路径（'/xxx'）是合法的，不拦。
 */
const ABS_FS_RE = /[A-Za-z]:[\\/]|(?:^|\n)\s*(?:path|dir|root)\s*:\s*['"]?\//
const WEBHOOK_SECRET_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

export function emptyConfig() {
  return { global: { ...GLOBAL_DEFAULTS }, repos: [], plugins: [] }
}

export function configPath(dataDir) {
  return join(dataDir, 'config.yaml')
}

export function loadConfig(dataDir) {
  const file = configPath(dataDir)
  if (!existsSync(file)) return emptyConfig()
  const raw = yamlParse(readFileSync(file, 'utf8')) ?? {}
  return normalizeConfig(raw)
}

export function saveConfig(dataDir, cfg) {
  writeFileSync(configPath(dataDir), yamlStringify(normalizeConfig(cfg)))
}

export function normalizeConfig(raw) {
  const cfg = emptyConfig()
  cfg.global = { ...GLOBAL_DEFAULTS, ...(raw?.global ?? {}) }
  cfg.repos = Array.isArray(raw?.repos) ? raw.repos.map(normalizeRepo) : []
  cfg.plugins = Array.isArray(raw?.plugins)
    ? raw.plugins.filter(p => p?.name).map(normalizePlugin)
    : []
  return cfg
}

/** 插件登记条目（设计见 docs/design/平台插件化与 AI 分发.md 五·config 扩展段） */
function normalizePlugin(raw) {
  return {
    name: String(raw?.name ?? ''),
    source: String(raw?.source ?? ''),
    version: String(raw?.version ?? ''),
    enabled: raw?.enabled !== false,
    builtin: raw?.builtin === true,
    credentialRef: String(raw?.credentialRef ?? ''),
    disabledComponents: Array.isArray(raw?.disabledComponents)
      ? raw.disabledComponents.map(String)
      : [],
  }
}

function normalizeRepo(raw) {
  return {
    slug: String(raw?.slug ?? ''),
    name: String(raw?.name || raw?.slug || ''),
    url: String(raw?.url ?? ''),
    branches:
      Array.isArray(raw?.branches) && raw.branches.length ? raw.branches.map(String) : ['main'],
    autoFetch: raw?.autoFetch ?? 'inherit',
    autoBuild: raw?.autoBuild ?? 'inherit',
    webhookSecret: String(raw?.webhookSecret ?? ''),
    contentOverride:
      typeof raw?.contentOverride === 'string' && raw.contentOverride.trim()
        ? raw.contentOverride
        : null,
  }
}

/** 校验面板/API 提交的仓库表单，返回错误列表（空数组 = 通过） */
export function validateRepoInput(input) {
  const errors = []
  if (!SLUG_RE.test(input.slug ?? ''))
    errors.push('slug 必须是小写字母/数字/连字符且不以连字符开头')
  else if (RESERVED_SLUGS.has(input.slug))
    errors.push(`slug ${input.slug} 是平台保留段（docs/api/assets/_/s/mcp），请换一个`)
  if (!String(input.name ?? '').trim()) errors.push('name 必填')
  if (!URL_RE.test(input.url ?? '')) errors.push('url 需为 http(s) 或 ssh 形式的 git 远端地址')
  if (
    typeof input.contentOverride === 'string' &&
    input.contentOverride.trim() &&
    ABS_FS_RE.test(input.contentOverride)
  ) {
    errors.push(
      '粘贴配置含文件系统绝对路径（Windows 盘符或 path/dir/root 下的 / 绝对值）——必须全部使用相对内容根的路径',
    )
  }
  return errors
}

/** 生成仓库 webhook secret（每仓唯一，泄露即可在面板重置） */
export function generateWebhookSecret() {
  const alphabet = WEBHOOK_SECRET_ALPHABET
  return Array.from(randomBytes(16), b => alphabet[b % alphabet.length]).join('')
}

/** 两层继承的生效值（PRD R8：仓库缺省 inherit） */
export const effAutoFetch = (repo, global) =>
  repo.autoFetch === 'inherit' ? global.autoFetch : repo.autoFetch
export const effAutoBuild = (repo, global) =>
  repo.autoBuild === 'inherit' ? global.autoBuild : repo.autoBuild

/** 白名单匹配：精确名 + 通配（`1.*` 匹配 1.3.0；`*` 跨段） */
export function branchInWhitelist(patterns, branch) {
  return (patterns ?? []).some(pattern => {
    if (pattern === branch) return true
    if (!pattern.includes('*')) return false
    const re = new RegExp(
      `^${pattern
        .split('*')
        .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*')}$`,
    )
    return re.test(branch)
  })
}

/** 轻量 5 段 cron 匹配（支持星号、数字、步进写法），只服务清理任务这种分钟级调度 */
export function cronMatches(expr, date) {
  const fields = String(expr).trim().split(/\s+/)
  if (fields.length !== 5) return false
  const values = [
    date.getMinutes(),
    date.getHours(),
    date.getDate(),
    date.getMonth() + 1,
    date.getDay(),
  ]
  return fields.every((field, i) => {
    if (field === '*') return true
    if (field.startsWith('*/')) {
      const step = Number(field.slice(2))
      return Number.isInteger(step) && step > 0 && values[i] % step === 0
    }
    return field.split(',').some(part => Number(part) === values[i])
  })
}
