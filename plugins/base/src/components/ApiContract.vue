<script setup lang="ts">
/**
 * ApiContract —— 模块输入 / 输出契约与不变量。
 *
 * 把「AudioContext / 调度器 / 渲染状态」这类真实模块的边界契约沉淀为教学卡：
 * 模块的输入信号、输出信号、以及调用方必须遵守 / 模块保证的不变量。
 * 比裸代码签名更能说清「谁在什么时候喂给我什么、我吐给谁什么、两边都得保证什么」。
 *
 * 用法（Markdown）：在页面顶部的 script setup 块里定义 inputs / outputs / invariants，
 * 正文写：
 *
 * <ApiContract title="渲染器模块契约" :inputs="inputs" :outputs="outputs" :invariants="invariants" />
 *
 * 数据协议见 types.ts：
 *   inputs/outputs:  ApiPort[] = { name, type, description }
 *   invariants:      (string | InvariantRule)[]；InvariantRule = { statement, kind?: 'must' | 'must-not' }
 */
import type { ApiPort, InvariantRule } from './types'

defineProps<{
  /** 卡片标题（缺省「模块契约」） */
  title?: string
  /** 输入信号列表：模块被调用方喂什么 */
  inputs: ApiPort[]
  /** 输出信号列表：模块吐给调用方 / 下游什么 */
  outputs: ApiPort[]
  /** 不变量：字符串或 { statement, kind }；kind 缺省 must（正向保证） */
  invariants: Array<string | InvariantRule>
}>()
</script>

<template>
  <section class="at-api">
    <header class="at-api__head">
      <svg
        viewBox="0 0 24 24"
        width="15"
        height="15"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M14 7l-5.5 5.5a2 2 0 0 0 0 2.8l.2.2a2 2 0 0 0 2.8 0L17 10" />
        <path d="M10 17l1.5 1.5a2 2 0 0 0 2.8 0l.2-.2a2 2 0 0 0 0-2.8L14 14" />
        <path d="M4 20l4-4" />
      </svg>
      {{ title || '模块契约' }}
    </header>

    <div class="at-api__ports">
      <div class="at-api__col">
        <p class="at-api__sub">
          <svg
            viewBox="0 0 24 24"
            width="12"
            height="12"
            fill="none"
            stroke="currentColor"
            stroke-width="2.2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M12 19V5" />
            <path d="M5 12l7-7 7 7" />
          </svg>
          输入
        </p>
        <ul class="at-api__list">
          <li v-for="(p, i) in inputs" :key="i" class="at-api__port">
            <span class="at-api__port-name">{{ p.name }}</span>
            <span class="at-api__port-type">{{ p.type }}</span>
            <span class="at-api__port-desc">{{ p.description }}</span>
          </li>
        </ul>
      </div>

      <div class="at-api__col">
        <p class="at-api__sub">
          <svg
            viewBox="0 0 24 24"
            width="12"
            height="12"
            fill="none"
            stroke="currentColor"
            stroke-width="2.2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M12 5v14" />
            <path d="M19 12l-7 7-7-7" />
          </svg>
          输出
        </p>
        <ul class="at-api__list">
          <li v-for="(p, i) in outputs" :key="i" class="at-api__port">
            <span class="at-api__port-name">{{ p.name }}</span>
            <span class="at-api__port-type">{{ p.type }}</span>
            <span class="at-api__port-desc">{{ p.description }}</span>
          </li>
        </ul>
      </div>
    </div>

    <footer v-if="invariants.length" class="at-api__inv">
      <p class="at-api__sub">不变量</p>
      <ul class="at-api__list at-api__inv-list">
        <li
          v-for="(raw, i) in invariants"
          :key="i"
          class="at-api__inv-item"
          :class="`is-${typeof raw === 'string' ? 'must' : (raw.kind ?? 'must')}`"
        >
          <span class="at-api__inv-mark" aria-hidden="true">
            <svg
              viewBox="0 0 24 24"
              width="13"
              height="13"
              fill="none"
              stroke="currentColor"
              stroke-width="2.6"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M20 6 9 17l-5-5" />
            </svg>
          </span>
          <span class="at-api__inv-text">{{ typeof raw === 'string' ? raw : raw.statement }}</span>
        </li>
      </ul>
    </footer>
  </section>
</template>

<style scoped>
.at-api {
  margin: 1rem 0;
  border: 1px solid var(--at-border);
  border-radius: var(--at-radius-lg);
  background: var(--at-surface);
}

.at-api__head {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.6rem 0.9rem;
  border-bottom: 1px solid var(--at-border);
  color: var(--at-text-muted);
  font-size: 0.8rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  text-transform: uppercase;
}

.at-api__ports {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 0;
}

.at-api__col {
  padding: 0.55rem 0.95rem 0.7rem;
}

.at-api__col + .at-api__col {
  border-left: 1px solid var(--at-border);
}

.at-api__sub {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  margin: 0 0 0.4rem !important;
  color: var(--at-text-muted);
  font-size: 0.76rem;
  font-weight: 600;
  letter-spacing: 0.04em;
}

.at-api__list {
  margin: 0 !important;
  padding: 0;
  list-style: none;
}

.at-api__port {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.35rem 0.5rem;
  margin: 0 !important;
  padding: 0.42rem 0;
  border-top: 1px dashed var(--at-border);
  font-size: 0.86rem;
}

.at-api__col > .at-api__list > .at-api__port:first-child {
  border-top: 0;
}

.at-api__port-name {
  font-family: var(--at-font-mono);
  font-weight: 600;
  color: var(--at-text);
}

.at-api__port-type {
  padding: 0.05rem 0.4rem;
  border-radius: var(--at-radius-sm);
  background: var(--at-surface-2);
  font-family: var(--at-font-mono);
  font-size: 0.72rem;
  color: var(--at-accent-strong);
}

.at-api__port-desc {
  flex-basis: 100%;
  color: var(--at-text-2);
  font-size: 0.82rem;
  line-height: 1.5;
}

.at-api__inv {
  padding: 0.55rem 0.95rem 0.7rem;
  border-top: 1px solid var(--at-border);
  background: color-mix(in srgb, var(--at-accent) 4%, transparent);
}

.at-api__inv-list {
  display: grid;
  gap: 0.28rem;
}

.at-api__inv-item {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  margin: 0 !important;
  font-size: 0.85rem;
}

.at-api__inv-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 1.2rem;
  height: 1.2rem;
  margin-top: 0.06rem;
  border-radius: 50%;
  background: color-mix(in srgb, var(--at-ok) 14%, transparent);
  color: var(--at-ok);
}

.at-api__inv-item.is-must-not .at-api__inv-mark {
  background: color-mix(in srgb, var(--at-danger) 12%, transparent);
  color: var(--at-danger);
}

.at-api__inv-text {
  color: var(--at-text-2);
  line-height: 1.5;
}

.at-api__inv-item.is-must-not .at-api__inv-text {
  color: var(--at-text);
}
</style>
