<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ArrowLeft } from 'lucide-vue-next'
import {
  highlightPass,
  mermaidPass,
  mountDeclarativeComponents,
  mountPluginBlocks,
  renderMarkdown,
  type DeclarativeMount,
} from '@docvi/renderer-core'

import { createHostRegistry } from '../lib/component-registry'
import { usePluginStore } from '../stores/plugins'
import { useI18n } from '../lib/i18n'

/**
 * 组件示例预览页（容器端整页路由 `/_/preview/<插件包>/<组件 kind>`）。
 *
 * 运维页的「预览」按钮打开的就是这里。它与插件面板里的就地预览
 * （`ComponentPreview.vue`）共用同一套渲染管线，差别只有两点：
 *  - 数据源：容器端从**部署器的公开端点** `/api/plugins/<name>/example/<kind>` 取
 *    示例原文，而不是 `docvi://` 协议（容器里没有那套协议）；
 *  - 版式：整页独占，带返回入口，适合在新标签里对照着读。
 *
 * 为什么必须做成独立页：容器端没有「插件面板」，运维只能从运维页列出已装
 * 插件及其示例。链接落到壳里却没有路由，用户看到的就是「开了个 docvi 页面，
 * 但什么都没渲染」——这正是本轮要修的。
 */
const props = defineProps<{
  plugin: string
  kind: string
}>()

const { t } = useI18n()
const plugins = usePluginStore()
const surface = ref<HTMLElement | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)
let mount: DeclarativeMount | null = null
let blocks: { dispose: () => void } | null = null
/** 渲染代际：快速切换时旧请求的高亮任务不能覆盖新内容 */
let generation = 0

function dispose(): void {
  mount?.dispose()
  mount = null
  blocks?.dispose()
  blocks = null
}

async function load(): Promise<void> {
  const current = (generation += 1)
  loading.value = true
  error.value = null
  dispose()

  let text: string
  try {
    const res = await fetch(
      `/api/plugins/${encodeURIComponent(props.plugin)}/example/${encodeURIComponent(props.kind)}`,
    )
    if (!res.ok) throw new Error(res.status === 404 ? '该组件没有提供示例' : `HTTP ${res.status}`)
    text = await res.text()
  } catch (cause) {
    if (current === generation) {
      error.value = (cause as Error).message
      loading.value = false
    }
    return
  }
  if (current !== generation) return

  await nextTick()
  const host = surface.value
  if (!host) return

  const rendered = renderMarkdown(text, `${props.kind}.md`, {
    containerSyntax: plugins.syntax.map(item => ({
      name: item.name,
      component: item.component,
      form: item.form,
    })),
  })
  host.innerHTML = rendered.html
  const registry = createHostRegistry()
  mount = mountDeclarativeComponents(
    host,
    (rendered.frontmatter.components as Record<string, Record<string, unknown>> | undefined) ??
      null,
    registry,
    { onMissing: info => `未注册组件：${info.kind}` },
  )
  blocks = mountPluginBlocks(host, registry, { onMissing: () => undefined })

  try {
    await highlightPass(host)
    await mermaidPass(host)
  } catch {
    // 高亮 / 图表失败不阻断预览：至少组件本体能看
  }
  if (current !== generation) {
    dispose()
    return
  }
  loading.value = false
}

function back(): void {
  // 运维页是部署器自渲染的页面，不是壳内路由：直接回运维页的插件面板
  location.assign('/_/admin#plugins')
}

watch(
  () => [props.plugin, props.kind],
  () => {
    void plugins.load()
    void load()
  },
  { immediate: true },
)

onMounted(() => {
  document.title = `${props.kind} · 组件预览`
})

onBeforeUnmount(() => {
  generation += 1
  dispose()
})
</script>

<template>
  <div class="preview-page">
    <div class="preview-page__bar">
      <button class="preview-page__back" type="button" @click="back()">
        <ArrowLeft :size="14" :stroke-width="1.8" />
        <span>{{ t('plugins.preview.backToOps') }}</span>
      </button>
      <span class="preview-page__id">{{ plugin }} / {{ kind }}</span>
    </div>

    <div class="preview-page__scroll">
      <!--
        `doc-surface at-doc` 必须带：组件角色 token（--dv-c-* / --at-*）只在这两个
        类上定义，少了它 SVG 的 `fill: var(--at-bg)` 全部解析失败、退回黑色。
      -->
      <article ref="surface" class="preview-page__body doc-surface at-doc" />
      <p v-if="loading" class="preview-page__hint">{{ t('plugins.preview.loading') }}</p>
      <p v-else-if="error" class="preview-page__error">
        {{ t('plugins.preview.loadFailed', { reason: error }) }}
      </p>
    </div>
  </div>
</template>

<style scoped>
.preview-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--dv-ui-bg);
}

.preview-page__bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  height: 40px;
  padding: 0 16px;
  border-bottom: 1px solid var(--dv-ui-line-soft);
}

.preview-page__back {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 10px 0 8px;
  border: 1px solid var(--dv-ui-line-soft);
  border-radius: var(--dv-ui-radius-sm);
  background: transparent;
  color: var(--dv-ui-text-2);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.preview-page__back:hover {
  border-color: var(--dv-ui-line);
  background: var(--dv-ui-surface-2);
  color: var(--dv-ui-text);
}

.preview-page__id {
  font-family: var(--dv-font-mono, ui-monospace, monospace);
  font-size: 11px;
  color: var(--dv-ui-text-dim);
}

.preview-page__scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.preview-page__body {
  max-width: 960px;
  margin: 0 auto;
  padding: 28px 24px 80px;
}

.preview-page__hint,
.preview-page__error {
  max-width: 960px;
  margin: 0 auto;
  padding: 0 24px 24px;
  font-size: 12px;
  color: var(--dv-ui-text-muted);
}

.preview-page__error {
  color: var(--dv-ui-danger);
}
</style>
