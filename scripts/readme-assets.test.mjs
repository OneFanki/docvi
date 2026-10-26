/**
 * README 截图资产守卫。
 *
 * README 里的截图是最容易悄悄腐烂的东西：改了一版界面，图还是旧的；删了一张图，
 * README 里留着一个 404 的 img；加了一张图，却忘了写进 README。这些都不会让构建
 * 失败，只会在别人点开仓库首页时露出来。
 *
 * 所以这里锁四件事：
 *  1. README 引用的每张截图都真实存在（不出现死链）；
 *  2. 每张截图都被 README 用到（仓库里不留没人看的图）；
 *  3. 截图清单与 `scripts/capture-screenshots.mjs` 的 SHOTS 对齐——README 用到的
 *     一定能在脚本里重新生成，否则下次重拍就断供；
 *  4. 没有把个人机器路径、临时目录名之类的痕迹截进去（文件名层面只能查这些，
 *     像素层面靠人眼，但残留的临时路径会体现在文件名与脚本里）。
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const SHOT_DIR = join(root, 'docs/screenshots')
const readme = readFileSync(join(root, 'README.md'), 'utf8')
const captureScript = readFileSync(join(root, 'scripts/capture-screenshots.mjs'), 'utf8')

/** README 里引用的截图文件名 */
function referenced() {
  return [...readme.matchAll(/docs\/screenshots\/([\w.-]+\.png)/g)].map(match => match[1])
}

/** 磁盘上实际存在的截图 */
function onDisk() {
  if (!existsSync(SHOT_DIR)) return []
  return readdirSync(SHOT_DIR).filter(name => name.endsWith('.png'))
}

/** 截图脚本里登记的 shot 名字（SHOTS 数组的 name 字段） */
function declaredInScript() {
  return [...captureScript.matchAll(/name:\s*'([\w-]+)'/g)].map(match => match[1])
}

test('README 引用的截图全部存在', () => {
  const missing = referenced().filter(name => !existsSync(join(SHOT_DIR, name)))
  assert.deepEqual(missing, [], `README 引用了不存在的截图：${missing.join(', ')}`)
})

test('每张截图都在 README 里用到（不留孤儿图）', () => {
  const used = new Set(referenced())
  const orphans = onDisk().filter(name => !used.has(name))
  assert.deepEqual(orphans, [], `这些截图没有被 README 引用：${orphans.join(', ')}`)
})

test('README 用到的截图都能由截图脚本重新生成', () => {
  const declared = new Set(declaredInScript())
  const missing = referenced()
    .map(name => name.replace(/\.png$/, ''))
    .filter(name => !declared.has(name))
  assert.deepEqual(
    missing,
    [],
    `这些截图在 capture-screenshots.mjs 里没有登记：${missing.join(', ')}`,
  )
})

test('截图不是空文件（防止提交一张 0 字节的占位图）', () => {
  const empty = onDisk().filter(name => statSync(join(SHOT_DIR, name)).size < 4096)
  assert.deepEqual(empty, [], `这些截图太小、可能是坏图：${empty.join(', ')}`)
})

test('截图脚本使用无头模式（不能弹窗抢焦点）', () => {
  assert.match(
    captureScript,
    /DOCVI_HEADLESS:\s*'1'/,
    '截图脚本必须设置 DOCVI_HEADLESS=1：一次截图要开十几次应用，弹窗会打断正在用电脑的人',
  )
  assert.match(captureScript, /DOCVI_DATA_DIR:/, '截图必须用独立数据目录，绝不能碰用户的真实数据')
  assert.match(
    captureScript,
    /DOCVI_INSTANCE:/,
    '截图必须换应用名，否则单实例锁会让第二张图直接退出',
  )
})

test('截图脚本收尾会杀掉整棵进程树', () => {
  // Windows 上 Electron 会派生 GPU / utility / renderer，只 kill 主进程会留孤儿
  assert.match(captureScript, /taskkill/, '必须用 taskkill 清理')
  assert.match(captureScript, /\/T/, 'taskkill 必须带 /T 杀整组')
})

test('桌面端支持 DOCVI_HEADLESS 无头运行', () => {
  const mainSrc = readFileSync(join(root, 'apps/desktop/src/main/index.ts'), 'utf8')
  assert.match(mainSrc, /DOCVI_HEADLESS/, '主进程必须识别 DOCVI_HEADLESS')
  assert.match(mainSrc, /parkWindowOffscreen/, '无头模式下窗口应停到屏幕之外')
})

test('README 的外链域名必须在白名单内', () => {
  /*
   * 用**白名单**，不用禁用词清单。
   *
   * 黑名单有两个躲不开的毛病：一是写不全，漏掉一个就静默失效；二是被禁的词本身
   * 得写进仓库——等于把要保护的对象印在门牌上，谁翻代码都看得见我们想藏什么。
   * 白名单只列「允许出现在公开文档里的域名」，新增外链必须显式加一行，顺带强制
   * 一次「这个地址该不该对外」的判断。
   */
  const allowed = [
    'github.com',
    'img.shields.io',
    'vuejs.org',
    'www.electronjs.org',
    'localhost',
    '127.0.0.1',
  ]
  const hosts = [...readme.matchAll(/https?:\/\/([^\s)"'<>`/]+)/g)]
    // 去掉端口：`:8080` 与 `<port>` 这类占位都算同一 host
    .map(match => match[1].replace(/[:<].*$/, ''))
    .filter(host => host.length > 0)
  const offenders = [...new Set(hosts)].filter(host => !allowed.includes(host))
  assert.deepEqual(offenders, [], `README 出现了白名单之外的外链域名：${offenders.join('、')}`)
})

test('README 不含个人机器路径', () => {
  assert.doesNotMatch(
    readme,
    /[A-Z]:\\Users\\[^\\<\s]/i,
    'README 不应出现 Windows 用户目录下的具体账户路径',
  )
  assert.doesNotMatch(
    readme,
    /\/home\/[a-z][\w.-]+\//i,
    'README 不应出现 Linux 家目录下的具体账户路径',
  )
})
