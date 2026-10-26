# 业务组件示例（AudioSpectrumDiagram）

本课程演示**业务组件**——与特定领域（音频 / 频谱）强绑定的组件。它们与通用组件分开维护，方便在不需要该领域的部署里**整体移除**。

## 移除契约（不需要音频领域时）

三处一起删除即可，平台其余部分不受影响：

1. 源码：`plugins/audio/`（整个插件包目录）
2. 示例内容：`courses/business-showcase/`（整个目录）+ `courses/docs.config.yaml` 里的「业务组件示例」树根行
3. 注册：`plugins/audio/src/index.ts` 的 `KINDS` 表与包根 `plugin.json` 的 `components` 段

## 当前业务组件

| 组件 | 用途 | 关键 props | 演示 |
| --- | --- | --- | --- |
| `<AudioSpectrumDiagram>` | 频域教学图：bin 电平柱 + 对数频率轴 + 选中频段 + 峰值保持线 | `bins` `frequencyScale` `selectedBand` `peakState` | [01 · 频谱图演示](chapters/01-频谱图演示) |
| `<WaveformDiagram>` | 时域波形教学图：对称峰值包络 + 时间刻度 + 播放头 | `peaks` `duration` `position` | [02 · 波形与卷帘](chapters/02-波形与卷帘) |
| `<PianoRoll>` | 钢琴卷帘教学图：音高纵轴 + 拍横轴，音符矩形按 velocity 调透明度 | `notes` `beats` `beatsPerBar` | [02 · 波形与卷帘](chapters/02-波形与卷帘) |

演示见 [01 · 频谱图演示](chapters/01-频谱图演示) 与 [02 · 波形与卷帘](chapters/02-波形与卷帘)。

> 组件协议与数据协议（业务部分）见 `plugins/audio/src/components/types.ts`；通用组件见左侧树「内建组件」。
