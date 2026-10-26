import { app, net } from 'electron'

import type { RuntimeInfo, UpdateCheckResult } from '@docvi/shared'

import { compareVersions, trustedHttpsUrl } from './version.ts'

/**
 * 关于信息与更新检查。
 *
 * **这一版只检查、不自动安装。**
 *
 * 完整自动更新（下载 → 校验 → 替换 → 重启）需要三件前提，缺一不可：
 *  1. **可信的发布源**：固定的 HTTPS 域名 + 每版本清单，且清单本身要防篡改；
 *  2. **资产完整性校验**：按平台/架构精确匹配文件名 + SHA-256 比对，校验失败
 *     必须删文件不执行；
 *  3. **签名**：否则安装后系统仍会提示「未知发布者」，而静默替换可执行文件
 *     恰恰是最不能被误用的能力。
 *
 * 当前仓还没有确定的发布渠道（开源仓与 Release 流程尚未建立），此时把
 * 「下载并执行」写进产品等于把安全边界降级成口头承诺。所以这里只做能诚实交付的
 * 那一半：读发布清单、比对版本、把下载页交给系统浏览器。渠道就绪后，
 * 在这个文件里补下载与校验即可，调用方（关于面板）的契约不用改。
 */

/** 发布清单地址：可用环境变量覆盖（CI / 内测指向不同渠道） */
const UPDATE_MANIFEST_URL =
  process.env.DOCVI_UPDATE_MANIFEST_URL?.trim() ||
  'https://raw.githubusercontent.com/OneFanki/docvi/main/latest.json'

/** 检查超时：离线环境下不该让「关于」面板挂在那儿转圈 */
const CHECK_TIMEOUT_MS = 6000

export function runtimeInfo(): RuntimeInfo {
  return {
    version: app.getVersion(),
    electron: process.versions.electron ?? null,
    chrome: process.versions.chrome ?? null,
    node: process.versions.node ?? null,
    v8: process.versions.v8 ?? null,
    platform: process.platform,
    arch: process.arch,
    dataDir: app.getPath('userData'),
    packaged: app.isPackaged,
    ...(process.env.DOCVI_HOMEPAGE ? { homepage: process.env.DOCVI_HOMEPAGE.trim() } : {}),
  }
}

interface Manifest {
  version?: unknown
  downloadUrl?: unknown
  notes?: unknown
  homepage?: unknown
}

/** 从清单里取字段（形状不可信：清单是外部文件，逐字段校验） */
function field(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export async function checkForUpdate(): Promise<UpdateCheckResult> {
  const current = app.getVersion()
  const checkedAt = Date.now()

  if (!UPDATE_MANIFEST_URL) {
    return {
      status: 'unavailable',
      current,
      checkedAt,
      message: '未配置发布清单地址',
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS)
  try {
    /*
     * 用 `net.fetch`（Chromium 网络栈）而不是全局 fetch：Node 的 fetch 不读
     * 系统代理，在必须走代理才能访问 GitHub 的网络里永远超时——「关于」面板
     * 会一直显示「检查失败」，看起来像功能坏了。
     */
    const res = await net.fetch(UPDATE_MANIFEST_URL, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
      redirect: 'follow',
    })
    if (!res.ok) {
      /*
       * 404 与其它状态分开说：仓库还私有、发版分支不对、清单没提交，都会是 404。
       * 「HTTP 404」单独抛出去，用户才知道该去查仓库可见性而不是网络。
       */
      return {
        status: 'unavailable',
        current,
        checkedAt,
        message:
          res.status === 404
            ? '发布清单不可达（HTTP 404）——仓库可能仍是私有，或还没有 latest.json'
            : `发布清单不可达（HTTP ${res.status}）`,
      }
    }
    const manifest = (await res.json()) as Manifest
    const latest = field(manifest.version)
    if (!latest) {
      return { status: 'unavailable', current, checkedAt, message: '发布清单缺少 version 字段' }
    }
    if (compareVersions(latest, current) <= 0) {
      return { status: 'latest', current, latest, checkedAt }
    }
    return {
      status: 'outdated',
      current,
      latest,
      checkedAt,
      ...(trustedHttpsUrl(field(manifest.downloadUrl))
        ? { downloadUrl: trustedHttpsUrl(field(manifest.downloadUrl)) as string }
        : {}),
      ...(field(manifest.notes) ? { notes: field(manifest.notes) as string } : {}),
    }
  } catch (error) {
    const reason = (error as Error).name === 'AbortError' ? '检查超时' : (error as Error).message
    return { status: 'unavailable', current, checkedAt, message: reason }
  } finally {
    clearTimeout(timer)
  }
}
