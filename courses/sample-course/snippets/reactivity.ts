// 教学片段①：数据平面 —— reactive proxy、依赖收集 track、触发更新 trigger
// 配套片段②见 effect.ts；这里 import 的 ReactiveEffect 由 effect.ts 提供
// 「读取收集依赖、修改触发更新」是整个响应式系统的主骨架，其余都是围绕它展开的。
import type { ReactiveEffect } from './effect'

type Dep = Set<ReactiveEffect>

/** 当前正在执行的 effect 栈（由 effect.run() 压栈/出栈） */
const activeEffectStack: ReactiveEffect[] = []

/** 依赖表：target -> key -> effects 集合 */
const targetMap = new WeakMap<object, Map<string, Dep>>()

/** 读取属性时收集依赖：把当前 effect 记入该属性的依赖集合 */
export function track(target: object, key: string) {
  const active = activeEffectStack[activeEffectStack.length - 1]
  if (!active) return

  let depsMap = targetMap.get(target)
  if (!depsMap) {
    depsMap = new Map()
    targetMap.set(target, depsMap)
  }
  let dep = depsMap.get(key)
  if (!dep) {
    dep = new Set()
    depsMap.set(key, dep)
  }
  if (!dep.has(active)) {
    dep.add(active)
    active.deps.add(dep) // 反向登记，供 cleanup 使用
  }
}

/** 修改属性时触发更新：依次执行该属性的所有依赖 effect */
export function trigger(target: object, key: string) {
  const depsMap = targetMap.get(target)
  if (!depsMap) return
  const dep = depsMap.get(key)
  if (!dep) return
  for (const runner of [...dep]) {
    runner.run()
  }
}

/** reactive：用 Proxy 拦截读写，读时收集、写时触发 */
export function reactive<T extends object>(target: T): T {
  return new Proxy(target, {
    get(target, key, receiver) {
      if (typeof key === 'string') track(target, key)
      return Reflect.get(target, key, receiver)
    },
    set(target, key, value, receiver) {
      const result = Reflect.set(target, key, value, receiver)
      trigger(target, String(key))
      return result
    },
  })
}
