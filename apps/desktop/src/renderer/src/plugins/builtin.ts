/**
 * 内置组件表（随应用一起构建）。
 *
 * 每个条目带 `plugin` 归属：插件面板停用某个包时，宿主按这个字段整组跳过注册，
 * 于是该包的组件全部退回「组件未注册」占位，主题与语法扩展同时失效。
 *
 * 为什么内置包走静态 import 而不是运行时动态 import：
 *  - 源码是 .vue，运行时无法直接 import（需要编译）；
 *  - 打进主包后原生 Vue 渲染零桥接开销；
 *  - 第三方插件仍走 manifest + 预构建 ESM 那条路（必须自带构建产物）。
 *
 * kind 表与各插件 plugin.json 的 components 段必须一致
 * （scripts/plugins.test.mjs 有一致性守卫）。
 */
import type { Component } from 'vue'

import ApiContract from '@plugins/base/src/components/ApiContract.vue'
import CallTree from '@plugins/base/src/components/CallTree.vue'
import ChangeList from '@plugins/base/src/components/ChangeList.vue'
import Checklist from '@plugins/base/src/components/Checklist.vue'
import CodeBlock from '@plugins/base/src/components/CodeBlock.vue'
import CodeWalkthrough from '@plugins/base/src/components/CodeWalkthrough.vue'
import DebugTable from '@plugins/base/src/components/DebugTable.vue'
import DecisionCard from '@plugins/base/src/components/DecisionCard.vue'
import DiffView from '@plugins/base/src/components/DiffView.vue'
import EndpointList from '@plugins/base/src/components/EndpointList.vue'
import EvidenceNote from '@plugins/base/src/components/EvidenceNote.vue'
import FileTree from '@plugins/base/src/components/FileTree.vue'
import FlowDiagram from '@plugins/base/src/components/FlowDiagram.vue'
import HtmlEmbed from '@plugins/base/src/components/HtmlEmbed.vue'
import MessageFlow from '@plugins/base/src/components/MessageFlow.vue'
import MetricRow from '@plugins/base/src/components/MetricRow.vue'
import NextUp from '@plugins/base/src/components/NextUp.vue'
import RiskList from '@plugins/base/src/components/RiskList.vue'
import StateFlow from '@plugins/base/src/components/StateFlow.vue'
import TableGraph from '@plugins/base/src/components/TableGraph.vue'
import TableTabs from '@plugins/base/src/components/TableTabs.vue'
import Timeline from '@plugins/base/src/components/Timeline.vue'
import TutorialShell from '@plugins/base/src/components/TutorialShell.vue'

// 场景包：音频三图（随应用内置的可选包，与 base 同一套协议）
import AudioSpectrumDiagram from '@plugins/audio/src/components/AudioSpectrumDiagram.vue'
import PianoRoll from '@plugins/audio/src/components/PianoRoll.vue'
import WaveformDiagram from '@plugins/audio/src/components/WaveformDiagram.vue'

// 结构化块：Markdown 表达不了的排版（合并单元格）走 ::: 块 + 组件，归属 base 包
import MergedTable from '@plugins/base/src/components/MergedTable.vue'

export interface BuiltinKind {
  /** 归属插件包（plugin.json 的 name）；面板启停按它整体门控 */
  plugin: string
  kind: string
  title: string
  description: string
  component: Component
}

/** 与 plugin.json 的 components 段逐项对应（title/description 即面板与 AI 选型依据） */
export const BUILTIN_KINDS: BuiltinKind[] = [
  {
    plugin: 'docs-plugin-base',
    kind: 'tutorial-shell',
    title: '教程页壳',
    description: '课程页页眉：课程名 + 第几步/共几步 + 学习目标，不渲染 H1',
    component: TutorialShell,
  },
  {
    plugin: 'docs-plugin-base',
    kind: 'flow-diagram',
    title: '流程图',
    description: '有序流程：节点 + 带标注连线，点节点可下钻',
    component: FlowDiagram,
  },
  {
    plugin: 'docs-plugin-base',
    kind: 'file-tree',
    title: '教学目录树',
    description: '教学目录树 + 每个文件/目录的职责说明，可折叠',
    component: FileTree,
  },
  {
    plugin: 'docs-plugin-base',
    kind: 'call-tree',
    title: '调用树',
    description: '调用链视图：谁调用了谁，可折叠',
    component: CallTree,
  },
  {
    plugin: 'docs-plugin-base',
    kind: 'code-walkthrough',
    title: '代码走读',
    description: '分步代码讲解：行号 + 每步高亮 + 上一步/下一步',
    component: CodeWalkthrough,
  },
  {
    plugin: 'docs-plugin-base',
    kind: 'code-block',
    title: '代码块',
    description: '带文件名的代码块 + 出处徽标 + 一键复制',
    component: CodeBlock,
  },
  {
    plugin: 'docs-plugin-base',
    kind: 'decision-card',
    title: '设计决策卡',
    description: '关键设计决策：决策 + 原因 + 证据（正反两种视觉）',
    component: DecisionCard,
  },
  {
    plugin: 'docs-plugin-base',
    kind: 'checklist',
    title: '验收清单',
    description: '验收/自检清单：勾选 + 进度 + localStorage 记忆',
    component: Checklist,
  },
  {
    plugin: 'docs-plugin-base',
    kind: 'next-up',
    title: '下一步卡',
    description: '阅读收尾的下一步指引卡（多目标 + 徽标）',
    component: NextUp,
  },
  {
    plugin: 'docs-plugin-base',
    kind: 'api-contract',
    title: '模块契约',
    description: '模块输入/输出契约与不变量（讲清谁喂什么、吐给谁）',
    component: ApiContract,
  },
  {
    plugin: 'docs-plugin-base',
    kind: 'endpoint-list',
    title: '接口清单',
    description: 'HTTP 接口清单：默认折叠点击展开；支持非 HTTP 出口（WS/EVENT/INTERNAL）',
    component: EndpointList,
  },
  {
    plugin: 'docs-plugin-base',
    kind: 'table-tabs',
    title: '表设计页签',
    description: '数据库表结构：一表一页签逐字段全量展开（含关系脚注）',
    component: TableTabs,
  },
  {
    plugin: 'docs-plugin-base',
    kind: 'table-graph',
    title: '表关系图',
    description: '表关系概览：分层表卡 + 外键连线到字段级（悬停高亮链路）',
    component: TableGraph,
  },
  {
    plugin: 'docs-plugin-base',
    kind: 'evidence-note',
    title: '证据卡',
    description: '教学片段与真实项目快照的证据关联卡',
    component: EvidenceNote,
  },
  {
    plugin: 'docs-plugin-base',
    kind: 'debug-table',
    title: '排障表',
    description: '按症状/严重度筛选的故障排查表',
    component: DebugTable,
  },
  {
    plugin: 'docs-plugin-base',
    kind: 'diff-view',
    title: '差异视图',
    description: '演进/重构 diff 视图：+/- 着色、统计、一键复制',
    component: DiffView,
  },
  {
    plugin: 'docs-plugin-base',
    kind: 'html-embed',
    title: 'HTML 内嵌',
    description: '单文件 HTML 图解内嵌（sandbox iframe，零外部请求）',
    component: HtmlEmbed,
  },
  {
    plugin: 'docs-plugin-base',
    kind: 'state-flow',
    title: '状态机图',
    description: '状态流转图：分层布局 + 连线，current 状态高亮',
    component: StateFlow,
  },
  {
    plugin: 'docs-plugin-base',
    kind: 'message-flow',
    title: '消息时序图',
    description: '可步进的时序图：泳道 + 单步高亮',
    component: MessageFlow,
  },
  {
    plugin: 'docs-plugin-base',
    kind: 'metric-row',
    title: '指标卡组',
    description: '指标卡：数值 + 变化 + 语义色',
    component: MetricRow,
  },
  {
    plugin: 'docs-plugin-base',
    kind: 'timeline',
    title: '时间轴',
    description: '竖向时间轴：时间 + 标题 + 状态色',
    component: Timeline,
  },
  {
    plugin: 'docs-plugin-base',
    kind: 'change-list',
    title: '改动清单',
    description: '本次改动清单：编号 + 说明 + 涉及模块徽标，可标新增/变更/移除',
    component: ChangeList,
  },
  {
    plugin: 'docs-plugin-base',
    kind: 'risk-list',
    title: '风险清单',
    description: '已知风险：严重度 + 影响 + 当前处置，区分本方案已处理 / 待独立处理',
    component: RiskList,
  },
  {
    plugin: 'docs-plugin-audio',
    kind: 'audio-spectrum-diagram',
    title: '频谱引擎图',
    description: '频域频谱引擎图：bin 均匀排布 + 对数频率刻度 + 选中频段覆盖层与峰值保持线',
    component: AudioSpectrumDiagram,
  },
  {
    plugin: 'docs-plugin-base',
    kind: 'waveform-diagram',
    title: '波形包络图',
    description: '时域波形包络图：对称柱状包络 + 中轴线 + 时间刻度与播放头',
    component: WaveformDiagram,
  },
  {
    plugin: 'docs-plugin-base',
    kind: 'piano-roll',
    title: '钢琴卷帘图',
    description: '钢琴卷帘图：纵轴音高、横轴为拍，音符矩形按 velocity 调不透明度',
    component: PianoRoll,
  },
  {
    plugin: 'docs-plugin-base',
    kind: 'merged-table',
    title: '合并单元格表格',
    description:
      '原生 Markdown 表达不了合并单元格；用 ::: merged 容器里的 YAML 描述 rowspan/colspan',
    component: MergedTable,
  },
]
