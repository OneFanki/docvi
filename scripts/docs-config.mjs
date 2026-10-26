/**
 * docs.config.yaml —— 内容根配置协议（node 侧包装）。
 *
 * 解析/校验逻辑已收敛到 scripts/lib/docs-core.mjs（零 node 依赖，多宿主共用）；
 * 本文件保留 node 专属的启动目标解析（resolveLaunchTarget）与聚合合并/序列化，
 * 并把核心函数以 node fs IO 绑定后按原签名导出（既有调用点零改动）。
 *
 * 三种内容根形态（部署器与本地调试共用同一套解析）：
 * - courses    平台缺省示例根（pnpm dev）；
 * - standalone 纯外部：传目录（内含 docs.config.yaml）或传 yaml + --standalone；
 * - aggregate  聚合：传 yaml 文件（默认），内置示例与外部内容合并。
 */
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { stringify } from 'yaml'
import { nodeIO } from './lib/fs-io-node.mjs'
import {
  DOCS_CONFIG_FILENAME,
  INDEX_BASENAMES,
  isHiddenDirName,
  loadDocsConfig as loadDocsConfigCore,
  minimalConfigTemplate,
  toPosixPath,
} from './lib/docs-core.mjs'

export {
  DOCS_CONFIG_FILENAME,
  INDEX_BASENAMES,
  isHiddenDirName,
  minimalConfigTemplate,
  toPosixPath,
}

/** 聚合模式的运行时链接根（相对平台仓根；启动器创建，gitignore） */
export const AGGREGATE_ROOT = '.docvi'
export const AGGREGATE_BUILTIN_PREFIX = 'built-in'
export const AGGREGATE_EXTERNAL_PREFIX = 'external'

/**
 * 读取并归一化内容根配置（node fs）；无 docs.config.yaml 时返回 null。
 * @param root 内容目录
 * @param filename 配置文件名（默认 docs.config.yaml；聚合/指定文件时可传其他名字）
 */
export function loadDocsConfig(root, filename = DOCS_CONFIG_FILENAME) {
  return loadDocsConfigCore(root, nodeIO, filename)
}

/**
 * 解析启动目标 → 启动模式（纯函数，供部署器与测试使用）。
 *
 * 目标优先级：显式 target > DOCS_ROOT 环境变量 > 缺省 courses。
 * - target 以 .yaml/.yml 结尾 → yaml 配置文件：默认 aggregate，--standalone 切 standalone；
 * - target 为目录 → standalone（目录内必须有 docs.config.yaml，否则报错并给模板）；
 * - 无 target 且无 DOCS_ROOT → courses。
 *
 * 返回 { mode, dir?, yamlPath?, error? }；error 非空时其余字段无意义。
 */
export function resolveLaunchTarget({ target, standalone = false, envDocsRoot = '' } = {}) {
  const raw = (target ?? envDocsRoot ?? '').trim()
  if (!raw) return { mode: 'courses' }

  const abs = isAbsolute(raw) ? raw : resolve(raw)
  if (/\.(ya?ml)$/i.test(abs)) {
    if (!existsSync(abs)) return { error: `yaml 配置不存在: ${abs}` }
    return {
      mode: standalone ? 'standalone' : 'aggregate',
      kind: 'yaml',
      dir: dirname(abs),
      yamlPath: abs,
    }
  }

  if (!existsSync(abs)) return { error: `内容目录不存在: ${abs}` }
  if (!existsSync(join(abs, DOCS_CONFIG_FILENAME))) {
    return { error: `目录 ${abs} 下没有 ${DOCS_CONFIG_FILENAME}\n${minimalConfigTemplate()}` }
  }
  return { mode: 'standalone', kind: 'dir', dir: abs }
}

/**
 * 聚合两份配置：外部内容在前、内置示例垫底，各自树根/排除/静态目录加链接前缀。
 *
 * @param builtin { config, raw, prefix } —— 平台自带（prefix = 'built-in'）
 * @param external { config, raw, prefix } —— 外部 yaml（prefix = 'external'）
 * 标题/描述/导航/死链策略：外部声明了就用外部的，否则回退内置。
 * 返回的路径全部相对聚合链接根（.docvi/），可直接写盘为该目录的 docs.config.yaml。
 */
export function mergeConfigs({ builtin, external }) {
  const b = builtin.config
  const e = external.config
  const withPrefix = (prefix, entry) => `${prefix}/${entry}`
  return {
    title: e.title || b.title,
    description: e.description || b.description,
    nav: e.nav.length ? e.nav : b.nav,
    deadLinks: e.deadLinks === 'strict' || b.deadLinks === 'strict' ? 'strict' : 'lenient',
    sidebar: [
      ...e.sidebar.map(entry => ({ ...entry, path: withPrefix(external.prefix, entry.path) })),
      ...b.sidebar.map(entry => ({ ...entry, path: withPrefix(builtin.prefix, entry.path) })),
    ],
    exclude: [
      ...b.exclude.map(entry => withPrefix(builtin.prefix, entry)),
      ...e.exclude.map(entry => withPrefix(external.prefix, entry)),
    ],
    staticDirs: [
      ...b.staticDirs.map(entry => withPrefix(builtin.prefix, entry)),
      ...e.staticDirs.map(entry => withPrefix(external.prefix, entry)),
    ],
  }
}

/** 聚合配置 → 写入链接根的 docs.config.yaml 文本（聚合模式的落盘形态） */
export function serializeAggregateConfig(config) {
  return stringify(config, { lineWidth: 0 })
}
