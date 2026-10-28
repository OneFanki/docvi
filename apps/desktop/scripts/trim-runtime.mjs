/**
 * electron-builder `afterPack` 钩子：裁掉本应用用不到的运行时组件。
 *
 * ## 为什么需要这一步
 *
 * Electron 的 Windows 运行时里捆了 WebGPU 与软件光栅（SwiftShader）所需的
 * 几套编译器 / 后端库，合计解包 37MB、压缩后约 14MB。docvi 是纯 2D 界面：
 * 不用 WebGPU，也不需要软件光栅——GPU 不可用时 Chromium 会走自己的基础路径。
 *
 * 实测依据（不是猜的）：删掉这五个文件后启动应用，渲染含 mermaid 图与代码
 * 高亮的文档，标题、SVG 尺寸、Shiki 着色 span、背景色全部正常。
 *
 * ## 为什么不用 `files` 排除
 *
 * electron-builder 的 `files` 只在顶层有效；写在 `win:` 段下会被**静默忽略**
 * （配完重打包，DLL 一个没少）。未知键静默忽略是本仓已记录过的坑。
 *
 * ## 为什么只裁 Windows
 *
 * 这些是 Windows 运行时专有的文件名。mac/linux 的包里没有它们，写死删除
 * 只会让钩子在不相关的平台上空跑一遍——所以显式按 platform 判断。
 */
import { existsSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

/** 只服务 WebGPU（Dawn）与 SwiftShader 软件光栅的组件 */
const DROP_ON_WINDOWS = [
  // Dawn 的着色器编译器（最大的一块：24.6MB 原始）
  'dxcompiler.dll',
  // Dawn 的 DXIL 中间层
  'dxil.dll',
  // D3D 着色器编译（旧路径：只被 Dawn / ANGLE 的 D3D 后端用）
  'd3dcompiler_47.dll',
  // Vulkan 软件光栅（SwiftShader）
  'vk_swiftshader.dll',
  'vulkan-1.dll',
]

/**
 * @param {{ appOutDir: string, electronPlatformName: string }} context
 *
 * 注意：afterPack 的 context 里**没有** `packager.logger`（实测在 electron-builder
 * 26 上读它会抛 `Cannot read properties of undefined`，整个打包直接失败）。
 * 用 console 输出即可，构建日志会原样带出来。
 */
export default async function trimRuntime(context) {
  // electronPlatformName 是 'win32' / 'darwin' / 'linux'；win 包才需要裁
  if (context.electronPlatformName !== 'win32') return

  const dir = context.appOutDir
  let saved = 0
  for (const name of DROP_ON_WINDOWS) {
    const file = join(dir, name)
    if (!existsSync(file)) continue
    try {
      saved += statSync(file).size
      unlinkSync(file)
      console.log(`[trim-runtime] 已移除 ${name}`)
    } catch (error) {
      // 删不掉不影响打包：体积多一点，但包是完整的
      console.log(`[trim-runtime] 跳过 ${name}：${error.message}`)
    }
  }
  if (saved > 0) {
    console.log(`[trim-runtime] 共省下 ${(saved / 1024 / 1024).toFixed(1)}MB`)
  }
}
