/**
 * docs-core 的 node fs IO 适配器（唯一含 node:* 的注入实现）。
 * 消费方：deployer 索引刷新 / vite dev 中间件 / check-links 等 node 侧调用。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'

/** 创建 node fs 同步 IO（docs-core 的 IO 契约实现） */
export function createNodeIO() {
  return {
    exists(path) {
      return existsSync(path)
    },
    readdir(dir) {
      return readdirSync(dir, { withFileTypes: true })
    },
    readText(path) {
      return readFileSync(path, 'utf8')
    },
    statKind(path) {
      try {
        return statSync(path).isDirectory() ? 'dir' : 'file'
      } catch {
        return null
      }
    },
  }
}

/** 进程级单例（IO 无状态，重复创建无意义） */
export const nodeIO = createNodeIO()
