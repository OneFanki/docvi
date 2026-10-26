<script setup lang="ts">
/**
 * ZoomBar —— 画布类组件头部的缩放控制条（内部组件，不注册为文档 kind）。
 *
 * 与 useZoomPan 配套：− / 百分比 / + / 适应。滚轮与拖拽是主路径，
 * 这排按钮负责三件事——精确回到 100%、一键适应视口、给不习惯手势的人兜底。
 */
withDefaults(
  defineProps<{
    /** 当前缩放百分比 */
    percent: number
    /** 是否显示「适应」按钮 */
    canFit?: boolean
  }>(),
  { canFit: true },
)

const emit = defineEmits<{
  (event: 'zoom-in'): void
  (event: 'zoom-out'): void
  (event: 'fit'): void
}>()
</script>

<template>
  <span class="at-zoom" role="group" aria-label="缩放控制">
    <button type="button" class="at-zoom__btn" aria-label="缩小" @click="emit('zoom-out')">
      <svg
        viewBox="0 0 24 24"
        width="12"
        height="12"
        fill="none"
        stroke="currentColor"
        stroke-width="2.4"
        stroke-linecap="round"
        aria-hidden="true"
      >
        <path d="M5 12h14" />
      </svg>
    </button>
    <span class="at-zoom__value" aria-live="polite">{{ percent }}%</span>
    <button type="button" class="at-zoom__btn" aria-label="放大" @click="emit('zoom-in')">
      <svg
        viewBox="0 0 24 24"
        width="12"
        height="12"
        fill="none"
        stroke="currentColor"
        stroke-width="2.4"
        stroke-linecap="round"
        aria-hidden="true"
      >
        <path d="M12 5v14" />
        <path d="M5 12h14" />
      </svg>
    </button>
    <button
      v-if="canFit"
      type="button"
      class="at-zoom__btn at-zoom__btn--text"
      aria-label="缩放到适应视口"
      @click="emit('fit')"
    >
      适应
    </button>
  </span>
</template>

<style scoped>
.at-zoom {
  display: inline-flex;
  align-items: center;
  gap: 0.1rem;
  padding: 0.05rem;
  border: 1px solid var(--at-border);
  border-radius: var(--at-radius-sm);
  background: var(--at-bg);
}

.at-zoom__btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 1.35rem;
  height: 1.35rem;
  padding: 0 0.2rem;
  border: 0;
  border-radius: 4px;
  background: none;
  color: var(--at-text-2);
  font-size: 0.72rem;
  line-height: 1;
  cursor: pointer;
  transition:
    background-color 0.12s ease,
    color 0.12s ease;
}

.at-zoom__btn:hover {
  background: var(--at-surface-2);
  color: var(--at-accent);
}

.at-zoom__btn--text {
  padding: 0 0.4rem;
}

.at-zoom__value {
  min-width: 2.6rem;
  color: var(--at-text-muted);
  font-family: var(--at-font-mono);
  font-size: 0.7rem;
  font-variant-numeric: tabular-nums;
  text-align: center;
}
</style>
