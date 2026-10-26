/**
 * 容器端 MCP 端点适配层。
 *
 * 协议实现已下沉到 `packages/server/src/mcp.mjs`（与桌面 app 共用同一份）——
 * 本文件只保留 re-export，避免两处各改一份导致口径漂移。
 * 依赖注入在 `httpd.mjs` 侧组装（活查询：插件启停 / 组件启停 / 升级即查询即变）。
 */
export { handleMcp } from '../../packages/server/src/mcp.mjs'
