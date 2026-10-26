/**
 * 运维页（deployer 自渲染，不属于任何仓库构建物；PRD R3：`/_` 保留前缀）。
 * 纯内联 HTML/CSS/JS 零构建——统一模型的运维面：token 输入 + 仓库 CRUD /
 * git 凭证 / 分支白名单 / 全局配置 / 索引任务记录与审计。首页（壳渲染）只做
 * 浏览与轻量入口，全部管理动作都收在这里；token 未配置时本页只展示输入引导。
 *
 * ⚠️ 内联脚本整体嵌在本文件的模板字面量里，两个纪律必须遵守：
 *   1. 浏览器脚本里**不得使用内联 onclick 拼字符串**——历史上 `\'` 在模板字面量中
 *      会产出 `''`（单反斜杠被吃掉），整段脚本语法错误静默不执行（2026-10-13 实缺陷：
 *      管理页永远「加载中…」、按钮无反应）。改用 data-* 属性 + 事件委托；
 *   2. 确需反斜杠时必须写双份（`\\d` 才产出 `\d`）；正则里的点用 `[.]` 规避。
 *   改动后由 test/portal.test.mjs 的 vm.Script 编译测试兜底。
 *
 * 运维 token：与文档站共用同一 localStorage 键（at-ops-token，兼容读取旧键
 * deployer:token）；本页可就地输入，401 时自动展开输入行。
 */

// 品牌标识只有一份几何（应用图标 / 标题栏 / 文档 / favicon 同源）
import { LOGO_MARK } from '../../scripts/lib/logo.mjs'

const SHARED_CSS = `
  * { box-sizing: border-box; }
  /* 固定 slate 主题：令牌逐个取自 packages/renderer-core/src/styles/theme.css
     的 :root[data-theme='slate']（运维页自渲染，不跟随 / 不提供明暗切换）。
     规则体里不写任何颜色字面量——一律消费这里的令牌。 */
  :root {
    color-scheme: dark;
    --bg: #14161a;                                  /* --dv-ui-bg */
    --card: #181a1f; --card-2: #1e2126; --card-3: #24282e;  /* surface-1/2/3 */
    --line: #23262b; --line-2: #2d3138; --line-3: #3b4048;  /* line-soft / line / border-strong */
    --text: #e6e8ec; --text-2: #c3c7ce;                     /* text / text-2 */
    --muted: #9298a2; --text-dim: #767c86;                  /* text-muted / text-dim */
    --accent: #6f9fd8; --accent-strong: #8ab5e8; --accent-fg: #0f1620;
    --accent-soft: color-mix(in srgb, var(--accent) 16%, transparent);  /* rgb(111 159 216 / 16%) */
    --ok: #63ab8b; --warn: #cba45f; --err: #d9736a;         /* success / warn / danger */
    --radius-sm: 5px; --radius-md: 7px; --radius-lg: 9px;
    --shadow: 0 8px 24px rgb(0 0 0 / 44%);                  /* --dv-ui-shadow-2 */
    --scrim: color-mix(in srgb, var(--bg) 72%, transparent);  /* 弹窗遮罩：由底色派生，不引入新颜色 */
    /* 代码块：slate 的 --dv-doc-code-bg，固定深色底，不随正文反转 */
    --pre-bg: #1e2126; --pre-fg: #c3c7ce;
    --font-sans: 'Inter', 'Segoe UI Variable Text', 'Segoe UI', 'Microsoft YaHei UI',
      'Microsoft YaHei', 'PingFang SC', 'Hiragino Sans GB', 'Noto Sans SC', system-ui,
      -apple-system, sans-serif;
    --font-mono: 'JetBrains Mono', 'Cascadia Mono', 'SFMono-Regular', Consolas,
      'Liberation Mono', 'Microsoft YaHei', 'PingFang SC', monospace;
  }
  body { margin: 0; font-family: var(--font-sans); font-size: 13px; line-height: 1.5;
         background: var(--bg); color: var(--text); -webkit-font-smoothing: antialiased;
         scrollbar-color: color-mix(in srgb, var(--text-dim) 42%, transparent) transparent; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  /* 顶栏：与应用标题栏同规格（44px、底色 --bg、底边弱线条；图标 15px / 1.7 描边） */
  .titlebar { position: sticky; top: 0; z-index: 30; display: flex; align-items: center; gap: 10px;
    height: 44px; padding: 0 12px; background: var(--bg); border-bottom: 1px solid var(--line); }
  .titlebar__brand { display: flex; align-items: center; gap: 7px; user-select: none; }
  .titlebar__name { margin: 0; font-size: 13px; font-weight: 600; letter-spacing: .2px; color: var(--text); }
  .titlebar__spacer { flex: 1; }
  .titlebar__group { display: flex; align-items: center; gap: 2px; }
  /* 图标按钮：28px 命中区、透明底、hover 表面 2——与 TitleBar 的 .titlebar__icon 一致 */
  .iconbtn { width: 28px; height: 28px; display: grid; place-items: center; padding: 0;
    border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--muted);
    cursor: pointer; transition: background .12s ease, color .12s ease; }
  .iconbtn:hover { background: var(--card-2); color: var(--text); text-decoration: none; }
  /* 文字动作按钮：高度与图标按钮同一条视觉行 */
  .titlebtn { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px;
    border: 1px solid transparent; border-radius: var(--radius-sm); background: transparent;
    color: var(--muted); font: inherit; font-size: 12px; cursor: pointer; text-decoration: none;
    transition: background .12s ease, color .12s ease; }
  .titlebtn:hover { background: var(--card-2); color: var(--text); }
  .brandmark { display: inline-flex; align-items: center; }
  .brandmark svg { display: block; width: 22px; height: 22px; }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 20px 24px 72px; }
  h2 { font-size: 13.5px; font-weight: 600; margin: 0 0 12px; }
  .muted { color: var(--muted); font-size: 12px; }
  /* 面板：与设置页 .panel 同规格（表面 1 + 弱边框 + 圆角 md，不加投影） */
  .card { background: var(--card); border: 1px solid var(--line); border-radius: var(--radius-md);
          padding: 16px 18px; margin-bottom: 16px; }
  /* 页签：与设置页 .settings__nav 同规格（文字按钮、当前项表面 3） */
  .tabs { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 16px; padding-bottom: 10px;
          border-bottom: 1px solid var(--line); }
  .tabs button { height: 26px; padding: 0 11px; border: 1px solid transparent;
                 border-radius: var(--radius-sm); background: transparent; color: var(--muted);
                 font: inherit; font-size: 12px; cursor: pointer;
                 transition: background .12s ease, color .12s ease; }
  .tabs button:hover { background: var(--card-2); color: var(--text-2); }
  .tabs button.on { background: var(--card-3); color: var(--text); }
  .panel { display: none; } .panel.on { display: block; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0 16px; }
  label { display: block; font-size: 12px; color: var(--muted); margin: 10px 0 4px; }
  input, textarea, select { font: inherit; width: 100%; height: 28px; padding: 0 9px;
    border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--bg);
    color: var(--text-2); accent-color: var(--accent);
    transition: border-color .12s ease, box-shadow .12s ease; }
  input:focus, textarea:focus, select:focus { outline: none; border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft); }
  input::placeholder, textarea::placeholder { color: var(--text-dim); opacity: 1; }
  textarea { height: auto; min-height: 120px; padding: 8px 9px;
             font-family: var(--font-mono); font-size: 12px; line-height: 1.6; }
  .field-hint { font-size: 11.5px; line-height: 1.65; color: var(--text-dim); margin-top: 6px; }
  /* 按钮：与设置页 .btn 同规格（30px / 12px / 圆角 sm）；主按钮安全对比度 6.6:1 */
  .btn { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 12px;
         border: 1px solid var(--line); border-radius: var(--radius-sm); background: transparent;
         color: var(--text-2); font: inherit; font-size: 12px; font-weight: 540; cursor: pointer;
         margin-right: 6px; transition: background .12s ease, border-color .12s ease, color .12s ease; }
  .btn:hover { background: var(--card-3); border-color: var(--line-2); color: var(--text); }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); font-weight: 600; }
  .btn.primary:hover { background: var(--accent-strong); border-color: var(--accent-strong); color: var(--accent-fg); }
  .btn.danger { color: var(--err); border-color: color-mix(in srgb, var(--err) 35%, var(--line)); }
  .btn.danger:hover { border-color: var(--err); color: var(--err);
    background: color-mix(in srgb, var(--err) 12%, transparent); }
  .btn.sm { height: 24px; padding: 0 9px; font-size: 11.5px; }
  .btn:disabled { opacity: .45; cursor: default; }
  .badge { display: inline-flex; align-items: center; height: 20px; padding: 0 8px; margin: 1px 4px 1px 0;
           font-size: 11.5px; line-height: 1; border-radius: 999px;
           background: var(--card-3); color: var(--text-2); }
  .badge.ok { background: color-mix(in srgb, var(--ok) 14%, transparent); color: var(--ok); }
  .badge.warn { background: color-mix(in srgb, var(--warn) 14%, transparent); color: var(--warn); }
  .badge.err { background: color-mix(in srgb, var(--err) 14%, transparent); color: var(--err); }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  th { text-align: left; padding: 7px 10px; font-size: 11.5px; color: var(--muted);
       font-weight: 500; border-bottom: 1px solid var(--line); }
  td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--line);
       vertical-align: top; color: var(--text-2); }
  tbody tr:hover td { background: var(--card-2); }
  tbody tr:last-child td { border-bottom: 0; }
  td .sub { color: var(--muted); font-size: 12px; margin-top: 2px; word-break: break-all; }

  /* ---------- 仓库卡片（运维页仓库 tab：卡片布局替代表格，按钮分组右对齐） ---------- */
  .card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
  .card-head h2 { margin: 0; }
  .repo-item { border: 1px solid var(--line); border-radius: var(--radius-md); padding: 14px 16px;
    margin-bottom: 10px; background: var(--card-2); }
  .repo-item:last-child { margin-bottom: 0; }
  .repo-item-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
  .repo-item-title { display: flex; align-items: center; gap: 8px; min-width: 0;
    font-size: 13.5px; font-weight: 600; }
  .repo-item-title .slug { color: var(--muted); font-size: 11.5px; font-weight: 400;
    font-family: var(--font-mono); }
  .repo-item-actions { display: flex; gap: 6px; flex: none; }
  .repo-item-actions .btn { margin: 0; }
  .repo-item-sub { color: var(--muted); font-size: 12px; margin-top: 5px; word-break: break-all; }
  .repo-item-sub .err { color: var(--err); }
  .repo-branches { margin-top: 10px; display: flex; flex-direction: column; gap: 6px; }
  .branch-row { display: flex; align-items: center; gap: 10px; padding: 6px 10px;
    background: var(--bg); border: 1px solid var(--line); border-radius: var(--radius-sm); }
  .branch-row .time { color: var(--muted); font-size: 11.5px; flex: none; }
  .branch-row .spacer { flex: 1; }
  .branch-row .actions { display: flex; gap: 6px; flex: none; }
  .branch-row .actions .btn { margin: 0; }
  .repo-cloning { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 12px; padding: 6px 2px; }
  .repo-cloning .spin { width: 12px; height: 12px; border: 2px solid var(--line-2); border-top-color: var(--accent);
    border-radius: 50%; animation: spin 0.9s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .repo-cloning .spin { animation: none; } }
  /* 插件卡：外层 = 包概览（可点展开）；展开后见组件列表 */
  .plugin-head { cursor: pointer; user-select: none; }
  .plugin-head:hover .repo-item-title { color: var(--accent); }
  .plugin-caret { border: none; background: transparent; color: var(--muted); font-size: 11.5px;
    padding: 0 2px; cursor: pointer; transition: transform 0.18s; flex: none; }
  .plugin-caret.open { transform: rotate(180deg); }
  .plugin-item.is-open { border-color: var(--line-2); }
  .branch-row .comp-title { font-weight: 600; font-size: 12.5px; flex: none; }
  .branch-row .comp-kind { color: var(--muted); font-size: 11px; font-family: var(--font-mono);
    background: var(--card-2); border: 1px solid var(--line); border-radius: var(--radius-sm);
    padding: 1px 6px; flex: none; }
  .branch-row .actions a.btn { margin: 0; text-decoration: none; }

  /* ---------- 弹窗（添加仓库等） ---------- */
  .modal { position: fixed; inset: 0; z-index: 60; display: flex; align-items: flex-start; justify-content: center; }
  .modal[hidden] { display: none; }
  .modal-mask { position: absolute; inset: 0; background: var(--scrim); backdrop-filter: blur(3px); }
  .modal-body { position: relative; width: min(700px, calc(100vw - 36px)); max-height: calc(100vh - 72px);
    overflow-y: auto; margin-top: 42px; padding: 18px 20px 16px; background: var(--card-2);
    border: 1px solid var(--line-2); border-radius: var(--radius-md); box-shadow: var(--shadow);
    animation: modal-in .16s ease; }
  @keyframes modal-in { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: none; } }
  @media (prefers-reduced-motion: reduce) { .modal-body { animation: none; } }
  .modal-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 4px; }
  .modal-head h2 { margin: 0; font-size: 15px; }
  .modal-foot { display: flex; align-items: center; gap: 12px; margin-top: 16px; }
  .modal-foot .msg { margin: 0; }
  .msg { font-size: 12.5px; margin-top: 12px; min-height: 1.4em; margin-bottom: 0; }
  .msg.ok { color: var(--ok); } .msg.err { color: var(--err); }
  .empty { color: var(--muted); font-size: 12.5px; padding: 14px 2px; margin: 0; }
  /* token 行：中性表面 + 左侧强调细线。琥珀底色在整体中性深色里像一条告警横幅，
     token 行只是常规入口，不需要告警语义。 */
  .tokenrow { display: none; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12.5px;
    background: var(--card-2); border: 1px solid var(--line); border-left: 2px solid var(--accent);
    border-radius: var(--radius-sm); padding: 10px 12px; margin-bottom: 16px; }
  .tokenrow.on { display: flex; }
  .tokenrow input { width: 280px; height: 24px; padding: 0 9px; font-size: 12px; }
  .tokenrow .msg { margin: 0; min-height: 0; }
  .token-hint { width: 100%; color: var(--text-dim); font-size: 11.5px; line-height: 1.65; }
  code { font-family: var(--font-mono); font-size: .92em; padding: 1px 5px;
         border-radius: var(--radius-sm); background: var(--card-3); color: var(--text-2); }
  pre { background: var(--pre-bg); color: var(--pre-fg); border: 1px solid var(--line-3);
        padding: 12px 14px; border-radius: var(--radius-sm); overflow: auto;
        font-size: 11.5px; max-height: 400px; line-height: 1.6; }
  pre code { padding: 0; background: none; color: inherit; font-size: inherit; }

  /* 未解锁占位：无有效 token 时显示（与 #opsBody 互斥）。只讲门禁与 token 来源，
     不渲染任何仓库 / 插件数据——避免「看起来坏了」的空白页。 */
  .locked { margin-bottom: 16px; padding: 32px 24px; border: 1px solid var(--line);
    border-radius: var(--radius-lg); background: var(--card); text-align: center; }
  .locked[hidden] { display: none; }
  .locked .lock-icon { width: 40px; height: 40px; margin: 0 auto 12px; display: flex; align-items: center;
    justify-content: center; border-radius: 50%; background: var(--accent-soft); color: var(--accent); }
  .locked h2 { font-size: 15px; margin: 0 0 6px; }
  .locked p { max-width: 560px; margin: 0 auto 14px; color: var(--muted); font-size: 12.5px; line-height: 1.7; }
  .locked .field-hint { margin: 12px auto 0; color: var(--muted); font-size: 12px; }

  @media (max-width: 640px) {
    .grid2 { grid-template-columns: 1fr; }
  }
`

/**
 * 顶栏品牌标。
 *
 * 几何只有一份：`scripts/lib/logo.mjs`（应用图标、标题栏、文档与 favicon 都从
 * 那里取）。这里不内联手写 SVG——各自维护必然改一处漏三处。
 *
 * 用 `LOGO_MARK` 而不是整枚 `LOGO_SVG`：顶栏里它只有 22px，渐变与正文短线在
 * 这个尺寸下糊成一块脏色，扁平三色反而更清楚。
 */
const BRANDMARK = `<span class="brandmark" aria-hidden="true"><svg viewBox="0 0 32 32" width="100%" height="100%">${LOGO_MARK}</svg></span>`

/** 运维面（token 输入 + 仓库 CRUD / 全局配置 / 索引任务记录与审计） */
export function opsHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>运维 · docvi</title>
<style>${SHARED_CSS}</style>
<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
</head>
<body>
<!-- 顶栏：左 = 返回 + 品牌 + 标题；右 = 运维 token 动作。页面级大标题已并入这里，
     不再单起一条与顶栏重复的标题带。 -->
<header class="titlebar">
  <a class="iconbtn" href="/" title="返回首页" aria-label="返回首页"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></svg></a>
  <div class="titlebar__brand">${BRANDMARK}<h1 class="titlebar__name">运维</h1></div>
  <div class="titlebar__spacer"></div>
  <div class="titlebar__group">
    <button class="titlebtn" id="showToken" type="button" title="运维 token（只存本机浏览器）" aria-label="运维 token"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.6 17.4A2 2 0 0 0 2 18.8V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.2a2 2 0 0 0 1.4-.6l.8-.8a6.5 6.5 0 1 0-4-4z"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/></svg><span>运维 token</span></button>
  </div>
</header>
<div class="wrap">
  <div class="tokenrow" id="tokenRow">
    <span>运维 token</span>
    <input id="f-token" type="password" autocomplete="off" placeholder="OPS_TOKEN（只存本机浏览器）">
    <button class="btn sm" id="btn-token-save" type="button">保存</button>
    <button class="btn sm" id="btn-token-hide" type="button">收起</button>
    <span class="muted" id="tokenMsg"></span>
    <span class="token-hint">这是<strong>平台运维凭证</strong>（部署时由 <code>OPS_TOKEN</code> 环境变量设定，与各仓库的 git 账号密码无关）：验证后可执行管理操作——增删仓库、调整分支规则、同步更新、设为默认浏览分支、查看审计日志。只保存在你本机浏览器，不会上传。</span>
  </div>
  <!-- 未解锁占位区：默认显示，鉴权成功（showOpsBody）后隐藏，与 #opsBody 互斥。
       只讲门禁与 token 来源，不渲染任何仓库 / 插件数据。 -->
  <div class="locked" id="opsLocked">
    <div class="lock-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10.5" width="16" height="10.5" rx="2.5"/><path d="M8 10.5V7.6a4 4 0 0 1 8 0v2.9"/></svg></div>
    <h2>管理功能未解锁</h2>
    <p>仓库、插件、临时分享、全局配置、索引记录与审计日志都需要<strong>运维 token</strong> 才能查看和操作。当前浏览器里没有可用的 token，因此下方管理区保持隐藏。</p>
    <button class="btn primary" id="btn-locked-token" type="button">输入运维 token</button>
    <p class="field-hint">token 由部署时设置的 <code>OPS_TOKEN</code> 环境变量决定（与各仓库的 git 账号密码无关）；保存后页面自动刷新。</p>
  </div>
  <!-- 管理区（tabs + 面板）：默认隐藏——无有效 token 时连结构都不放出（安全缺省：
       任何新增面板天然在门禁内，不存在「漏一个」的可能）；鉴权成功由脚本放出 -->
  <div id="opsBody" hidden>
  <div class="tabs">
    <button data-tab="repos" class="on">仓库</button>
    <button data-tab="plugins">插件</button>
    <button data-tab="shares">临时分享</button>
    <button data-tab="config">全局配置</button>
    <button data-tab="builds">索引任务记录</button>
    <button data-tab="audit">审计日志</button>
  </div>

  <div class="panel on" id="panel-repos">
    <div class="card">
      <div class="card-head">
        <h2>仓库</h2>
        <button class="btn primary" id="btn-open-add">＋ 添加仓库</button>
      </div>
      <div id="repoList"><p class="empty">加载中…</p></div>
    </div>
  </div>

  <div class="panel" id="panel-config">
    <div class="card">
      <h2>全局配置（仓库可覆盖）</h2>
      <div class="grid2">
        <div><label>自动同步</label>
          <select id="g-autoFetch"><option>poll</option><option>webhook</option><option>off</option></select></div>
        <div><label>轮询间隔（秒）</label><input id="g-fetchIntervalSec" type="number"></div>
        <div><label>新提交自动刷新索引</label>
          <select id="g-autoBuild"><option value="true">是</option><option value="false">否</option></select></div>
        <div><label>清理计划（cron，5 段）</label><input id="g-cleanupCron"></div>
      </div>
      <div style="margin-top:14px"><button class="btn primary" id="btn-save-global">保存</button></div>
      <p class="msg" id="cfgMsg"></p>
    </div>
  </div>

  <div class="panel" id="panel-plugins">
    <div class="card">
      <div class="card-head">
        <h2>插件（组件包）</h2>
        <button class="btn primary" id="btn-open-plugin">＋ 添加插件</button>
      </div>
      <div class="field-hint">
        MCP：<code id="mcp-url">http(s)://&lt;当前 host&gt;/mcp</code>（可直接配置到支持 Streamable HTTP 的 AI 客户端——已启用插件的组件清单与用法文档即查即得）
        <button class="btn sm" id="btn-mcp-copy" type="button">复制地址</button>
      </div>
      <div id="pluginList"><p class="empty">加载中…</p></div>
    </div>
  </div>

  <div class="panel" id="panel-shares">
    <div class="card">
      <div class="card-head">
        <h2>临时分享</h2>
      </div>
      <div class="field-hint">
        把共享根内的文件或目录生成一个链接（<code>/s/&lt;id&gt;/</code>）给局域网同事临时查看。
        <strong>内容不会被复制</strong>：链接是对本机文件路径的实时代理——文件移动 / 删除或下方停用后链接立即失效；
        本机（容器）关机即不可达。共享根：开关 <code>SHARE_ROOTS</code>，目录经 compose 的
        <code>SHARE_HOST_DIR</code> 挂载；<strong>只有共享根内的路径可被分享</strong>。
      </div>
      <div class="grid2">
        <div><label>路径（容器内绝对路径，须在共享根内）</label><input id="s-path" placeholder="/share/设计文档.md 或 /share/某个目录"></div>
        <div><label>显示名（可选，缺省取文件名）</label><input id="s-name" placeholder="设计草案 v2"></div>
      </div>
      <div style="margin-top:12px"><button class="btn primary" id="btn-share-add">生成分享链接</button></div>
      <p class="msg" id="shareMsg"></p>
      <div id="shareList" style="margin-top:14px"><p class="empty">加载中…</p></div>
    </div>
  </div>

  <div class="panel" id="panel-builds">
    <div class="card">
      <h2>索引任务记录</h2>
      <div id="buildList"><p class="empty">加载中…</p></div>
      <pre id="logView" style="display:none; margin-top:12px"></pre>
    </div>
  </div>

  <div class="panel" id="panel-audit">
    <div class="card">
      <h2>审计日志（最近 100 条）</h2>
      <pre id="auditView">加载中…</pre>
    </div>
  </div>
  </div><!-- /opsBody -->
</div>

<!-- webhook 弹窗（推送地址展示：平台是被动接收端，需在 Git 平台侧配置） -->
<div class="modal" id="modal-hook" hidden>
  <div class="modal-mask" data-close-hook></div>
  <div class="modal-body">
    <div class="modal-head">
      <h2>webhook 推送 <span class="muted" id="hook-slug"></span></h2>
      <button class="btn sm" type="button" data-close-hook>收起</button>
    </div>
    <div class="field-hint">
      平台是<strong>被动接收端</strong>：把下面的地址填到 Git 平台的 Webhook / 推送通知设置里，
      推送到达即触发同步（零延迟）。平台不会自动注册——需在仓库侧手工配置。
      注意：Git 平台必须能<strong>主动访问到本平台</strong>（内网 GitLab 通常访问不到局域网部署机，这种情况请用自动同步轮询）；
      若本页地址是 localhost / 127.0.0.1，请把主机部分换成 Git 平台能访问到的地址（如局域网 IP）。
    </div>
    <label>推送地址（POST，含 secret）</label>
    <input id="hook-url" readonly>
    <div class="modal-foot">
      <button class="btn primary" id="btn-hook-copy">复制地址</button>
      <button class="btn" type="button" data-close-hook>关闭</button>
      <p class="msg" id="hookMsg"></p>
    </div>
  </div>
</div>

<!-- 添加仓库弹窗 -->
<div class="modal" id="modal-add" hidden>
  <div class="modal-mask" data-close-add></div>
  <div class="modal-body">
    <div class="modal-head">
      <h2>添加仓库</h2>
      <button class="btn sm" type="button" data-close-add>收起</button>
    </div>
    <div class="grid2">
      <div><label>slug（URL 标识，即 /&lt;slug&gt;/ 路径）</label><input id="f-slug" placeholder="team-docs"></div>
      <div><label>显示名</label><input id="f-name" placeholder="团队文档"></div>
    </div>
    <label>git 远端地址</label>
    <input id="f-url" placeholder="https://git.example.com/team/docs.git">
    <div class="field-hint">粘贴地址后自动提取仓库名填入 slug 与显示名（可手工修改）。slug 不得使用 docs / api / assets / 下划线等平台保留段。</div>
    <label>分支规则（逗号分隔，支持通配：1.* 命中 1.3.0；命中的远端分支自动维护工作树并索引）</label>
    <input id="f-branches" placeholder="main, 1.*">
    <div class="grid2">
      <div><label>git 用户名（私有仓库；留空 = 公开）</label><input id="f-git-user" placeholder="git-user"></div>
      <div><label>密码 / Token（只写不读，保存后不回显）</label><input id="f-git-pass" type="password" placeholder="账号密码或访问令牌"></div>
    </div>
    <div class="field-hint">私有仓库可直接在这里填写 http(s) 凭证；ssh 形式请使用部署机密钥。</div>
    <label>粘贴配置 docs.config.yaml（可选，优先于仓库自带；不填则自动扫描目录）</label>
    <textarea id="f-override" rows="6" placeholder="title: 团队文档站&#10;sidebar:&#10;  - text: 知识库&#10;    path: 知识库"></textarea>
    <div class="modal-foot">
      <button class="btn primary" id="btn-add">添加并开始首次索引</button>
      <button class="btn" type="button" data-close-add>取消</button>
      <p class="msg" id="repoMsg"></p>
    </div>
  </div>
</div>

<!-- git 凭证弹窗 -->
<div class="modal" id="modal-cred" hidden>
  <div class="modal-mask" data-close-cred></div>
  <div class="modal-body">
    <div class="modal-head">
      <h2>git 凭证 <span class="muted" id="cred-slug"></span></h2>
      <button class="btn sm" type="button" data-close-cred>收起</button>
    </div>
    <div class="field-hint">私有仓库的 http(s) 账号 / 访问令牌（存于服务器数据卷，API 不回显内容）。ssh 形式请使用部署机密钥。</div>
    <div class="grid2">
      <div><label>用户名（可留空；只提交 Token 时自动以 oauth2 占位）</label><input id="c-user" autocomplete="off"></div>
      <div><label>密码 / Token（只写不读）</label><input id="c-pass" type="password" autocomplete="off"></div>
    </div>
    <div class="modal-foot">
      <button class="btn primary" id="btn-cred-save">保存凭证</button>
      <button class="btn danger" id="btn-cred-clear">清除凭证</button>
      <button class="btn" type="button" data-close-cred>取消</button>
      <p class="msg" id="credMsg"></p>
    </div>
  </div>
</div>

<!-- 添加插件弹窗（协议 v1：预构建包，纯 HTTPS 下载——不执行包内脚本） -->
<div class="modal" id="modal-plugin" hidden>
  <div class="modal-mask" data-close-plugin></div>
  <div class="modal-body">
    <div class="modal-head">
      <h2>添加插件包</h2>
      <button class="btn sm" type="button" data-close-plugin>收起</button>
    </div>
    <label>来源（url: 直链 tarball；npm: / git: 为阶段二渠道）</label>
    <input id="p-source" placeholder="url:https://github.com/作者/插件仓/releases/download/v0.1.0/pkg.tar.gz">
    <div class="field-hint">
      插件包须满足协议 v1：<code>plugin.json</code>（清单）+ <code>dist/index.js</code>（预构建 ESM）+ <code>docs/SKILL.md</code>（AI 用法文档）。
      构建由作者 CI 完成（打 tag 出 release 资产），平台只下载校验、<strong>永不执行包内脚本</strong>。
      包内组件与已启用插件同名时自动切换（最新者赢）：新实现激活、原实现自动停用（可在列表里切回）。
    </div>
    <div class="grid2">
      <div><label>访问凭证（私有源；公开源留空）</label><input id="p-credential" type="password" autocomplete="off" placeholder="Bearer token（可选）"></div>
      <div><label>安装后</label><select id="p-enabled"><option value="true">立即启用</option><option value="false">先禁用（只归档）</option></select></div>
    </div>
    <div class="modal-foot">
      <button class="btn primary" id="btn-plugin-add">下载并安装</button>
      <button class="btn" type="button" data-close-plugin>取消</button>
      <p class="msg" id="pluginMsg"></p>
    </div>
  </div>
</div>
<script>
const TOKEN_KEY = 'at-ops-token';
const LEGACY_TOKEN_KEY = 'deployer:token';
const token = () => localStorage.getItem(TOKEN_KEY) || localStorage.getItem(LEGACY_TOKEN_KEY) || '';
const esc = (value) => String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
/** 管理区（tabs + 全部面板）门禁：默认隐藏，鉴权成功才放出、401 立即收回——
 *  安全缺省：无 token 时连结构都不存在，任何新增面板天然在门禁内（不存在「漏一个」）。
 *  占位区 #opsLocked 与 #opsBody 互斥：解锁隐藏占位、收回显示占位。 */
function showOpsBody() {
  const el = document.getElementById('opsBody'); if (el) el.hidden = false;
  const locked = document.getElementById('opsLocked'); if (locked) locked.hidden = true;
}
function hideOpsBody() {
  const el = document.getElementById('opsBody'); if (el) el.hidden = true;
  const locked = document.getElementById('opsLocked'); if (locked) locked.hidden = false;
}
async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', ...(token() ? { Authorization: 'Bearer ' + token() } : {}), ...(opts.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    hideOpsBody();
    /*
     * 分两种：存过 token 却被拒 = 无效，要说清；从没存过 = 还没解锁，
     * 只做引导不给红字——首次访问看到「token 无效」会以为平台坏了。
     */
    showTokenRow(token() ? 'token 无效——请重新输入' : '输入运维 token 后解锁管理区');
    throw new Error('token 无效或未配置——请在「运维 token」处输入后重试');
  }
  if (!res.ok) throw new Error(data.error || res.status);
  return data;
}
function ensureToken() {
  if (!token()) showTokenRow('需要运维 token——输入保存后重试本操作');
  return Boolean(token());
}

document.querySelectorAll('.tabs button').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
    document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('on', p.id === 'panel-' + b.dataset.tab));
    if (b.dataset.tab === 'builds') loadBuilds();
    if (b.dataset.tab === 'audit') loadAudit();
    if (b.dataset.tab === 'config') loadGlobal();
    if (b.dataset.tab === 'plugins') loadPlugins();
    if (b.dataset.tab === 'shares') loadShares();
  });
});

/* ---------- 插件面板（协议 v1：组件包安装/启停/组件级开关/卸载） ---------- */

/** 最近一次拉到的插件目录（组件行渲染用） */
let lastPlugins = [];
/** 第三方包卸载确认二段（首次点「卸载」转确认态，再点才发请求） */
let pendingUninstall = '';
/**
 * 插件卡展开态（默认**展开**——首屏就能看到组件与「预览」入口）。
 *
 * 早先默认折叠：外层只展示包概览，组件行要点一下才出来。问题是运维页的
 * 用途正是「看这个包贡献了什么、长什么样」，默认折叠把唯一的「预览」按钮
 * 藏在一次点击之后，用户点进运维页会以为没有预览入口（已实测反馈）。
 * 组件多的包确实会撑长页面，但那是可滚动的内容，不是噪音——概览行仍然
 * 在，收起来也只要一次点击。
 */
const collapsedPlugins = new Set();

async function loadPlugins() {
  const el = document.getElementById('pluginList');
  try {
    const { catalog } = await api('/api/plugins');
    showOpsBody();
    lastPlugins = catalog.plugins || [];
    if (!lastPlugins.length) { el.innerHTML = '<p class="empty">尚无插件包——点右上角「＋ 添加插件」。</p>'; return; }
    el.innerHTML = lastPlugins.map(renderPluginItem).join('');
  } catch (e) {
    el.innerHTML = '<p class="empty">' + esc(e.message) + '</p>';
    if (document.getElementById('opsBody')?.hidden) showTokenRow(e.message);
  }
}

/** 本地化字段解析（协议 v1.1：string 或 {lang: string}；运维页取中文，其次英文） */
function lz(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') return value.zh ?? value.en ?? Object.values(value)[0] ?? '';
  return '';
}

/** 同名冲突检测：本插件某 kind 与其它已启用插件的活跃实现重名 → 返回对面全限定名 */
function conflictWith(plugin, kind) {
  const mine = (plugin.disabledComponents || []).includes(kind);
  const others = [];
  for (const other of lastPlugins) {
    if (other.name === plugin.name || !other.enabled) continue;
    if ((other.disabledComponents || []).includes(kind)) continue;
    if ((other.components || []).some((c) => c.kind === kind)) others.push(other.name + '/' + kind);
  }
  return { mine, others };
}

/** 组件行：title 主显示（协议 v1.1 显示名）+ kind 副标 + 描述 + 冲突标注 + 预览 + 启停 */
function renderComponentRow(plugin, item) {
  const { mine, others } = conflictWith(plugin, item.kind);
  const disabled = mine;
  const conflict = others.length
    ? '<span class="badge warn" title="与 ' + esc(others.join('、')) + ' 同名（同类竞争切换）">同名冲突项：' + esc(others.join('、')) + '</span>'
    : '';
  // 手动开启被停用的冲突方：提示「将停用其他冲突实现（列明）」——确认后提交
  const attrs = ' data-plugin="' + esc(plugin.name) + '" data-kind="' + esc(item.kind) + '"' + (others.length ? ' data-conflict="' + esc(others.join(',')) + '"' : '');
  const toggle = disabled
    ? '<button class="btn sm" data-pact="comp-enable"' + attrs + '>开启</button>'
    : '<button class="btn sm" data-pact="comp-disable"' + attrs + '>停用</button>';
  // 示例预览（协议 v1.1 example 字段）：装了即可预览（示例渲染要加载本包组件实现）
  const preview = item.example
    ? '<a class="btn sm" href="/_/preview/' + encodeURIComponent(plugin.name) + '/' + encodeURIComponent(item.kind) + '" target="_blank" rel="noreferrer">预览</a>'
    : '';
  return '<div class="branch-row"><span class="comp-title">' + esc(lz(item.title) || item.kind) + '</span>' +
    '<span class="comp-kind" title="文档标签：&lt;at-' + esc(item.kind) + '&gt;">' + esc(item.kind) + '</span>' +
    conflict +
    '<span class="muted">' + esc(lz(item.description)) + '</span>' +
    '<span class="spacer"></span><span class="actions">' + preview + toggle + '</span></div>';
}

function renderPluginItem(p) {
  if (p.broken) {
    return '<div class="repo-item"><div class="repo-item-head"><span class="repo-item-title">' + esc(p.name) +
      '<span class="slug">' + esc(p.version || '') + '</span></span></div>' +
      '<div class="repo-item-sub"><span class="err">' + esc(p.broken) + '</span></div></div>';
  }
  const badge = p.builtin ? '<span class="badge">预设包</span>' : '<span class="badge ok">第三方</span>';
  const stateBadge = p.enabled ? '' : '<span class="badge warn">已停用</span>';
  const count = (p.components || []).length;
  // 折叠态冲突概览：几个组件与其它插件重名（展开才逐项标注）
  const conflictCount = (p.components || []).filter((c) => conflictWith(p, c.kind).others.length || conflictWith(p, c.kind).mine).length;
  const conflictBadge = conflictCount
    ? '<span class="badge warn">' + conflictCount + ' 个同名冲突</span>'
    : '';
  /*
   * 默认展开：collapsedPlugins 只记录用户主动收起的包（见 toggle 处理），
   * 所以这里用「不在集合里 = 展开」的语义，与 Set 的默认状态一致。
   * （本段在模板字符串里，注释中不能出现反引号——会提前截断模板串。）
   */
  const open = !collapsedPlugins.has(p.name);
  const comps = (p.components || []).map((c) => renderComponentRow(p, c)).join('');
  const pluginToggle = p.enabled
    ? '<button class="btn sm" data-pact="disable" data-plugin="' + esc(p.name) + '">停用插件</button>'
    : '<button class="btn sm primary" data-pact="enable" data-plugin="' + esc(p.name) + '">启用插件</button>';
  const uninstall = p.builtin
    ? '<button class="btn sm" disabled title="预设包随平台版本分发，可禁用不可卸载">卸载</button>'
    : pendingUninstall === p.name
      ? '<button class="btn sm danger" data-pact="uninstall" data-plugin="' + esc(p.name) + '">确认卸载？</button>'
      : '<button class="btn sm" data-pact="uninstall-ask" data-plugin="' + esc(p.name) + '">卸载</button>';
  const src = p.sourceLabel ? '<div class="repo-item-sub">' + esc(p.sourceLabel) + '</div>' : '';
  const caret = '<button class="plugin-caret' + (open ? ' open' : '') + '" data-pact="toggle-open" data-plugin="' + esc(p.name) + '"' +
    ' aria-expanded="' + (open ? 'true' : 'false') + '" title="' + (open ? '收起组件列表' : '展开组件列表') + '">▾</button>';
  // 外层 = 包概览（点标题区或 ▾ 展开）；展开后才是组件列表
  return '<div class="repo-item plugin-item' + (open ? ' is-open' : '') + '">' +
    '<div class="repo-item-head plugin-head" data-pact="toggle-open" data-plugin="' + esc(p.name) + '">' +
    '<span class="repo-item-title">' + caret + esc(lz(p.displayName) || p.name) +
    '<span class="slug">' + esc(p.name) + ' v' + esc(p.version) + '</span>' +
    '<span class="badge">' + count + ' 个组件</span>' + conflictBadge + '</span>' +
    '<span class="repo-item-actions">' + badge + stateBadge + pluginToggle + uninstall + '</span></div>' +
    src +
    (open ? '<div class="repo-branches">' + (comps || '<div class="repo-cloning">该包未声明组件。</div>') + '</div>' : '') +
    '</div>';
}

document.getElementById('pluginList').addEventListener('click', async (ev) => {
  // 展开/折叠：点包标题区（含 ▾ 按钮）——不经过 data-pact 按钮分支
  const head = ev.target.closest('[data-pact="toggle-open"]');
  if (head && !ev.target.closest('button[data-pact]:not([data-pact="toggle-open"])') && !ev.target.closest('a')) {
    const toggleName = head.dataset.plugin || '';
    if (collapsedPlugins.has(toggleName)) collapsedPlugins.delete(toggleName);
    else collapsedPlugins.add(toggleName);
    loadPlugins();
    return;
  }
  const btn = ev.target.closest('button[data-pact]');
  if (!btn || btn.disabled) return;
  const act = btn.dataset.pact;
  const name = btn.dataset.plugin || '';
  const kind = btn.dataset.kind || '';
  const msg = document.getElementById('pluginMsg');
  try {
    if (act === 'uninstall-ask') { pendingUninstall = name; loadPlugins(); return; }
    if (act === 'enable' || act === 'disable') {
      const out = await api('/api/plugins/' + encodeURIComponent(name) + '/' + act, { method: 'POST', body: '{}' });
      if (out.replaced?.length) window.alert('已切换：' + out.replaced.join('、') + ' 的对应组件已自动停用（同名组件最新者赢）。\\n刷新文档页后生效。');
      else window.alert('已' + (act === 'enable' ? '启用' : '停用') + '——刷新文档页后生效。');
      loadPlugins(); return;
    }
    if (act === 'comp-enable' || act === 'comp-disable') {
      if (act === 'comp-enable') {
        const conflict = (btn.dataset.conflict || '').split(',').filter(Boolean);
        if (conflict.length && !window.confirm('开启 ' + name + '/' + kind + ' 将停用其他同名实现：\\n' + conflict.join('\\n') + '\\n\\n确认切换？')) return;
      }
      const out = await api('/api/plugins/' + encodeURIComponent(name) + '/components/' + encodeURIComponent(kind) + '/' + (act === 'comp-enable' ? 'enable' : 'disable'), { method: 'POST', body: '{}' });
      if (out.replaced?.length) window.alert('已切换：' + out.replaced.join('、') + ' 已自动停用。刷新文档页后生效。');
      loadPlugins(); return;
    }
    if (act === 'uninstall') {
      await api('/api/plugins/' + encodeURIComponent(name), { method: 'DELETE' });
      pendingUninstall = '';
      window.alert('已卸载 ' + name + '。刷新文档页后生效。');
      loadPlugins(); return;
    }
  } catch (e) {
    window.alert('操作失败：' + e.message);
    if (msg) msg.textContent = e.message;
  }
});

/** 添加插件弹窗 */
function openPluginModal() {
  pendingUninstall = '';
  document.getElementById('p-source').value = '';
  document.getElementById('p-credential').value = '';
  document.getElementById('p-enabled').value = 'true';
  document.getElementById('pluginMsg').textContent = '';
  document.getElementById('modal-plugin').hidden = false;
}
document.getElementById('btn-open-plugin').addEventListener('click', openPluginModal);
document.querySelectorAll('[data-close-plugin]').forEach((el) =>
  el.addEventListener('click', () => { document.getElementById('modal-plugin').hidden = true; }));
document.getElementById('btn-plugin-add').addEventListener('click', async () => {
  const msg = document.getElementById('pluginMsg');
  const source = document.getElementById('p-source').value.trim();
  if (!source) { msg.textContent = '请填写来源'; return; }
  msg.textContent = '下载并校验中（大包可能需要一会儿）…';
  try {
    const out = await api('/api/plugins', {
      method: 'POST',
      body: JSON.stringify({
        source,
        credential: document.getElementById('p-credential').value.trim(),
        enabled: document.getElementById('p-enabled').value === 'true',
      }),
    });
    document.getElementById('modal-plugin').hidden = true;
    const replaced = out.replaced?.length ? '\\n同名切换：' + out.replaced.join('、') + ' 已自动停用。' : '';
    window.alert('插件 ' + out.installed.name + ' v' + out.installed.version + ' 已安装。' + replaced + '\\n刷新文档页后生效。');
    loadPlugins();
  } catch (e) {
    msg.textContent = '失败：' + e.message;
  }
});

/* ---------- MCP 端点提示（容器端 /mcp：AI 客户端直连；复制用真实 host） ---------- */

document.getElementById('mcp-url').textContent = location.origin + '/mcp';
document.getElementById('btn-mcp-copy').addEventListener('click', async (ev) => {
  const btn = ev.currentTarget;
  const url = location.origin + '/mcp';
  try {
    await navigator.clipboard.writeText(url);
    btn.textContent = '已复制';
    setTimeout(() => { btn.textContent = '复制地址'; }, 1200);
  } catch (e) {
    window.alert('复制失败，请手动复制：' + url);
  }
});

/* ---------- 临时分享面板（/s/<id>/ 代理链接：文件或目录） ---------- */

async function loadShares() {
  const el = document.getElementById('shareList');
  try {
    const data = await api('/api/shares');
    showOpsBody();
    const rootsHint = '共享根：' + (data.roots || []).map((r, i) => r + ((data.rootsExist || [])[i] ? '' : '（未挂载）')).join('、');
    if (!data.shares.length) {
      el.innerHTML = '<p class="empty">还没有分享——在上方填入共享根内的路径生成第一个链接。</p><p class="field-hint">' + esc(rootsHint) + '</p>';
      return;
    }
    el.innerHTML = data.shares.map((s) => {
      const stat = !s.exists ? '<span class="badge err">目标已消失</span>' : s.enabled ? '' : '<span class="badge warn">已停用</span>';
      const kind = s.kind === 'dir' ? '<span class="badge">目录</span>' : '<span class="badge">文件</span>';
      const url = location.origin + '/s/' + s.id + '/';
      return '<div class="repo-item"><div class="repo-item-head"><span class="repo-item-title">' + esc(s.name) +
        '<span class="slug">' + esc(s.id) + '</span></span>' +
        '<span class="repo-item-actions">' + kind + stat +
        '<button class="btn sm" data-share-act="copy" data-id="' + esc(s.id) + '" data-url="' + esc(url) + '">复制链接</button>' +
        (s.enabled
          ? '<button class="btn sm" data-share-act="disable" data-id="' + esc(s.id) + '">停用</button>'
          : '<button class="btn sm primary" data-share-act="enable" data-id="' + esc(s.id) + '">启用</button>') +
        '<button class="btn sm danger" data-share-act="remove" data-id="' + esc(s.id) + '">撤销</button>' +
        '</span></div>' +
        '<div class="repo-item-sub">' + esc(s.path) + '</div>' +
        '<div class="repo-item-sub"><a href="' + esc(url) + '" target="_blank" rel="noreferrer">' + esc(url) + '</a> · ' + esc(fmtTime(s.createdAt)) + '</div>' +
        '</div>';
    }).join('') + '<p class="field-hint">' + esc(rootsHint) + '</p>';
  } catch (e) {
    el.innerHTML = '<p class="empty">' + esc(e.message) + '</p>';
    if (document.getElementById('opsBody')?.hidden) showTokenRow(e.message);
  }
}

document.getElementById('shareList').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-share-act]');
  if (!btn) return;
  const id = btn.dataset.id || '';
  const act = btn.dataset.shareAct;
  try {
    if (act === 'copy') {
      await navigator.clipboard.writeText(btn.dataset.url || '');
      btn.textContent = '已复制';
      setTimeout(() => { btn.textContent = '复制链接'; }, 1200);
      return;
    }
    if (act === 'enable' || act === 'disable') {
      await api('/api/shares/' + encodeURIComponent(id) + '/toggle', { method: 'POST', body: JSON.stringify({ enabled: act === 'enable' }) });
      loadShares();
      return;
    }
    if (act === 'remove') {
      if (!window.confirm('撤销后该链接立即失效（不影响原文件）。确认撤销？')) return;
      await api('/api/shares/' + encodeURIComponent(id), { method: 'DELETE' });
      loadShares();
    }
  } catch (e) {
    window.alert('操作失败：' + e.message);
  }
});

document.getElementById('btn-share-add').addEventListener('click', async () => {
  const msg = document.getElementById('shareMsg');
  const path = document.getElementById('s-path').value.trim();
  if (!path) { msg.textContent = '请填写路径'; return; }
  msg.textContent = '创建中…';
  try {
    const out = await api('/api/shares', {
      method: 'POST',
      body: JSON.stringify({ path, name: document.getElementById('s-name').value.trim() }),
    });
    document.getElementById('s-path').value = '';
    document.getElementById('s-name').value = '';
    msg.textContent = '已创建：' + location.origin + '/s/' + out.share.id + '/（局域网同事用你的 IP 替换 localhost）';
    loadShares();
  } catch (e) {
    msg.textContent = '失败：' + e.message;
  }
});

/** ISO(UTC) → 查看者本地时间「YYYY-MM-DD HH:mm」。
 * 运维页在前端渲染，跟随浏览器时区——不能再直接切 ISO 串（此前容器 UTC 下显示差 8 小时）。
 * 注意：模板字符串内的 \${} 是转义写法（下面整段嵌在服务端模板里）。 */
function fmtTime(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return \`\${date.getFullYear()}-\${pad(date.getMonth() + 1)}-\${pad(date.getDate())} \${pad(date.getHours())}:\${pad(date.getMinutes())}\`;
}

/** 最近一次拉到的仓库列表（webhook 弹窗查 secret 用） */
let lastRepos = [];
/** 仓库卡片（分组清晰：头部=名称+整体操作；正文=元信息；分支行=分支操作） */
async function loadRepos() {
  const el = document.getElementById('repoList');
  try {
    const { repos } = await api('/api/repos');
    showOpsBody();
    lastRepos = repos;
    if (!repos.length) { el.innerHTML = '<p class="empty">尚无仓库——点右上角「＋ 添加仓库」加入第一个。</p>'; return; }
    el.innerHTML = repos.map(renderRepoItem).join('');
    // 克隆中的仓库：3 秒后自动刷新一次列表（克隆完成即出现分支行）
    if (repos.some((r) => r.cloning)) {
      clearTimeout(window.__repoRefreshTimer);
      window.__repoRefreshTimer = setTimeout(() => {
        if (document.getElementById('panel-repos')?.classList.contains('on')) loadRepos();
      }, 3000);
    }
  } catch (e) {
    el.innerHTML = '<p class="empty">' + esc(e.message) + '</p>';
    /*
     * 非 401 的失败（如服务端未配置 OPS_TOKEN）才是「真的出错」，要把原因放到
     * 可见的 token 行。**首次访问不该报错**：全新浏览器本来就没有 token，
     * 这时候弹一行红色的「token 无效」是误报——读者会以为平台坏了。
     * 所以只有「存过 token 但被拒」才提示，从未保存过就走占位区的正常引导。
     */
    if (document.getElementById('opsBody')?.hidden && token()) showTokenRow(e.message);
  }
}

function renderRepoItem(r) {
  const credBadge = r.hasCredential ? '<span class="badge ok">凭证已配置</span>'
    : String(r.url).indexOf('file:') === 0 ? '<span class="badge">本地路径</span>'
    : String(r.url).indexOf('http') === 0 ? '<span class="badge warn">凭证未配置</span>'
    : '<span class="badge">ssh / 环境变量</span>';
  const syncBits = '规则：' + esc((r.patterns || []).join(', ')) + ' · 上次同步 ' + esc(fmtTime(r.syncAt));
  const syncErr = r.syncError ? '<div class="repo-item-sub"><span class="err">同步失败：' + esc(r.syncError) + '</span></div>' : '';
  let body = '';
  if (r.cloning) {
    body = '<div class="repo-cloning"><span class="spin"></span>正在克隆仓库…（完成后自动出现分支）</div>';
  } else if (!r.branches.length) {
    body = '<div class="repo-cloning">暂无命中的远端分支——检查分支规则是否匹配远端分支名。</div>';
  } else {
    body = r.branches.map((b) => {
      const cls = b.artifact === 'ready' ? 'ok' : b.artifact === 'building' ? 'warn' : b.artifact === 'failed' ? 'err' : '';
      const behind = b.behind > 0 ? ' · 落后 ' + b.behind : '';
      const def = b.isDefault ? '<span class="badge">默认</span>' : '';
      const attrs = ' data-slug="' + esc(r.slug) + '" data-branch="' + esc(b.branch) + '"';
      return '<div class="branch-row"><span class="badge ' + cls + '">' + esc(b.branch) + '</span>' + def +
        '<span class="muted">' + esc(b.artifact) + behind + '</span>' +
        '<span class="time">' + esc(fmtTime(b.buildAt)) + '</span><span class="spacer"></span>' +
        '<span class="actions">' +
        '<button class="btn sm" data-act="build"' + attrs + '>重建索引</button>' +
        (b.isDefault ? '' : '<button class="btn sm" data-act="switch"' + attrs + '>设为默认</button>') +
        '</span></div>';
    }).join('');
  }
  return '<div class="repo-item">' +
    '<div class="repo-item-head"><span class="repo-item-title">' + esc(r.name) +
    '<span class="slug">' + esc(r.slug) + '</span></span>' +
    '<span class="repo-item-actions">' + credBadge +
    (r.cloning ? '' : '<button class="btn sm primary" data-act="sync" data-slug="' + esc(r.slug) + '">同步</button>') +
    '<button class="btn sm" data-act="hook" data-slug="' + esc(r.slug) + '">webhook</button>' +
    '<button class="btn sm" data-act="credential" data-slug="' + esc(r.slug) + '">凭证</button>' +
    '<button class="btn sm danger" data-act="remove" data-slug="' + esc(r.slug) + '">移除</button>' +
    '</span></div>' +
    '<div class="repo-item-sub">' + esc(r.url) + '</div>' +
    '<div class="repo-item-sub">' + syncBits + '</div>' + syncErr +
    '<div class="repo-branches">' + body + '</div>' +
    '</div>';
}

document.getElementById('repoList').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-act]');
  if (!btn) return;
  const action = btn.dataset.act;
  const slug = btn.dataset.slug || '';
  const branch = btn.dataset.branch || '';
  if (action === 'remove') return removeRepo(slug);
  if (action === 'credential') return openCredModal(slug);
  if (action === 'hook') return openHookModal(slug);
  if (!ensureToken()) return;
  btn.disabled = true;
  try {
    if (action === 'sync') {
      const res = await api('/api/repos/' + encodeURIComponent(slug) + '/sync', { method: 'POST' });
      const results = res.results || [];
      const updated = results.filter((r) => r.changed);
      const queued = results.filter((r) => r.building);
      const retried = results.filter((r) => r.reason === 'stale-index');
      if (!updated.length && !queued.length) {
        alert('已是最新，无需更新。');
      } else {
        const parts = [];
        if (updated.length) parts.push('已更新：' + updated.map((r) => r.branch).join('、'));
        if (queued.length) parts.push('索引已入队' + (retried.length ? '（含索引落后分支）' : ''));
        else if (updated.length) parts.push('自动索引已关闭——需要重建时点分支行「重建索引」');
        alert(parts.join('；'));
      }
    } else {
      const res = await api('/api/repos/' + encodeURIComponent(slug) + '/branches/' + encodeURIComponent(branch) + '/' + action, { method: 'POST' });
      alert(res.building ? '已入索引队列' : '完成');
    }
  } catch (e) { alert(e.message); }
  loadRepos();
});

async function removeRepo(slug) {
  if (!confirm('移除仓库 ' + slug + '？工作树与产物将被删除且不可恢复。')) return;
  if (!ensureToken()) return;
  try { await api('/api/repos/' + encodeURIComponent(slug), { method: 'DELETE' }); loadRepos(); } catch (e) { alert(e.message); }
}

/* ---------- 弹窗（添加仓库 / git 凭证 / webhook） ---------- */

function openModal(id) { document.getElementById(id).hidden = false; }
function closeModal(id) { document.getElementById(id).hidden = true; }
document.querySelectorAll('[data-close-add]').forEach((el) => el.addEventListener('click', () => closeModal('modal-add')));
document.querySelectorAll('[data-close-cred]').forEach((el) => el.addEventListener('click', () => closeModal('modal-cred')));
document.querySelectorAll('[data-close-hook]').forEach((el) => el.addEventListener('click', () => closeModal('modal-hook')));
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') { closeModal('modal-add'); closeModal('modal-cred'); closeModal('modal-hook'); }
});

/** webhook 弹窗：展示该仓库的推送地址（平台被动接收；需在 Git 平台侧配置） */
function openHookModal(slug) {
  if (!ensureToken()) return;
  const repo = lastRepos.find((r) => r.slug === slug);
  document.getElementById('hook-slug').textContent = slug;
  document.getElementById('hook-url').value = repo && repo.webhookSecret
    ? location.origin + '/api/webhooks/' + slug + '?secret=' + repo.webhookSecret
    : '（该仓库无 secret——移除后重新添加以生成）';
  document.getElementById('hookMsg').textContent = '';
  openModal('modal-hook');
}
document.getElementById('btn-hook-copy').addEventListener('click', async () => {
  const url = document.getElementById('hook-url').value;
  const msg = document.getElementById('hookMsg');
  try {
    await navigator.clipboard.writeText(url);
    msg.className = 'msg ok'; msg.textContent = '已复制——粘贴到 Git 平台的 webhook 地址栏。';
  } catch {
    document.getElementById('hook-url').select();
    msg.className = 'msg err'; msg.textContent = '复制失败，已选中文本请手动复制（Ctrl/Cmd+C）。';
  }
});
document.getElementById('btn-open-add').addEventListener('click', () => {
  document.getElementById('repoMsg').textContent = '';
  openModal('modal-add');
  document.getElementById('f-url').focus();
});
// 从首页「＋ 添加仓库」带 #add 进入：自动展开弹窗；loadRepos 完成后若仍有 hash 也补开一次
function maybeOpenAddFromHash() {
  if (location.hash === '#add') openModal('modal-add');
}
maybeOpenAddFromHash();
window.addEventListener('hashchange', maybeOpenAddFromHash);

let credSlug = '';
function openCredModal(slug) {
  if (!ensureToken()) return;
  credSlug = slug;
  document.getElementById('cred-slug').textContent = slug;
  document.getElementById('c-user').value = '';
  document.getElementById('c-pass').value = '';
  document.getElementById('credMsg').textContent = '';
  openModal('modal-cred');
  document.getElementById('c-user').focus();
}
document.getElementById('btn-cred-save').addEventListener('click', async () => {
  const msg = document.getElementById('credMsg');
  const username = document.getElementById('c-user').value.trim();
  const password = document.getElementById('c-pass').value;
  if (!username && !password) { msg.className = 'msg err'; msg.textContent = '用户名与密码 / Token 至少填一项。'; return; }
  try {
    await api('/api/repos/' + encodeURIComponent(credSlug) + '/credential', { method: 'PUT', body: JSON.stringify({ username, password }) });
    msg.className = 'msg ok';
    msg.textContent = '已保存（下次同步 / 重建时生效）';
    loadRepos();
  } catch (e) { msg.className = 'msg err'; msg.textContent = e.message; }
});
document.getElementById('btn-cred-clear').addEventListener('click', async () => {
  if (!confirm('清除仓库 ' + credSlug + ' 的 git 凭证？')) return;
  const msg = document.getElementById('credMsg');
  try {
    await api('/api/repos/' + encodeURIComponent(credSlug) + '/credential', { method: 'DELETE' });
    msg.className = 'msg ok';
    msg.textContent = '凭证已清除';
    loadRepos();
  } catch (e) { msg.className = 'msg err'; msg.textContent = e.message; }
});

/* ---------- 添加仓库（含 URL → slug/显示名自动提取） ---------- */

const slugInput = document.getElementById('f-slug');
const nameInput = document.getElementById('f-name');
const urlInput = document.getElementById('f-url');
let slugTouched = false;
let nameTouched = false;
slugInput.addEventListener('input', () => { slugTouched = true; });
nameInput.addEventListener('input', () => { nameTouched = true; });

function repoNameFromUrl(value) {
  const trimmed = String(value).trim().replace(/[/]+$/, '');
  const segment = trimmed.split(/[/:]/).pop() || '';
  let name = segment;
  try { name = decodeURIComponent(segment); } catch (e) { /* 编码异常时按原文处理 */ }
  return name.replace(/[.]git$/i, '');
}
function toSlug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
urlInput.addEventListener('input', () => {
  const name = repoNameFromUrl(urlInput.value);
  if (!name) return;
  if (!slugTouched) slugInput.value = toSlug(name);
  if (!nameTouched) nameInput.value = name;
});

document.getElementById('btn-add').addEventListener('click', async () => {
  const btn = document.getElementById('btn-add');
  const msg = document.getElementById('repoMsg');
  if (!ensureToken()) {
    msg.className = 'msg err';
    msg.textContent = '请先在「运维 token」处输入并保存，再提交。';
    return;
  }
  const gitUser = document.getElementById('f-git-user').value.trim();
  const gitPass = document.getElementById('f-git-pass').value;
  const body = {
    slug: slugInput.value.trim(),
    name: nameInput.value.trim(),
    url: urlInput.value.trim(),
    branches: document.getElementById('f-branches').value.split(',').map((s) => s.trim()).filter(Boolean),
    contentOverride: document.getElementById('f-override').value || null,
  };
  if (gitUser || gitPass) body.credential = { username: gitUser, password: gitPass };
  btn.disabled = true;
  msg.className = 'msg';
  msg.textContent = '提交中…';
  try {
    await api('/api/repos', { method: 'POST', body: JSON.stringify(body) });
    msg.className = 'msg ok';
    msg.textContent = '已提交：克隆与首次索引进行中，稍后在上方列表查看状态。';
    slugInput.value = '';
    nameInput.value = '';
    urlInput.value = '';
    document.getElementById('f-git-pass').value = '';
    slugTouched = false;
    nameTouched = false;
    closeModal('modal-add');
    loadRepos();
  } catch (e) {
    msg.className = 'msg err';
    msg.textContent = '失败：' + e.message;
  } finally { btn.disabled = false; }
});

/* ---------- 全局配置 ---------- */

async function loadGlobal() {
  try {
    const { global } = await api('/api/config');
    document.getElementById('g-autoFetch').value = global.autoFetch;
    document.getElementById('g-fetchIntervalSec').value = global.fetchIntervalSec;
    document.getElementById('g-autoBuild').value = String(global.autoBuild);
    document.getElementById('g-cleanupCron').value = global.cleanupCron;
  } catch (e) { document.getElementById('cfgMsg').textContent = e.message; }
}
document.getElementById('btn-save-global').addEventListener('click', async () => {
  if (!ensureToken()) return;
  const msg = document.getElementById('cfgMsg');
  try {
    await api('/api/config', { method: 'PUT', body: JSON.stringify({ global: {
      autoFetch: document.getElementById('g-autoFetch').value,
      fetchIntervalSec: Number(document.getElementById('g-fetchIntervalSec').value),
      autoBuild: document.getElementById('g-autoBuild').value === 'true',
      cleanupCron: document.getElementById('g-cleanupCron').value,
    }})});
    msg.className = 'msg ok';
    msg.textContent = '已保存';
  } catch (e) {
    msg.className = 'msg err';
    msg.textContent = '失败：' + e.message;
  }
});

/* ---------- 索引任务记录 ---------- */

async function loadBuilds() {
  const el = document.getElementById('buildList');
  try {
    const { builds } = await api('/api/builds');
    if (!builds.length) { el.innerHTML = '<p class="empty">暂无索引任务。</p>'; return; }
    let html = '<table><thead><tr><th>时间</th><th>仓库 / 分支</th><th>提交</th><th>状态</th><th>耗时</th><th></th></tr></thead><tbody>';
    for (const b of builds) {
      const cls = b.status === 'success' ? 'ok' : b.status === 'failed' ? 'err' : 'warn';
      html += '<tr><td class="sub" style="margin:0">' + esc(String(b.startedAt || '').replace('T', ' ').slice(0, 19)) + '</td>' +
        '<td>' + esc(b.repo || '') + ' @ ' + esc(b.branch || '') + '</td>' +
        '<td class="sub" style="margin:0">' + esc(String(b.commit || '').slice(0, 7)) + '</td>' +
        '<td><span class="badge ' + cls + '">' + esc(b.status) + '</span></td>' +
        '<td>' + Math.round((b.durationMs || 0) / 1000) + 's</td>' +
        '<td><button class="btn sm" data-log="' + esc(b.id) + '">日志</button></td></tr>';
    }
    el.innerHTML = html + '</tbody></table>';
  } catch (e) { el.innerHTML = '<p class="empty">' + esc(e.message) + '</p>'; }
}
document.getElementById('buildList').addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-log]');
  if (!btn) return;
  showLog(btn.dataset.log);
});
async function showLog(id) {
  ensureToken();
  try {
    const { log } = await api('/api/builds/' + encodeURIComponent(id) + '/log');
    const v = document.getElementById('logView');
    v.style.display = 'block';
    v.textContent = log || '（无日志）';
  } catch (e) { alert(e.message); }
}

/* ---------- 审计日志 ---------- */

async function loadAudit() {
  ensureToken();
  try {
    const { lines } = await api('/api/audit');
    document.getElementById('auditView').textContent = lines.length ? lines.join('\\n') : '（空）';
  } catch (e) { document.getElementById('auditView').textContent = e.message; }
}

/* ---------- 运维 token（三处共用一键：文档站运维面板 / 门户 / 管理页） ---------- */
function showTokenRow(msg) {
  const row = document.getElementById('tokenRow');
  if (!row) return;
  row.classList.add('on');
  const input = document.getElementById('f-token');
  if (input && !input.value) input.value = token();
  const msgEl = document.getElementById('tokenMsg');
  if (msgEl) msgEl.textContent = msg || '';
}
document.getElementById('showToken').addEventListener('click', (ev) => {
  ev.preventDefault();
  showTokenRow('');
});
// 未解锁占位区的「输入运维 token」按钮：展开 token 行（不绕过门禁，token 仍走同一保存/校验路径）
document.getElementById('btn-locked-token').addEventListener('click', () => { showTokenRow(''); });
document.getElementById('btn-token-hide').addEventListener('click', () => {
  document.getElementById('tokenRow').classList.remove('on');
});
document.getElementById('btn-token-save').addEventListener('click', () => {
  const value = document.getElementById('f-token').value.trim();
  if (value) localStorage.setItem(TOKEN_KEY, value);
  else localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(LEGACY_TOKEN_KEY);
  location.reload();
});

loadRepos();
</script>
</body>
</html>`
}
