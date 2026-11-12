---
name: docs-plugin-audio
description: docvi 音频场景组件包——提供频谱引擎图、波形包络图、钢琴卷帘图三个音频可视化视图。这些是 docvi 专有的非标准 Markdown 扩展（只有本平台能渲染），仅在用户明确需要音频可视化时使用；写普通文档请用标准 Markdown 与 mermaid。
---

# docvi 音频场景组件包（docs-plugin-audio）

> ⚠️ **可移植性边界**：本包的 3 个组件是 docvi 专有的自定义渲染扩展，**不属于通用
> Markdown**——标签只在 docvi / 本平台内渲染，文档离开后（GitHub、飞书、其它编辑器）
> 只剩裸标签与 YAML。仅在用户明确需要音频可视化、或续写已在用该写法的文档时使用；
> 用了就主动告知这个限制。

音频/编曲教学的可视化组件（3 个）——**面向音频领域的预设场景包**，与通用组件包
（docs-plugin-base，21 个）同一套声明式用法：数据放 frontmatter `components` 段、
正文用 `<at-kind data-key="键"></at-kind>` 引用（**必须闭合标签**）。

## 组件速查（3 个）

| kind                     | 用途                                                                                | 关键字段                                                   |
| ------------------------ | ----------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `audio-spectrum-diagram` | 频域频谱引擎图：bin 均匀排布 + 对数频率刻度 + 选中频段覆盖层与峰值保持线            | `bins` `frequencyScale` `selectedBand` `peakState` `title` |
| `waveform-diagram`       | 时域波形包络图：对称柱状包络 + 中轴线 + 时间刻度与播放头                            | `peaks` `position` `duration` `title`                      |
| `piano-roll`             | 钢琴卷帘图：纵轴音高（白/黑键行 + 音名）、横轴为拍，音符矩形（velocity 调不透明度） | `notes` `beats` `title`                                    |

## 数据形态要点

- `audio-spectrum-diagram`：`bins: [{ value, peak?, label? }]`（0..1 电平；`frequencyScale` 对数刻度标注、`selectedBand` 选中频段覆盖层、`peakState` 峰值保持线）；讲的是「AnalyserNode → bin → 对数像素 → 峰值保持」的频域引擎，静态教学图；
- `waveform-diagram`：`peaks: number[]`（0..1 峰值数组）、`position`（0..1 播放头位置）、`duration`（秒，配时间刻度）；讲时域峰值包络；
- `piano-roll`：`notes: [{ pitch, start, length, velocity?, label? }]`（pitch 为 MIDI 音高数值或科学音名如 'C4'、start/length 以拍计）、`beats`（总拍数）、`beatsPerBar`（缺省 4）；讲 MIDI 音符序列。

## 与通用组件包的分工

- 音频三图是**场景视图**（与特定领域绑定）；流程/状态机/表设计/接口清单等**通用视图**在
  docs-plugin-base 包——写音频文档时两类组件可以混用（如频谱图 + TableTabs 讲数据协议）。
- 用法与硬规则（YAML 引号、data-key 引用、占位行为）与通用包完全一致，见 docs-plugin-base/docs/SKILL.md。
