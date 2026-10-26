/**
 * 容器构建清单与工作区一致性守卫。
 *
 * Dockerfile 在装依赖前要先把**每个工作区子包的 package.json** 拷进去（只拷根清单
 * 时 pnpm 只装根依赖，构建 web 产物会因找不到 @codemirror/* 而失败）。因为
 * `COPY --parents` 需要 Dockerfile 1.7 语法、旧构建前端会直接报 unknown flag，
 * 这里只能逐行列举——于是「新增包忘了加一行」就成了一个只在 CI 才暴露的坑。
 *
 * 本测试把那份列举与磁盘上的实际包集合对齐：多一行、少一行都失败。
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8')

/** 磁盘上真实存在的、需要 package.json 的工作区包（相对路径，正斜杠） */
function workspaceManifests() {
  const out = []
  for (const workspace of ['apps', 'packages', 'plugins']) {
    const base = join(root, workspace)
    if (!existsSync(base)) continue
    for (const name of readdirSync(base, { withFileTypes: true })) {
      if (!name.isDirectory()) continue
      const rel = `${workspace}/${name.name}/package.json`
      if (existsSync(join(root, rel))) out.push(rel)
    }
  }
  return out.sort()
}

/** Dockerfile 里显式 COPY 的子包清单 */
function dockerCopiedManifests() {
  const out = []
  for (const line of dockerfile.split('\n')) {
    const m = /^COPY\s+(\S+package\.json)\s+\.\/\S+\/?\s*$/.exec(line.trim())
    if (m && m[1] !== 'package.json') out.push(m[1])
  }
  return out.sort()
}

test('Dockerfile 逐行列举的子包清单与工作区实际包一致', () => {
  const disk = workspaceManifests()
  const copied = dockerCopiedManifests()
  assert.deepEqual(
    copied,
    disk,
    `Dockerfile 的 COPY 子包清单与实际工作区不一致。\n` +
      `缺（构建会因缺依赖失败）：${disk.filter(x => !copied.includes(x)).join(', ') || '无'}\n` +
      `多（指向已删除的包）：${copied.filter(x => !disk.includes(x)).join(', ') || '无'}`,
  )
})

test('Dockerfile 不再使用 --parents（旧构建前端不支持）', () => {
  assert.ok(
    !/^\s*COPY\s+--parents/m.test(dockerfile),
    'COPY --parents 需要 Dockerfile 1.7 语法，旧构建前端会报 unknown flag',
  )
})

test('Dockerfile 拷了 workspace 声明与锁文件', () => {
  assert.match(dockerfile, /^COPY package\.json pnpm-lock\.yaml pnpm-workspace\.yaml \.\/$/m)
})

test('容器构建跳过了 Electron 二进制下载', () => {
  assert.match(dockerfile, /ELECTRON_SKIP_BINARY_DOWNLOAD=1/, '容器不需要 Electron 运行时')
})
