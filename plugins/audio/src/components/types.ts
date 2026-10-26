/**
 * 业务组件数据协议（与特定领域绑定；随本目录一起移除）。
 */

/** AudioSpectrumDiagram 的一个频率柱（bin） */
export interface SpectrumBin {
  /** 柱高 / 电平（0..1，绘制时按峰值归一）；缺省 0 */
  value?: number
  /** 峰值保持高度（0..1，可选：峰值引擎输出） */
  peak?: number
  /** 该柱标签（可选） */
  label?: string
}

/** AudioSpectrumDiagram 的频率刻度（横轴） */
export interface SpectrumScale {
  /** 刻度模式：log（对数，人耳感知，默认） / linear（线性） */
  mode: 'log' | 'linear'
  /** 显示下限频率 Hz（默认 20） */
  min?: number
  /** 显示上限频率 Hz（默认 20000） */
  max?: number
  /** 主要刻度频率 Hz（缺省按对数自动 20/50/100/200/500/1k/2k/5k/10k/20k） */
  ticks?: number[]
}

/** AudioSpectrumDiagram 的选中频段（覆盖层高亮） */
export interface SpectrumBand {
  /** 起始 bin 索引 */
  start: number
  /** 结束 bin 索引 */
  end: number
  /** 频段标签（如「低音 20–300 Hz」） */
  label?: string
}

/** AudioSpectrumDiagram 的峰值引擎状态 */
export interface SpectrumPeak {
  /** 是否启用峰值保持（缺省 false） */
  enabled?: boolean
  /** 峰值衰减速度 dB/s（如 28） */
  decayPerSec?: number
}

/** PianoRoll 的一个音符 */
export interface PianoNote {
  /** 音高：MIDI 数字，或科学音名（如 'C4' = 60） */
  pitch: number | string
  /** 起始拍（0 基） */
  start: number
  /** 长度（拍） */
  length: number
  /** 力度 0..1（缺省 0.8；决定矩形不透明度） */
  velocity?: number
  /** 备注（悬浮提示显示，如「底鼓」） */
  label?: string
}
