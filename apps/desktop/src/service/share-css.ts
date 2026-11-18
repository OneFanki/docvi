/**
 * 分享页要内联的样式文本（打包器 `?raw` 导入）。
 *
 * 为什么单独成模块、且只由服务入口 import：`?raw` 是**打包器语义**（Vite /
 * electron-vite 把文件内容读成字符串），Node 直接 import 会按扩展名解析 `.css`
 * 而报 `ERR_UNKNOWN_FILE_EXTENSION`。把它挡在单测不经过的路径上，
 * `createShareRenderer` 就只收一个普通字符串——测试可以传任意占位样式，
 * 不必为跑断言起打包器。
 *
 * 内联而不是外链的原因：分享页跑在别人的机器上，服务只有 `/s/<id>/` 一个
 * 命名空间，为几份 CSS 再开一组静态路由既多一处攻击面，也多一处 404 的机会。
 */
import docCss from '../../../../packages/renderer-core/src/styles/doc.css?raw'
import themeCss from '../../../../packages/renderer-core/src/styles/theme.css?raw'

/** 主题变量 + 正文排版：与桌面阅读态同一份源码 */
export const shareBaseCss = `${themeCss}\n\n${docCss}`
