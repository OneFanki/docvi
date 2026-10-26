/**
 * 运维页内联脚本的编译回归（对应 2026-10-13 实缺陷）：
 * 页面把整段 inline <script> 嵌在 portal.mjs 的模板字面量里，引号/反斜杠
 * 转义失误会产出语法错误——整段脚本静默不执行（页面永远「加载中…」、
 * 按钮点击无反应、也不发请求）。vm.Script 只编译不执行，可把这类错误
 * 挡在提交前；同时锁定「内联脚本一律事件委托、不用 onclick 拼串」的约定。
 *
 * 统一模型（2026-10-14）：门户退场（首页由壳渲染），本文件只保留运维页。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { opsHtml } from '../src/portal.mjs'

function scriptsOf(html) {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1])
}

test('运维页的内联脚本全部可编译', () => {
  const html = opsHtml()
  const scripts = scriptsOf(html)
  assert.ok(scripts.length > 0, '应含内联脚本')
  for (const code of scripts) {
    assert.doesNotThrow(
      () => new vm.Script(code, { filename: '运维页内联脚本' }),
      '内联脚本应可编译',
    )
  }
})

test('运维页：事件委托约定（无内联 onclick）+ 凭证字段 + URL 自动提取 + 保留段提示', () => {
  const html = opsHtml()
  assert.ok(!/onclick=/.test(html), '不得使用内联 onclick（模板字面量引号转义坑源）')
  assert.ok(!/\son[a-z]+=/.test(html), '不得使用任何内联事件属性')
  assert.match(html, /f-git-user/)
  assert.match(html, /f-git-pass/)
  assert.match(html, /repoNameFromUrl/, '应含 URL → 仓库名提取')
  assert.match(html, /data-act=/)
  assert.match(html, /保留段/, 'slug 保留段提示应在表单说明里')
})

test('运维页：运维 token 就地输入行 + 统一存储键（401 死路回归）', () => {
  const html = opsHtml()
  // 死路根因回归：页内必须有 token 输入行（此前只有 prompt，输错后无入口）
  assert.match(html, /id="tokenRow"/, '应含 token 输入行')
  assert.match(html, /id="f-token"/, '应含 token 密码输入框')
  assert.match(html, /function showTokenRow/, '应含 showTokenRow（401 自动展开）')
  assert.match(html, /res\.status === 401/, '401 时应展开 token 行')
  // 统一存储键：与文档站同键（at-ops-token），兼容读取旧键 deployer:token
  assert.match(html, /const TOKEN_KEY = 'at-ops-token'/, '应使用统一存储键')
  assert.match(html, /deployer:token/, '应兼容读取旧键')
  // 生态整治：不再用浏览器 prompt 收 token（阻塞式、无重输入口的旧实现）
  assert.ok(!/prompt\('输入运维 token/.test(html), '不得再用 prompt 收运维 token')
})

test('运维页：管理区结构级门禁（无 token 连 tabs 与面板都不放出）', () => {
  const html = opsHtml()
  // 管理区整块默认 hidden：鉴权成功才由脚本放出（showOpsBody），401 立即收回（hideOpsBody）
  assert.match(
    html,
    /<div id="opsBody" hidden>/,
    '管理区容器默认隐藏（安全缺省：新增面板天然在门禁内）',
  )
  assert.match(html, /function showOpsBody/, '应含 showOpsBody（鉴权成功放出）')
  assert.match(html, /function hideOpsBody/, '应含 hideOpsBody（401 收回）')
  // 门禁覆盖全部面板与 tabs：opsBody 必须包住 tabs 与全部面板、缺一即结构泄漏
  const gate = html.slice(
    html.indexOf('<div id="opsBody"'),
    html.indexOf('</div><!-- /opsBody -->'),
  )
  assert.ok(gate.includes('class="tabs"'), 'tabs 在门禁内')
  for (const panel of [
    'panel-repos',
    'panel-plugins',
    'panel-shares',
    'panel-config',
    'panel-builds',
    'panel-audit',
  ]) {
    assert.ok(gate.includes(`id="${panel}"`), `${panel} 在门禁内`)
  }
})

test('运维页：临时分享面板（代理语义说明 + 创建/复制/停用/撤销）', () => {
  const html = opsHtml()
  assert.match(html, /id="panel-shares"/, '分享面板存在')
  assert.match(html, /btn-share-add/, '有「生成分享链接」入口')
  assert.match(html, /s-path/, '路径输入（共享根内）')
  assert.match(html, /内容不会被复制/, '代理语义说明（不复制、路径变化即失效）')
  assert.match(html, /SHARE_ROOTS/, '共享根配置说明')
  assert.match(html, /data-share-act="copy"/, '复制链接动作')
  assert.match(html, /data-share-act="disable"/, '停用动作')
  assert.match(html, /data-share-act="remove"/, '撤销动作')
  assert.match(html, /目标已消失/, '目标消失的状态标注')
})

test('运维页：插件面板（协议 v1.1——折叠概览/显示名/示例预览/启停/同名冲突/卸载确认）', () => {
  const html = opsHtml()
  assert.match(html, /id="panel-plugins"/, '插件面板存在')
  assert.match(html, /id="modal-plugin"/, '添加插件弹窗存在')
  assert.match(html, /btn-open-plugin/, '有「添加插件」入口')
  assert.match(html, /p-source/, '来源输入（url: 渠道）')
  assert.match(html, /p-credential/, '凭证可选输入')
  assert.match(html, /同名冲突项/, '组件行标注同名冲突对家')
  assert.match(html, /将停用其他同名实现/, '手动开启冲突方的确认文案（列明对家）')
  assert.match(html, /comp-enable/, '组件级开启动作')
  assert.match(html, /comp-disable/, '组件级停用动作')
  assert.match(html, /预设包随平台版本分发，可禁用不可卸载/, '预设包卸载禁用语义')
  assert.match(html, /确认卸载/, '第三方卸载有确认段')
  assert.match(html, /刷新文档页后生效/, '启停/安装提示刷新生效')
  // v1.1：折叠概览 + 显示名 + 示例预览 + 本地化字段解析
  // 展开态用「记录主动收起」的反向集合：默认展开才能让「预览」入口在首屏可见
  assert.match(html, /collapsedPlugins/, '插件卡有折叠态集合（默认展开）')
  assert.match(html, /toggle-open/, '包标题区可点展开/折叠')
  assert.match(html, /个同名冲突/, '折叠态冲突概览徽标')
  assert.match(html, /function lz\(/, '本地化字段解析（string 或 {lang: string}）')
  assert.match(html, /comp-title/, '组件行以显示名（title）为主展示')
  assert.match(html, /comp-kind/, 'kind 降为副标（文档标签可见可复制）')
  assert.match(html, /\/_\/preview\//, '组件示例预览入口（/ _/preview/<name>/<kind>）')
})

test('运维页：仓库列表呈现生效分支口径（默认标记 + 分支同步时间 + 规则）', () => {
  const html = opsHtml()
  assert.match(html, /isDefault/, '应渲染默认分支标记')
  assert.match(html, /buildAt/, '应渲染分支索引时间')
  assert.match(html, /fmtTime/, '应有时间格式化')
  assert.match(html, /规则：/, '应展示白名单规则')
  assert.match(html, /设为默认/, 'switch 动作改名为「设为默认」')
})

test('运维页：仓库级「同步」按钮 + 分支行「重建索引」（更新/刷新合并）', () => {
  const html = opsHtml()
  assert.match(html, /data-act="sync"/, '仓库头部有「同步」主按钮')
  assert.match(html, /\/sync'/, '同步走后端 sync 端点')
  assert.match(html, /重建索引/, '分支行动作为「重建索引」')
  assert.ok(!/>更新</.test(html), '不再有语义含糊的「更新」按钮')
  assert.ok(!/>刷新</.test(html), '不再有语义含糊的「刷新」按钮')
})

test('运维页：webhook 弹窗（推送地址展示 + 被动接收端说明）', () => {
  const html = opsHtml()
  assert.match(html, /id="modal-hook"/, 'webhook 用法弹窗存在')
  assert.match(html, /data-act="hook"/, '卡片有 webhook 入口')
  assert.match(html, /被动接收端/, '弹窗说明平台是被动接收端、需在 Git 平台侧配置')
  assert.match(html, /webhookSecret/, '推送地址含该仓库 secret')
  assert.match(html, /api\/webhooks\//, '推送地址为 /api/webhooks/<slug>')
})

test('运维页：时间按浏览器本地时区渲染（容器 UTC 下曾差 8 小时）', () => {
  const html = opsHtml()
  // 不得再直接切 ISO 串（UTC 字符串切片会把 UTC 当本地时间显示）
  assert.ok(!/replace\('T', ' '\)\.slice\(0, 16\)/.test(html), '不得再用 ISO 串切片做时间格式化')
  assert.match(html, /new Date\(iso\)/, '应按 Date 解析后取本地字段')
  assert.match(html, /getHours/, '应取本地小时字段')
})

test('运维页：自动同步口径（缺省 poll 选项在前）', () => {
  const html = opsHtml()
  assert.match(html, /自动同步/, '面板字段名为「自动同步」')
  assert.match(
    html,
    /<select id="g-autoFetch"><option>poll<\/option>/,
    '缺省选项为 poll（无需 webhook 开箱即同步）',
  )
})

test('运维页：仓库卡片布局 + 添加仓库弹窗（表单不再追加在列表后）', () => {
  const html = opsHtml()
  assert.match(html, /class="repo-item"/, '仓库用卡片渲染')
  assert.match(html, /id="modal-add"/, '添加仓库为独立弹窗')
  assert.match(html, /btn-open-add/, '卡片头部有「＋ 添加仓库」入口')
  assert.match(html, /data-close-add/, '弹窗有收起/取消出口')
  assert.match(html, /id="modal-cred"/, 'git 凭证改用弹窗（不再用 prompt）')
  assert.ok(!/prompt\('git 用户名/.test(html), '不得再用 prompt 收 git 凭证')
  assert.match(html, /repo-cloning/, '克隆中仓库有等待态')
  assert.match(html, /__repoRefreshTimer/, '克隆中自动刷新列表')
})

test('运维页：日志区块固定深色底变量（代码块不随正文反转）', () => {
  const html = opsHtml()
  assert.match(html, /--pre-bg/, '代码块底色走独立变量（不随 --text 反转）')
  assert.ok(!/color-mix\(in srgb, var\(--text\) 92%/.test(html), '不得再用 --text 混色做日志底色')
})

test('运维页：旧视觉已清除（无主题切换按钮 / 无 html.dark / 无 chip / 无紫色 / 无重复大标题带）', () => {
  const html = opsHtml()
  // 本次改造的反向断言：固定中性深色，不再提供手动明暗切换
  assert.ok(!/themeToggle/.test(html), '不得再有主题切换按钮')
  assert.ok(!/◐ 主题/.test(html), '不得再有「◐ 主题」按钮文案')
  assert.ok(!/at-theme/.test(html), '不得再读写主题偏好键 at-theme')
  assert.ok(!/html\.dark/.test(html), '不得再保留 html.dark 变量与类切换')
  assert.ok(!/class="chip"/.test(html), '不得再有 docs-studio 胶囊')
  // 紫色的旧品牌令牌彻底退场
  assert.ok(!/#6355d9|#5246bd|#8d80e8|#a59af0|rgba\(99, 85, 217/.test(html), '不得残留旧紫色令牌')
  // 页面级大标题带与顶栏重复：结构一并删除（不是隐藏）
  assert.ok(!/class="pageband"/.test(html), '不得再有重复的页面级标题带 .pageband')
  assert.ok(!/平台运维<\/h1>/.test(html), '不得再有「平台运维」页面大标题')
})

test('运维页：配色对齐桌面端 slate 中性深色（固定，不跟随明暗）', () => {
  const html = opsHtml()
  // 逐条对照 packages/renderer-core/src/styles/theme.css 的 :root[data-theme='slate']
  assert.match(html, /--bg: #14161a/, '底色为 slate 中性深色')
  assert.match(html, /--card: #181a1f/, '表面 1')
  assert.match(html, /--card-2: #1e2126/, '表面 2')
  assert.match(html, /--card-3: #24282e/, '表面 3')
  assert.match(html, /--line: #23262b/, '弱边框（line-soft）')
  assert.match(html, /--line-2: #2d3138/, '标准边框（line）')
  assert.match(html, /--line-3: #3b4048/, '强边框（border-strong）')
  assert.match(html, /--text: #e6e8ec/, '一级文本')
  assert.match(html, /--text-2: #c3c7ce/, '二级文本')
  assert.match(html, /--muted: #9298a2/, '弱化文本')
  assert.match(html, /--text-dim: #767c86/, '最低一档文本')
  assert.match(html, /--accent: #6f9fd8/, '强调色为中性蓝')
  assert.match(html, /--accent-strong: #8ab5e8/, '强调色 hover 档')
  assert.match(html, /--accent-fg: #0f1620/, '强调色上的前景')
  assert.match(html, /--ok: #63ab8b/, '成功色')
  assert.match(html, /--warn: #cba45f/, '警告色')
  assert.match(html, /--err: #d9736a/, '危险色')
  assert.match(html, /--pre-bg: #1e2126/, '代码块底色 = slate 的 code-bg')
  assert.match(html, /--radius-sm: 5px/, '圆角 sm 对齐主题（5px）')
  assert.match(html, /--radius-md: 7px/, '圆角 md 对齐主题（7px）')
  assert.match(html, /--radius-lg: 9px/, '圆角 lg 对齐主题（9px）')
  assert.match(html, /color-scheme: dark/, '声明深色 color-scheme（原生下拉/滚动条同源）')
  assert.ok(!/@media \(prefers-color-scheme: dark\)/.test(html), '不再按系统偏好切换主题')
  assert.match(html, /max-width: 1080px/, '页面最大宽度放宽到 1080px')
})

test('运维页：token 行用中性表面 + 左侧强调细线（不再有琥珀底色）', () => {
  const html = opsHtml()
  // 旧版 --warn-soft 的暖色底在整体中性深色里像一条告警横幅；令牌整体删除
  assert.ok(!html.includes('--warn-soft'), '不得再定义或使用 --warn-soft')
  const rule = html.slice(html.indexOf('.tokenrow {'), html.indexOf('.tokenrow.on'))
  assert.match(rule, /background: var\(--card-2\)/, 'token 行底色为中性表面 2')
  assert.match(rule, /border-left: 2px solid var\(--accent\)/, 'token 行左侧一条强调细线')
})

test('运维页：样式规则只消费主题令牌（颜色字面量只出现在 :root）', () => {
  const html = opsHtml()
  const css = html.slice(html.indexOf('<style>') + '<style>'.length, html.indexOf('</style>'))
  // 去掉令牌定义块后，规则体里不允许再出现任何颜色字面量（阴影/遮罩已在令牌里）
  const rules = css.replace(/:root \{[\s\S]*?\n {2}\}/, '')
  const literals = [...rules.matchAll(/#[0-9a-fA-F]{3,8}|rgba?\(/g)].map(match => match[0])
  assert.deepEqual(literals, [], '规则体不得出现硬编码颜色，一律走变量')
})

test('运维页：全文不再出现旧产品名 docs-studio（统一 docvi）', () => {
  const html = opsHtml()
  assert.ok(!/docs-studio/i.test(html), '页面输出不得出现 docs-studio 字样')
  assert.match(html, /<title>运维 · docvi<\/title>/, '页面标题统一为 docvi')
})

test('运维页：顶栏结构对齐应用（品牌 + 标题 / 右侧运维 token 入口带图标）', () => {
  const html = opsHtml()
  assert.match(html, /<header class="titlebar">/, '顶栏为应用式标题栏')
  const brandStart = html.indexOf('class="titlebar__brand"')
  const brandBlock = html.slice(brandStart, html.indexOf('</div>', brandStart))
  assert.match(brandBlock, /class="brandmark"/, '左侧是品牌标')
  assert.match(brandBlock, /class="titlebar__name">运维</, '品牌标旁是「运维」标题')
  // 页面只剩这一个语义标题（不再有与顶栏重复的「平台运维」大标题带）
  assert.equal((html.match(/<h1\b/g) || []).length, 1, '全文只有一个 h1（顶栏标题）')
  assert.ok(!/class="topbar"/.test(html), '不再保留旧 .topbar 结构')
  const start = html.lastIndexOf('<button', html.indexOf('id="showToken"'))
  const entry = html.slice(start, html.indexOf('</button>', start))
  assert.match(entry, /id="showToken"/, '右侧有 showToken 入口')
  assert.match(entry, /<svg/, '入口带图标（不是裸文字链）')
  assert.match(entry, /<span>运维 token<\/span>/, '入口带文字标签')
  assert.match(entry, /stroke-width="1\.7"/, '图标描边与 TitleBar 的 lucide 图标一致（1.7）')
  assert.match(html, /class="iconbtn"[\s\S]{0,400}stroke-width="1\.7"/, '返回首页为同规格图标按钮')
})

test('运维页：未解锁占位区（默认显示、与 opsBody 互斥、不泄露数据）', () => {
  const html = opsHtml()
  assert.match(html, /id="opsLocked"/, '应有未解锁占位区')
  assert.match(html, /btn-locked-token/, '占位区有「输入运维 token」按钮')
  assert.match(html, /OPS_TOKEN/, '占位区说明 token 来自部署时的 OPS_TOKEN')
  // 占位区必须在 #opsBody 之外（门禁内不渲染任何「未解锁」提示）
  const lockedStart = html.indexOf('id="opsLocked"')
  const gateStart = html.indexOf('<div id="opsBody"')
  assert.ok(lockedStart > 0 && lockedStart < gateStart, '占位区在管理区之前（位于门禁外）')
  const lockedBlock = html.slice(html.lastIndexOf('<div class="locked"', gateStart), gateStart)
  for (const field of ['repoList', 'pluginList', 'shareList', 'buildList', 'auditView']) {
    assert.ok(!lockedBlock.includes(`id="${field}"`), `占位区不得包含 ${field}`)
  }
  // 互斥切换：鉴权成功隐藏占位、401 / 收回时显示占位
  assert.match(
    html,
    /getElementById\('opsLocked'\)[^;]*;?\s*if \(locked\) locked\.hidden = true/,
    'showOpsBody 隐藏占位区',
  )
  assert.match(
    html,
    /getElementById\('opsLocked'\)[^;]*;?\s*if \(locked\) locked\.hidden = false/,
    'hideOpsBody 显示占位区',
  )
  const lockedBtn = html.slice(html.indexOf("document.getElementById('btn-locked-token')"))
  assert.match(lockedBtn.slice(0, 200), /showTokenRow\(/, '占位区按钮只展开 token 输入行')
})

test('运维页 URL 提取函数的行为口径（纯函数复刻验证）', () => {
  // 复刻页面里的提取函数，锁定对常见远端地址形态的解析口径
  const repoNameFromUrl = value => {
    const trimmed = String(value).trim().replace(/[/]+$/, '')
    const segment = trimmed.split(/[/:]/).pop() || ''
    let name = segment
    try {
      name = decodeURIComponent(segment)
    } catch {
      /* 编码异常时按原文 */
    }
    return name.replace(/[.]git$/i, '')
  }
  const toSlug = name =>
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')

  assert.equal(
    repoNameFromUrl('https://git.example.com/platform/platform-spec.git'),
    'platform-spec',
  )
  assert.equal(repoNameFromUrl('https://git.example.com/group/repo.git/'), 'repo')
  assert.equal(repoNameFromUrl('git@git.example.com:team/docs.git'), 'docs')
  assert.equal(repoNameFromUrl('https://x.com/a/My_Repo.git'), 'My_Repo')
  assert.equal(toSlug('My_Repo'), 'my-repo')
  assert.equal(toSlug('platform-spec'), 'platform-spec')
  assert.equal(toSlug('--weird--name--'), 'weird-name')
})
