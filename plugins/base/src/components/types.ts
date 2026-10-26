/**
 * 教学组件共享数据协议。
 *
 * 设计原则：组件是「稳定的教学 shell」，数据由教程作者在 Markdown 中静态定义
 * （或从 snippets/ 的相对文件导入），不依赖本机真实项目路径和实时文件系统。
 */

/** FileTree / DirectoryMap 的节点：静态教学目录树，每项可带职责说明 */
export interface TreeFileNode {
  /** 名称（文件名或目录名） */
  name: string
  /** 职责说明（教学用途，右侧注释） */
  note?: string
  /** 类型；缺省时按是否有 children 推断 */
  kind?: 'file' | 'dir'
  /** 子节点 */
  children?: TreeFileNode[]
  /** 初始折叠状态；缺省时前两层展开 */
  open?: boolean
}

/** FlowDiagram 的节点 */
export interface FlowNode {
  id: string
  label: string
  /** 选中节点后展示的详情说明 */
  note?: string
  /** 视觉类型：入口 / 步骤 / 判定 / 出口 */
  kind?: 'start' | 'step' | 'decision' | 'end'
}

/** FlowDiagram 的连线：from → to，可带标签 */
export interface FlowEdge {
  from: string
  to: string
  label?: string
}

/** CodeWalkthrough 的讲解步骤：高亮若干行并给出讲解 */
export interface WalkStep {
  title: string
  /** 高亮行：单行数字，或闭区间 [start, end]；可多个 */
  lines?: Array<number | [number, number]>
  /** 该步骤的讲解文字 */
  note?: string
}

/** DecisionCard 的条目：一条「关键设计决策」 */
export interface DecisionItem {
  /** 决策 / 结论（一句话） */
  decision: string
  /** 为什么这样设计（原因，可多句） */
  reason: string
  /** 佐证 / 证据：真实项目的文件路径、注释或出处（可选，mono 显示） */
  evidence?: string
  /** 类型：正向设计理由（why） / 反向避坑（avoid） */
  kind?: 'why' | 'avoid'
}

/** ChangeList 的条目：一条「本次改动」 */
export interface ChangeItem {
  /** 改动标题（如「全局清洗开关配置」） */
  title: string
  /** 一句话说明：改了什么、带来什么效果 */
  summary: string
  /** 涉及模块 / 服务名（徽标显示，如 local-server） */
  modules?: string[]
  /** 类型：新增（add，默认） / 变更（change） / 移除（remove） */
  kind?: 'add' | 'change' | 'remove'
}

/** RiskList 的条目：一条「已知风险」 */
export interface RiskItem {
  /** 风险一句话（发生了什么 / 可能发生什么） */
  risk: string
  /** 影响：不处理会怎样、会波及谁 */
  impact: string
  /** 当前处置：本方案是否修复、留给谁、验收时不能声称什么 */
  handling: string
  /** 严重度：high（红） / medium（琥珀，默认） / low（中性） */
  severity?: 'high' | 'medium' | 'low'
  /** 模块 / 环节标签（mono 显示，如「发布」「并发」） */
  tag?: string
  /** 是否已在本方案内闭环；缺省不显示状态徽标 */
  handled?: boolean
}

/** Checklist 的条目：一条验收 / 自检项 */
export interface ChecklistItem {
  /** 条目文本 */
  text: string
  /** 补充说明（可选） */
  hint?: string
}

/** NextUp 的条目：一个「下一步阅读卡」 */
export interface NextUpItem {
  /** 标题（如「05 · 编曲宿主」） */
  label: string
  /** 链接（站内路径或外部 URL；缺省则渲染为纯文本） */
  href?: string
  /** 一句话简介（可选） */
  description?: string
  /** 徽标（如「推荐」「可选」「深入」，可选） */
  badge?: string
}

/** ApiContract 的单个输入 / 输出信号口 */
export interface ApiPort {
  /** 信号名（如 ctx.state / rAF 回调 / render()） */
  name: string
  /** 类型标注（mono 显示，如 'AudioContextState' / '() => void'） */
  type: string
  /** 一句话说明：由谁产生、被谁消费、作用 */
  description: string
}

/** ApiContract 的不变量：调用方必须保证 / 组件保证的约束 */
export interface InvariantRule {
  /** 约束一句话 */
  statement: string
  /** must 正向保证（默认） / must-not 反向约束 */
  kind?: 'must' | 'must-not'
}

/** EndpointList 的单个参数：入参填 in / required，出参只填 name / type / desc */
export interface EndpointParam {
  /** 参数 / 字段名（mono 显示） */
  name: string
  /** 位置（仅入参用）：path / query / body / header */
  in?: 'path' | 'query' | 'body' | 'header'
  /** 类型（mono 显示，如 'string' / 'OrderItemInput[]'） */
  type?: string
  /** 是否必填（仅入参用） */
  required?: boolean
  /** 说明 */
  desc?: string
}

/** EndpointList 的单个端点：折叠清单一行 + 按需展开的契约详情 */
export interface EndpointSpec {
  /** 方法 / 传输类型：HTTP 方法（GET / POST / PUT / PATCH / DELETE）或非 HTTP 出口
   *  （WS 推送 / EVENT 事件出口 / INTERNAL 内部调用等，任意字符串，未知值走中性色徽标） */
  method: string
  /** 路径（mono 显示，如 /api/orders/:id/cancel） */
  path: string
  /** 一句话职责（折叠态必读项） */
  summary: string
  /** 权限门槛（公开 / 登录 / 权限码；行右侧徽章） */
  auth?: string
  /** 已退役：整行降透明度 + 路径划线 + 「已退役」徽章 */
  deprecated?: boolean
  /** 入参（展开后显示；无参数省略该节） */
  params?: EndpointParam[]
  /** 出参关键字段（展开后显示；只列契约要点，不抄全量 DTO） */
  response?: EndpointParam[]
  /** 不变量 / 关键约束（展开后显示；纯字符串按 must 正向保证） */
  invariants?: Array<string | InvariantRule>
  /** 备注（展开后显示） */
  note?: string
}

/** TableTabs 的表间关系：from → to，可带语义标注 */
export interface DataRelation {
  /** 源表名 */
  from: string
  /** 目标表名（可为站外实体名，如「用户主表」） */
  to: string
  /** 关系语义标注（如「一对多」「逻辑外键」） */
  label?: string
}

/** TableGraph 的表卡：只放关键字段（概览用，不列全量） */
export interface GraphTable {
  /** 表 id（与 relations 的 from/to 对应；建议同表名） */
  id: string
  /** 表名（mono 显示） */
  name: string
  /** 中文名 */
  cn?: string
  /** 职责一句话（可选） */
  note?: string
  /** 关键字段（主键 / 外键 / 唯一 / 状态 / 幂等键…；只列要点，不列全量） */
  fields?: GraphField[]
}

/** TableGraph 的关键字段行（TableField 的子集：概览不展示业务说明） */
export type GraphField = Pick<TableField, 'name' | 'cn' | 'type' | 'key'>

/** TableGraph 的表间关系：from = 引用方（持有外键的表），to = 被引用表 */
export interface GraphRelation {
  /** 引用方表 id（持有外键 / 引用的表） */
  from: string
  /** 被引用表 id */
  to: string
  /** 引用方字段（如 user_id） */
  fromField?: string
  /** 被引用方字段（如 id） */
  toField?: string
  /** 语义标注（如「一个用户多条订单」） */
  label?: string
  /** fk 外键引用（默认） / logical 逻辑引用（跨域弱关联，以徽标提示） */
  kind?: 'fk' | 'logical'
}

/** EvidenceNote 的真实项目快照 */
export interface ProjectSnapshot {
  /** 证据类型徽标 */
  kind?: 'commit' | 'pr' | 'snippet' | 'doc'
  /** 快照标题（commit message / PR 标题 / 片段名 / 文档名） */
  title: string
  /** 引用位置（仓库 / 路径 / commit 短哈希，mono 显示） */
  ref?: string
  /** 一句话点明该快照对应教学内容的哪一点 */
  description?: string
}

/** DebugTable 的一行故障排查条目 */
export interface DebugRow {
  /** 症状（用户可见现象） */
  symptom: string
  /** 可能原因 */
  cause: string
  /** 排查 / 解决步骤 */
  fix: string
  /** 严重级别（笑脸/图标用，缺省 info） */
  severity?: 'info' | 'warn' | 'error'
  /** 额外标签（可选，如模块名 / 环境），参与 tag 维度筛选 */
  tag?: string
}

/** DebugTable 筛选维度的单个选项 */
export interface DebugFilterOption {
  /** 匹配值（与行内字段精确相等） */
  value: string
  /** 显示名（缺省用 value） */
  label?: string
}

/** DebugTable 的一个筛选维度：按行内某字段筛 */
export interface DebugFilter {
  /** 维度名（显示在 chip 栏头部） */
  label: string
  /** 匹配的行字段：tag（自定义标签） / severity（严重级别） */
  on: 'tag' | 'severity'
  /** 该维度的选项 */
  options: DebugFilterOption[]
}

/** TableTabs 的一张表的字段行 */
export interface TableField {
  /** 字段名（mono 显示） */
  name: string
  /** 中文名 */
  cn?: string
  /** 类型（mono 显示，如 'bigint' / 'varchar(64)'） */
  type?: string
  /** 键属性徽标（如 'PK' / 'UK' / 'FK' / '索引'） */
  key?: string
  /** 业务说明 */
  note?: string
}

/** TableTabs 的一个页签 = 一张表 */
export interface TableSpec {
  /** 表名（mono 显示） */
  name: string
  /** 中文名 */
  cn?: string
  /** 职责 / 语义一句话（页签内容顶部显示） */
  note?: string
  /** 字段列表 */
  fields: TableField[]
}

/** MetricRow 的单个指标卡 */
export interface MetricItem {
  /** 指标名 */
  label: string
  /** 数值（字符串或数字） */
  value: string | number
  /** 单位（如 'ms' / '%'） */
  unit?: string
  /** 变化量文案（如 '+38%' / '−120ms'） */
  delta?: string
  /** 变化方向：只决定箭头（up ↑ / down ↓ / flat →） */
  trend?: 'up' | 'down' | 'flat'
  /** 语义色：good / bad / warn / neutral（缺省 neutral） */
  tone?: 'good' | 'bad' | 'warn' | 'neutral'
  /** 补充说明（如对照基线） */
  note?: string
}

/** Timeline 的时间轴节点 */
export interface TimelineItem {
  /** 时间标注（如 'W1' / '2026-09'） */
  time: string
  /** 标题 */
  title: string
  /** 补充说明（可选） */
  note?: string
  /** 状态：done（绿）/ active（主色，带光环）/ todo（空心）/ warn（琥珀） */
  status?: 'done' | 'active' | 'todo' | 'warn'
}

/** StateFlow 的一个状态 */
export interface StateNode {
  /** 状态 id（与转移的 from/to 对应） */
  id: string
  /** 展示名 */
  label: string
  /** 说明（可选） */
  note?: string
  /** 视觉类型：入口 / 普通状态 / 终态 / 异常态 */
  kind?: 'start' | 'state' | 'end' | 'error'
}

/** StateFlow 的一条转移：from → to */
export interface StateEdge {
  /** 源状态 id */
  from: string
  /** 目标状态 id */
  to: string
  /** 触发条件（可选，如「支付成功」） */
  label?: string
}

/** MessageFlow 的参与者（泳道列） */
export interface MessageParticipant {
  /** 参与者 id（与消息的 from/to 对应） */
  id: string
  /** 展示名 */
  label: string
  /** 说明（可选） */
  note?: string
}

/** MessageFlow 的一条消息 */
export interface MessageItem {
  /** 发送方 id（须与某参与者 id 一致） */
  from: string
  /** 接收方 id */
  to: string
  /** 消息名（如 'POST /orders'） */
  label: string
  /** 该步的补充说明（步进时展示） */
  note?: string
  /** 类型：call（实线，默认） / return（虚线响应） / async（预留） */
  kind?: 'call' | 'return' | 'async'
}

/** CallTree 的调用节点 */
export interface CallNode {
  /** 调用名（mono 显示，如 'scanDir()'） */
  name: string
  /** 职责说明（可选） */
  note?: string
  /** 元信息徽标（可选，如 '×86' / '12ms'） */
  meta?: string
  /** 子调用（可选） */
  children?: CallNode[]
  /** 初始展开状态；缺省时仅第一层展开 */
  open?: boolean
}
