/**
 * docs-plugin-audio —— 音频场景组件包入口。
 *
 * 协议 v1：宿主加载本入口后调用 activate(host)，逐个 registerKind 注册组件；
 * 组件在文档内以 `<at-<kind> data-key="键">` 使用（声明式数据桥由宿主提供）。
 * 与 plugins/base（通用包）同一协议、零特权——场景划分即插件划分
 * （设计见 docs/design/平台插件化与 AI 分发.md R2）。
 *
 * ⚠️ 同一事实两处同步：本文件 KINDS 表（登记 + 描述）与包根 plugin.json 的
 * components 段（MCP / 技能聚合 / 运维展示的数据源）必须逐项一致——
 * scripts/plugins.test.mjs 有一致性守卫，改动时同步两处。
 */
import type { Component } from 'vue'
import AudioSpectrumDiagram from './components/AudioSpectrumDiagram.vue'
import WaveformDiagram from './components/WaveformDiagram.vue'
import PianoRoll from './components/PianoRoll.vue'

/** 宿主注入的插件 API（协议 v1；与 plugins/base 入口同构） */
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

/** kind → 组件（description 为 AI 选型的第一依据） */
const KINDS: KindEntry[] = [
  {
    kind: 'audio-spectrum-diagram',
    title: '频谱引擎图',
    description:
      '频域频谱教学图：各 bin 均匀排布的声柱 + 对数频率刻度 + 选中频段覆盖层与峰值保持线（静态 SVG，0..1 电平）',
    component: AudioSpectrumDiagram,
  },
  {
    kind: 'waveform-diagram',
    title: '波形包络图',
    description: '时域波形教学图：对称柱状峰值包络 + 中轴线 + 可选时间刻度与播放头（静态 SVG）',
    component: WaveformDiagram,
  },
  {
    kind: 'piano-roll',
    title: '钢琴卷帘图',
    description:
      '音符卷帘教学图：纵轴音高（白/黑键行 + 音名）、横轴为拍，每个音符一条矩形（velocity 决定不透明度）',
    component: PianoRoll,
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
