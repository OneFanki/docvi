/**
 * docs-plugin-base —— 通用组件包（预设包）入口。
 *
 * 协议 v1：宿主加载本入口后调用 activate(host)，逐个 registerKind 注册组件；
 * 组件在文档内以 `<at-<kind> data-key="键">` 使用（声明式数据桥由宿主提供）。
 *
 * ⚠️ 同一事实两处同步：本文件 KINDS 表（登记 + 描述）与包根 plugin.json 的
 * components 段（MCP / 技能聚合 / 运维展示的数据源）必须逐项一致——
 * scripts/plugins.test.mjs 有一致性守卫，改动时同步两处。
 *
 * ESM 入口构建约束（scripts/build-plugins.mjs）：external vue——运行时经宿主
 * import map 解析到壳的单一 Vue 实例，禁止内置 Vue 副本。
 */
import type { Component } from 'vue'
import ApiContract from './components/ApiContract.vue'
import CallTree from './components/CallTree.vue'
import ChangeList from './components/ChangeList.vue'
import Checklist from './components/Checklist.vue'
import CodeBlock from './components/CodeBlock.vue'
import CodeWalkthrough from './components/CodeWalkthrough.vue'
import DebugTable from './components/DebugTable.vue'
import DecisionCard from './components/DecisionCard.vue'
import DiffView from './components/DiffView.vue'
import EndpointList from './components/EndpointList.vue'
import EvidenceNote from './components/EvidenceNote.vue'
import FileTree from './components/FileTree.vue'
import FlowDiagram from './components/FlowDiagram.vue'
import HtmlEmbed from './components/HtmlEmbed.vue'
import MessageFlow from './components/MessageFlow.vue'
import MetricRow from './components/MetricRow.vue'
import MergedTable from './components/MergedTable.vue'
import NextUp from './components/NextUp.vue'
import RiskList from './components/RiskList.vue'
import StateFlow from './components/StateFlow.vue'
import TableGraph from './components/TableGraph.vue'
import TableTabs from './components/TableTabs.vue'
import Timeline from './components/Timeline.vue'
import TutorialShell from './components/TutorialShell.vue'

/** 宿主注入的插件 API（协议 v1；契约详见包内 docs/SKILL.md 与平台设计稿） */
export interface PluginHost {
  /** 宿主 API 大版本：与 plugin.json 的 apiVersion 不匹配时宿主拒载本包 */
  apiVersion: string
  /** 平台版本（诊断用） */
  platformVersion: string
  /** 注册组件：kind 为文档标签名（at-<kind>）；已停用 / 重复的 kind 由宿主拦截为 no-op */
  registerKind(
    kind: string,
    component: Component,
    meta: { title: string; description: string },
  ): void
}

interface KindEntry {
  kind: string
  title: string
  description: string
  component: Component
}

/** kind → 组件（description 为 AI 选型的第一依据：一句话说清「这个组件是干什么的」） */
const KINDS: KindEntry[] = [
  {
    kind: 'tutorial-shell',
    title: '教程页壳',
    description: '课程页页眉：课程名 + 第几步/共几步 + 学习目标，不渲染 H1',
    component: TutorialShell,
  },
  {
    kind: 'flow-diagram',
    title: '流程图',
    description: '有序流程：节点 + 带标注连线，点节点可下钻',
    component: FlowDiagram,
  },
  {
    kind: 'file-tree',
    title: '教学目录树',
    description: '教学目录树 + 每个文件/目录的职责说明，可折叠',
    component: FileTree,
  },
  {
    kind: 'call-tree',
    title: '调用树',
    description: '调用链视图：谁调用了谁，可折叠',
    component: CallTree,
  },
  {
    kind: 'code-walkthrough',
    title: '代码走读',
    description: '分步代码讲解：行号 + 每步高亮 + 上一步/下一步',
    component: CodeWalkthrough,
  },
  {
    kind: 'code-block',
    title: '代码块',
    description: '带文件名的代码块 + 出处徽标 + 一键复制',
    component: CodeBlock,
  },
  {
    kind: 'decision-card',
    title: '设计决策卡',
    description: '关键设计决策：决策 + 原因 + 证据（正反两种视觉）',
    component: DecisionCard,
  },
  {
    kind: 'checklist',
    title: '验收清单',
    description: '验收/自检清单：勾选 + 进度 + localStorage 记忆',
    component: Checklist,
  },
  {
    kind: 'next-up',
    title: '下一步卡',
    description: '阅读收尾的下一步指引卡（多目标 + 徽标）',
    component: NextUp,
  },
  {
    kind: 'api-contract',
    title: '模块契约',
    description: '模块输入/输出契约与不变量（讲清谁喂什么、吐给谁）',
    component: ApiContract,
  },
  {
    kind: 'endpoint-list',
    title: '接口清单',
    description: 'HTTP 接口清单：默认折叠点击展开；支持非 HTTP 出口（WS/EVENT/INTERNAL）',
    component: EndpointList,
  },
  {
    kind: 'table-tabs',
    title: '表设计页签',
    description: '数据库表结构：一表一页签逐字段全量展开（含关系脚注）',
    component: TableTabs,
  },
  {
    kind: 'table-graph',
    title: '表关系图',
    description: '表关系概览：分层表卡 + 外键连线到字段级（悬停高亮链路）',
    component: TableGraph,
  },
  {
    kind: 'evidence-note',
    title: '证据卡',
    description: '教学片段与真实项目快照的证据关联卡',
    component: EvidenceNote,
  },
  {
    kind: 'debug-table',
    title: '排障表',
    description: '按症状/严重度筛选的故障排查表',
    component: DebugTable,
  },
  {
    kind: 'diff-view',
    title: '差异视图',
    description: '演进/重构 diff 视图：+/- 着色、统计、一键复制',
    component: DiffView,
  },
  {
    kind: 'html-embed',
    title: 'HTML 内嵌',
    description: '单文件 HTML 图解内嵌（sandbox iframe，零外部请求）',
    component: HtmlEmbed,
  },
  {
    kind: 'state-flow',
    title: '状态机图',
    description: '状态流转图：分层布局 + 连线，current 状态高亮',
    component: StateFlow,
  },
  {
    kind: 'message-flow',
    title: '消息时序图',
    description: '可步进的时序图：泳道 + 单步高亮',
    component: MessageFlow,
  },
  {
    kind: 'metric-row',
    title: '指标卡组',
    description: '指标卡：数值 + 变化 + 语义色',
    component: MetricRow,
  },
  {
    kind: 'timeline',
    title: '时间轴',
    description: '竖向时间轴：时间 + 标题 + 状态色',
    component: Timeline,
  },
  {
    kind: 'change-list',
    title: '改动清单',
    description: '本次改动清单：编号 + 说明 + 涉及模块徽标，可标新增/变更/移除',
    component: ChangeList,
  },
  {
    kind: 'risk-list',
    title: '风险清单',
    description: '已知风险：严重度 + 影响 + 当前处置，区分本方案已处理 / 待独立处理',
    component: RiskList,
  },
  {
    /*
     * 合并单元格表格：靠 `::: merged` 容器语法写事件数据。
     *
     * 早先它是独立插件包（只有这一个组件 + 一条语法 + 一个主题）——用户判断
     * 「一个插件里就一个组件不合适」，并入通用包。并入后它的核心约束没变：
     * 原生 Markdown 表达不了合并单元格，所以数据放在围栏块里而不是 frontmatter
     * 的 components 段（其余组件都走后者）。
     */
    kind: 'merged-table',
    title: '合并单元格表格',
    description:
      '原生 Markdown 表达不了合并单元格；用 ::: merged 容器里的 YAML 描述 rowspan/colspan',
    component: MergedTable,
  },
]

/** 插件入口（宿主调用）：注册本包全部组件 */
export function activate(host: PluginHost): void {
  for (const entry of KINDS) {
    host.registerKind(entry.kind, entry.component, {
      title: entry.title,
      description: entry.description,
    })
  }
}
