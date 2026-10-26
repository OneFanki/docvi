/**
 * 容器端临时分享服务适配层。
 *
 * 实现在 `packages/server/src/shares.mjs`（与桌面 app 共用同一份）。
 * 容器侧差异：注入共享根（SHARE_ROOTS）与审计回调；共享根非空即启用路径约束。
 * 旧版 shares.yaml 由服务层自动读取并在下次写入时转为 shares.json。
 */
import { createSharesService as createBase } from '../../packages/server/src/shares.mjs'
import { audit } from './store.mjs'

export { SHARE_ID_RE, ShareError } from '../../packages/server/src/shares.mjs'

/**
 * @param {object} options
 * @param {string} options.dataDir 数据目录
 * @param {string[]} [options.shareRoots] 共享根（容器挂载进来的目录）
 * @param {(dataDir: string, entry: object) => void} [options.audit] 审计实现（缺省写 audit.log）
 */
export function createSharesService({ dataDir, shareRoots = [], audit: writeAudit }) {
  return createBase({
    dataDir,
    shareRoots,
    audit: writeAudit
      ? (type, payload) => writeAudit(dataDir, { type, ...payload })
      : (type, payload) => audit(dataDir, { type, ...payload }),
  })
}
