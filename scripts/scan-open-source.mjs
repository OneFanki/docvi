#!/usr/bin/env node
/**
 * 开源前的敏感内容扫描。
 *
 * 扫描范围是**要复制的这份代码**（git 跟踪的文件），不看 node_modules / .git。
 * 判据分三类：
 *  1. 凭证形态：真实 token / 私钥 / 带密码的 URL —— 一条都不能留（含历史）；
 *  2. 内部路径：个人机器绝对路径、公司仓路径 —— 别人 clone 后用不到，且暴露目录结构；
 *  3. 自定义禁用词：**具体是哪些词由本地清单给出，不写在本文件里**。
 *
 * 第 3 条为什么这样设计：如果把「某某公司」「某某内部代号」直接写成这里的正则，
 * 扫描器自己就成了泄露源——开源出去之后，读者能在规则表里读到本仓曾经属于谁。
 * 所以本文件只保留**通用的**凭证与路径规则；具体的组织标识等词放进
 * `.scan-deny.local`（已在 .gitignore，随机器走、不入仓）。清单是每行一组的正则。
 *
 * 用法：node scripts/scan-open-source.mjs [--verbose]
 *
 * 退出码：发现「高」风险项时为 1，方便直接接进 CI。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const verbose = process.argv.includes('--verbose')

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * 本地禁用词清单：每行一条正则（支持 `#` 注释与空行）。
 * 文件不存在时只跑通用规则，不算失败——开源仓的贡献者本来就没有这份清单。
 */
function localDenyRules() {
  const file = join(ROOT, '.scan-deny.local')
  if (!existsSync(file)) return []
  const rules = []
  for (const [index, line] of readFileSync(file, 'utf8').split('\n').entries()) {
    const text = line.trim()
    if (!text || text.startsWith('#')) continue
    try {
      rules.push({
        id: `deny-local-${index + 1}`,
        severity: 'high',
        label: '本地禁用词',
        re: new RegExp(text, 'gi'),
        hint: '换成中性的示例值',
      })
    } catch {
      console.warn(`[scan] .scan-deny.local 第 ${index + 1} 行不是合法正则，已跳过`)
    }
  }
  return rules
}

/** 规则表：每条给出类别、严重度、正则、说明与建议替换 */
const RULES = [
  {
    id: 'cred-url',
    severity: 'high',
    label: '带密码的 URL',
    re: /https?:\/\/[^\s:@/]+:[^\s@/]+@[^\s/]+/g,
    hint: '凭证只能来自环境变量，不能进仓',
    /**
     * 占位符豁免：文档与测试夹具会用 example.com 演示 URL 形态。
     * 只看主机名是否属于保留示例域，不靠行内标记——否则每个示例都得挂注释。
     */
    allow: match => /@(?:[\w-]+\.)*example\.(?:com|org|net)\b/i.test(match),
  },
  {
    id: 'cred-token',
    severity: 'high',
    label: '疑似真实凭证赋值',
    re: /\b(?:OPS_TOKEN|GIT_CREDENTIALS|API_KEY|ACCESS_TOKEN|SECRET_KEY)\s*=\s*(?!change-me|\$\{|<|$|''|"")\S{12,}/g,
    hint: '示例值请用 change-me / ${VAR} 形态',
  },
  {
    id: 'cred-private-key',
    severity: 'high',
    label: '私钥块',
    re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g,
    hint: '私钥绝不能进仓',
  },
  {
    id: 'cred-cloud',
    severity: 'high',
    label: '云厂商密钥形态',
    re: /\b(?:AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,})\b/g,
    hint: '轮换并改用环境变量',
  },
  {
    id: 'path-personal',
    severity: 'low',
    label: '个人机器绝对路径',
    /*
     * 只认「Windows 用户目录下的具体账户名」。`C:\Users\Public` 是所有用户共享的
     * 系统目录（截图脚本刻意用它落地演示工作区，好让状态栏显示一个中性路径），
     * 不是个人信息——用豁免表排除它，规则本身保持不变。
     */
    re: /[A-Z]:[\\/]Users[\\/][A-Za-z0-9._-]+/g,
    hint: '文档里改用相对路径或 <数据目录>',
    allow: match => /[\\/]Users[\\/](?:Public|Default|All Users)$/i.test(match),
  },
]

// 本地禁用词追加在内置规则之后：与内置规则同权，命中即报
RULES.push(...localDenyRules())

/** 每行允许的行内豁免标记（评审时显式说明「这条是示例/占位」） */
const ALLOW_MARK = 'scan-allow'

function listTracked() {
  return execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean)
}

/** 二进制文件按扩展名跳过：只扫文本 */
const BINARY_EXT =
  /\.(png|jpe?g|gif|webp|ico|icns|woff2?|ttf|otf|pdf|zip|gz|tgz|mp3|wav|mp4|mov|wasm|exe|dll|node)$/i

const findings = []

/**
 * 扫描器自身必须跳过：规则表里就写着要找的词，不自指豁免的话每轮都报自己。
 * 用文件名而不是行内标记——规则表本身不该被标记污染。
 */
const SELF_FILE = 'scripts/scan-open-source.mjs'

for (const file of listTracked()) {
  if (file === SELF_FILE) continue
  if (BINARY_EXT.test(file)) continue
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  if (text.includes('\0')) continue
  const lines = text.split('\n')
  for (const [index, line] of lines.entries()) {
    if (line.includes(ALLOW_MARK)) continue
    for (const rule of RULES) {
      rule.re.lastIndex = 0
      const match = rule.re.exec(line)
      if (!match) continue
      if (rule.allow?.(match[0])) continue
      findings.push({
        file,
        line: index + 1,
        rule,
        match: match[0],
        text: line.trim().slice(0, 160),
      })
    }
  }
}

/** 按严重度 + 规则聚合，输出先给结论再给明细 */
const order = { high: 0, medium: 1, low: 2 }
findings.sort(
  (a, b) => order[a.rule.severity] - order[b.rule.severity] || a.file.localeCompare(b.file),
)

const counts = findings.reduce((acc, item) => {
  acc[item.rule.severity] = (acc[item.rule.severity] ?? 0) + 1
  return acc
}, {})

console.log(
  `扫描 ${listTracked().length} 个跟踪文件：高 ${counts.high ?? 0} / 中 ${counts.medium ?? 0} / 低 ${counts.low ?? 0}`,
)

let currentSeverity = null
for (const item of findings) {
  if (item.rule.severity !== currentSeverity) {
    currentSeverity = item.rule.severity
    console.log(
      `\n## ${currentSeverity === 'high' ? '高' : currentSeverity === 'medium' ? '中' : '低'}风险`,
    )
  }
  console.log(`${item.file}:${item.line}  [${item.rule.label}]  ${item.match}`)
  if (verbose) console.log(`    ${item.text}`)
}

if (!findings.length) console.log('\n未发现敏感内容。')

process.exit(counts.high ? 1 : 0)
