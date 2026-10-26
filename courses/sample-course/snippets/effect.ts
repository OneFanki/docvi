// 教学片段②：effect 平面 —— 副作用执行与「清理后重收集」的生命周期
// activeEffectStack / Dep 来自 reactivity.ts（与片段①同属一个迷你响应式模块）
import { activeEffectStack } from './reactivity'
import type { Dep } from './reactivity'

export class ReactiveEffect {
  /** 反向记录自己依赖了哪些 dep，清理时逐一解绑 */
  deps: Set<Dep> = new Set()

  constructor(public fn: () => void) {}

  /** 执行副作用：先清旧依赖，再压栈运行，确保 track 能取到当前 effect */
  run() {
    cleanupEffect(this)
    activeEffectStack.push(this)
    try {
      return this.fn()
    } finally {
      activeEffectStack.pop()
    }
  }
}

/** 建立副作用并立即运行一次（顺带完成首次依赖收集） */
export function effect(fn: () => void) {
  const _effect = new ReactiveEffect(fn)
  _effect.run()
  return _effect
}

/** 解绑 effect 与所有 dep，避免「不再依赖的属性仍触发更新」 */
function cleanupEffect(target: ReactiveEffect) {
  for (const dep of target.deps) {
    dep.delete(target)
  }
  target.deps.clear()
}
