import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 提交作用域自动发现。
 *
 * 包目录名即 scope：`packages/server` → `server`，`apps/desktop` → `desktop`。
 * 另登记固定 scope：root（跨包 / 仓库级配置）、deployer（容器编排服务）、
 * plugins（插件包目录）、scripts、docs、courses、tests、ci（工作流）。
 *
 * 为什么自动发现而不是硬编码白名单：新增包时无需改本文件——硬编码清单一旦忘记
 * 维护，要么误拦合法提交，要么静默放行任意字符串。
 */
const repositoryRoot = dirname(fileURLToPath(import.meta.url))

function listDirectories(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .filter(name => !name.startsWith('.') && name !== 'node_modules')
}

function discoverScopes() {
  const scopes = new Set([
    'root',
    'deployer',
    'plugins',
    'scripts',
    'courses',
    'docs',
    'tests',
    'ci',
  ])
  // packages/* 与 apps/* 的目录名都算合法 scope（apps/desktop → desktop）
  for (const workspace of ['packages', 'apps']) {
    for (const name of listDirectories(join(repositoryRoot, workspace))) scopes.add(name)
  }
  return [...scopes].sort()
}

/**
 * 主题描述首字符白名单：CJK 汉字或全角标点。
 * 中文仓库里若以拉丁字母/数字开头，`git log --oneline` 会出现中英视觉断层。
 * 只约束首字符，正文里的英文技术名词不受影响。
 */
const CJK_OR_FULLWIDTH_PUNCTUATION =
  /^[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff01-\uff5e]/

export default {
  extends: ['@commitlint/config-conventional'],
  plugins: [
    {
      rules: {
        'subject-first-char-cjk': parsed => {
          const subject = (parsed.subject ?? '').trim()
          if (subject === '') return [true, '']
          const firstChar = [...subject][0]
          const valid = CJK_OR_FULLWIDTH_PUNCTUATION.test(firstChar)
          return [
            valid,
            `主题描述必须以中文汉字或全角标点开头，禁止以拉丁字母/数字开头（当前开头：「${firstChar}」）`,
          ]
        },
      },
    },
  ],
  ignores: [
    commit =>
      commit.startsWith('Merge') || commit.startsWith('Revert') || commit.startsWith('fixup'),
  ],
  rules: {
    'type-enum': [
      2,
      'always',
      [
        'feat',
        'fix',
        'docs',
        'style',
        'refactor',
        'perf',
        'test',
        'build',
        'ci',
        'chore',
        'revert',
      ],
    ],
    'subject-empty': [2, 'never'],
    'scope-empty': [2, 'never'],
    'scope-enum': [2, 'always', discoverScopes()],
    'subject-first-char-cjk': [2, 'always'],
  },
}
