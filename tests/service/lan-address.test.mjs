/**
 * 局域网分享地址选择：纯函数单测。
 *
 * 为什么专门测它：选错网卡的表现是「链接生成成功、复制也成功，发给别人打不开」，
 * 只有真的拿到另一台设备上试才会发现。而候选里混进虚拟网卡（WSL / Hyper-V /
 * VMware）是常态——它们往往排在物理网卡前面。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { pickLanAddress } from '../../apps/desktop/src/service/shares.ts'

/** 造一条 IPv4 记录；family 在不同 Node 版本有字符串 / 数字两种形态，这里给字符串 */
const ipv4 = (address, internal = false) => ({
  address,
  netmask: '255.255.255.0',
  family: 'IPv4',
  mac: '00:00:00:00:00:00',
  internal,
  cidr: `${address}/24`,
})

test('WSL 虚拟网卡排在前面时，仍然选物理网卡', () => {
  // 本机真实结构的缩影：WSL 在前，WLAN 在后
  const picked = pickLanAddress({
    'vEthernet (WSL (Hyper-V firewall))': [ipv4('172.30.128.1')],
    WLAN: [ipv4('10.9.103.196')],
  })
  assert.equal(picked, '10.9.103.196')
})

test('没有物理网卡时退到非虚拟网卡', () => {
  const picked = pickLanAddress({
    'vEthernet (Default Switch)': [ipv4('172.20.0.1')],
    以太网: [ipv4('192.168.1.20')],
  })
  assert.equal(picked, '192.168.1.20')
})

test('只有虚拟网卡时也给出一个（聊胜于无，由上层提示）', () => {
  const picked = pickLanAddress({ 'vEthernet (WSL)': [ipv4('172.30.128.1')] })
  assert.equal(picked, '172.30.128.1')
})

test('跳过回环与 APIPA（169.254 拿不到 DHCP，不可路由）', () => {
  const picked = pickLanAddress({
    Loopback: [ipv4('127.0.0.1', true)],
    蓝牙网络连接: [ipv4('169.254.124.226')],
    '本地连接* 10': [ipv4('169.254.7.8')],
    WLAN: [ipv4('10.9.103.196')],
  })
  assert.equal(picked, '10.9.103.196')
})

test('物理网卡上是 IPv6 时跳过它，取有 IPv4 的那块', () => {
  const picked = pickLanAddress({
    WLAN: [ipv4('10.9.103.196')],
    'vEthernet (WSL)': [ipv4('172.30.128.1')],
  })
  assert.equal(picked, '10.9.103.196')
})

test('完全取不到时返回 null，由调用方退回 localhost', () => {
  assert.equal(pickLanAddress({}), null)
  assert.equal(pickLanAddress({ Loopback: [ipv4('127.0.0.1', true)] }), null)
})

test('虚拟网卡名大小写不敏感', () => {
  const picked = pickLanAddress({
    VETHERNET: [ipv4('172.30.128.1')],
    wlan0: [ipv4('192.168.0.9')],
  })
  assert.equal(picked, '192.168.0.9')
})
