import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'
import { join } from 'node:path'

import type { ServiceState, ShareEntry } from '@docvi/shared'

/**
 * 虚拟网卡：这些接口上的地址本机自己能连，但**局域网里的其它设备连不上**。
 *
 * 踩过的坑：WSL 的 `vEthernet (WSL)` 通常排在网卡列表前面，直接「取第一个
 * 非回环地址」会拿到 172.30.x.x，生成一条看着像样、发给同事却打不开的链接。
 */
const VIRTUAL_ADAPTER =
  /vEthernet|Hyper-V|VMware|VirtualBox|Docker|WSL|Bluetooth|蓝牙|Tailscale|ZeroTier|veth|^tun|^tap/i
/** 真实物理网卡，优先选它们 */
const PHYSICAL_ADAPTER = /Wi-?Fi|WLAN|Ethernet|以太网|无线网络连接/i

/**
 * 从网卡表里挑一个「局域网里别人能用」的 IPv4 地址。
 *
 * 抽成纯函数是为了能测：判断错一步，用户拿到的就是一条假链接，
 * 而且现象只在「发给别人」时才暴露，最难发现。
 *
 * 优先级：物理网卡 → 非虚拟网卡 → 任意（含虚拟）。全都不行时返回 null，
 * 由调用方退回 localhost——给一个能看懂的坏结果，好过给一个伪装成好结果的
 * 假地址。
 */
export function pickLanAddress(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[] | undefined>,
): string | null {
  const candidates: Array<{ name: string; address: string }> = []
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      // APIPA：没拿到 DHCP，路由不出去
      if (entry.address.startsWith('169.254.')) continue
      candidates.push({ name, address: entry.address })
    }
  }
  const physical = candidates.filter(
    item => PHYSICAL_ADAPTER.test(item.name) && !VIRTUAL_ADAPTER.test(item.name),
  )
  if (physical[0]) return physical[0].address
  const real = candidates.filter(item => !VIRTUAL_ADAPTER.test(item.name))
  if (real[0]) return real[0].address
  return candidates[0]?.address ?? null
}

/**
 * 本机在局域网里的 IPv4 地址。
 *
 * 局域网分享的链接必须用它，不能用 localhost——localhost 在别人手机上
 * 解析成手机自己，链接必然打不开。
 */
function lanAddress(): string | null {
  return pickLanAddress(networkInterfaces())
}

/**
 * 分享登记：`<dataDir>/shares.json`。
 *
 * 由服务进程独占持有——路由要用它判断「这个 id 是否存在」，也由它实时拼 URL
 * （端口与局域网开关会变）。主进程只通过 RPC 增删查，不自己也读一份，
 * 避免两处状态各自漂移。
 */

interface StoredShare {
  id: string
  path: string
  kind: 'file' | 'dir'
  createdAt: number
}

export interface ShareStore {
  list(state: Pick<ServiceState, 'port' | 'lan'>): ShareEntry[]
  find(id: string): StoredShare | undefined
  add(target: { path: string; kind: 'file' | 'dir' }): StoredShare
  remove(id: string): void
  get(id: string): StoredShare | undefined
}

export function createShareStore(file: string): ShareStore {
  let shares: StoredShare[] = load()

  function load(): StoredShare[] {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as { shares?: unknown }
      if (!Array.isArray(raw.shares)) return []
      return raw.shares.filter(
        (item): item is StoredShare =>
          Boolean(item) &&
          typeof item === 'object' &&
          typeof (item as StoredShare).id === 'string' &&
          typeof (item as StoredShare).path === 'string' &&
          ((item as StoredShare).kind === 'file' || (item as StoredShare).kind === 'dir'),
      )
    } catch {
      return []
    }
  }

  function persist(): void {
    mkdirSync(join(file, '..'), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify({ shares }, null, 2)}\n`, 'utf8')
    renameSync(tmp, file)
  }

  const urlOf = (id: string, state: Pick<ServiceState, 'port' | 'lan'>): string => {
    if (!state.port) return `/s/${id}`
    /*
     * 局域网开启时给出**本机在局域网里的地址**，不是 localhost。
     * 这条链接的用途就是发给同一网络里的其它设备，localhost 在对方机器上
     * 指向它自己，等于给了一条永远打不开的地址。
     */
    const host = state.lan ? (lanAddress() ?? 'localhost') : '127.0.0.1'
    return `http://${host}:${state.port}/s/${id}`
  }

  return {
    list(state) {
      return shares
        .filter(item => existsSync(item.path))
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(item => ({
          id: item.id,
          path: item.path,
          kind: item.kind,
          createdAt: item.createdAt,
          url: urlOf(item.id, state),
        }))
    },
    find: id => shares.find(item => item.id === id),
    get: id => shares.find(item => item.id === id),
    add({ path, kind }) {
      // 同一目标重复分享复用旧 id：链接不失效，列表也不会堆重复项
      const existing = shares.find(item => item.path === path)
      if (existing) return existing
      const entry: StoredShare = {
        // 16 位随机 hex：64bit 熵，链接即凭证（不可枚举）
        id: randomBytes(8).toString('hex'),
        path,
        kind,
        createdAt: Date.now(),
      }
      shares = [...shares, entry]
      persist()
      return entry
    },
    remove(id) {
      shares = shares.filter(item => item.id !== id)
      persist()
    },
  }
}
