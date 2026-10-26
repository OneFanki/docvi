<script setup lang="ts">
import { Check } from 'lucide-vue-next'

import { useThemeStore } from '../stores/app'
import { useI18n } from '../lib/i18n'
import { useThemeOptions } from '../lib/theme-options'

/**
 * 主题选择：一个列表，选中即整套生效。
 *
 * 为什么不再分「界面 / 文档 / 编辑器」三行：那三者本来就是同一套配色的三个面，
 * 拆开只会让用户面对 3×3×3 种组合，还要逐个试出「哪一套彼此配得上」。
 * 一个主题插件可以带多套主题——「多套」的粒度在主题本身，不在维度。
 */
const theme = useThemeStore()
const { t } = useI18n()
const options = useThemeOptions()

function pick(id: string): void {
  theme.setTheme(id)
}
</script>

<template>
  <div class="theme-picker">
    <p class="theme-picker__lead">{{ t('theme.lead') }}</p>
    <div class="theme-picker__grid" role="radiogroup" :aria-label="t('settings.theme')">
      <button
        v-for="option in options"
        :key="option.id"
        v-tooltip="
          option.plugin ? t('theme.fromPlugin', { name: option.plugin }) : t('theme.builtin')
        "
        class="theme-card"
        :class="{ 'is-on': option.id === theme.theme }"
        type="button"
        role="radio"
        :aria-checked="option.id === theme.theme"
        @click="pick(option.id)"
      >
        <span class="theme-card__swatch" :data-appearance="option.appearance" aria-hidden="true">
          <span class="theme-card__swatch-bar" />
          <span class="theme-card__swatch-bar" />
          <span class="theme-card__swatch-bar short" />
        </span>
        <span class="theme-card__label">{{ option.title }}</span>
        <Check
          v-if="option.id === theme.theme"
          :size="13"
          :stroke-width="2.4"
          class="theme-card__check"
        />
      </button>
    </div>
  </div>
</template>

<style scoped>
.theme-picker__lead {
  margin: 0 0 12px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--dv-ui-text-muted);
}

.theme-picker__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(168px, 1fr));
  gap: 10px;
}

.theme-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding: 10px;
  border: 1px solid var(--dv-ui-line-soft);
  border-radius: var(--dv-ui-radius-md);
  background: var(--dv-ui-surface-1);
  text-align: left;
  cursor: pointer;
  transition:
    border-color var(--dv-ui-dur-1) var(--dv-ui-ease),
    background var(--dv-ui-dur-1) var(--dv-ui-ease);
}

.theme-card:hover {
  border-color: var(--dv-ui-line);
  background: var(--dv-ui-surface-2);
}

.theme-card.is-on {
  border-color: var(--dv-ui-accent);
}

/* 色板：用三根"文本行"示意配色，比纯色块更能看出这是文档应用 */
.theme-card__swatch {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 4px;
  height: 46px;
  padding: 0 10px;
  border-radius: var(--dv-ui-radius-sm);
  border: 1px solid var(--dv-ui-line-soft);
}

.theme-card__swatch[data-appearance='dark'] {
  background: #14161a;
}

.theme-card__swatch[data-appearance='light'] {
  background: #f7f4ee;
}

.theme-card__swatch-bar {
  height: 3px;
  border-radius: 2px;
  background: var(--dv-ui-text-dim);
  opacity: 0.75;
}

.theme-card__swatch[data-appearance='dark'] .theme-card__swatch-bar {
  background: #c9c6bf;
}

.theme-card__swatch[data-appearance='light'] .theme-card__swatch-bar {
  background: #38332b;
}

.theme-card__swatch-bar.short {
  width: 52%;
}

.theme-card__label {
  font-size: 12.5px;
  font-weight: 560;
  color: var(--dv-ui-text);
}

.theme-card__check {
  position: absolute;
  top: 8px;
  right: 8px;
  color: var(--dv-ui-accent);
}
</style>
