<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { X } from 'lucide-vue-next'
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
 * 组件示例预览：把插件包里的 `examples/<kind>.md` 渲染成一个只看这一块的卡片。
 *
 * 数据来源是示例文件本身（manifest 的 `components[].example` 指向它），
 * 因此「预览所见」与「AI 照着 SKILL.md 写出来的」完全同源——不存在
 * 另写一份演示数据然后两边漂移的可能。
 *
 * 渲染走与阅读视图同一套管线（renderMarkdown + 声明式挂载 + 异步高亮/图表），
 * 唯一的差别是渲染完只保留组件节点本身，去掉示例文件里的标题与正文说明。
 */
const props = defineProps<{
  /** 插件包名（docvi://plugin 协议的第一段） */
  plugin: string
  /** 组件 kind（用于提示文案） */
  kind: string
  /** 示例文件在包内的相对路径 */
  example: string
}>()

const emit = defineEmits<{ close: [] }>()

const { t } = useI18n()
const plugins = usePluginStore()
const surface = ref<HTMLElement | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)
let mount: DeclarativeMount | null = null
/** 渲染代际：快速切换示例时，旧请求的高亮任务不能覆盖新内容 */
let generation = 0

function disposeMount(): void {
  mount?.dispose()
  mount = null
}

async function load(): Promise<void> {
  const current = (generation += 1)
  loading.value = true
  error.value = null
  disposeMount()

  let text: string
  try {
    // 资源位置由宿主决定：桌面是 docvi:// 自定义协议，容器是 /plugins/<name>/<version>/…
    const url =
      window.docvi.pluginAssetUrl?.(props.plugin, props.example) ??
      `docvi://plugin/${encodeURIComponent(props.plugin)}/${props.example}`
    const response = await fetch(url)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    text = await response.text()
  } catch (cause) {
    if (current === generation) {
      error.value = t('plugins.preview.loadFailed', { reason: (cause as Error).message })
      loading.value = false
    }
    return
  }
  if (current !== generation) return

  await nextTick()
  const host = surface.value
  if (!host) return

  const rendered = renderMarkdown(text, props.example, {
    // 结构化块（::: merged 等）的示例本身就是这种写法：不声明语法就只剩一段 YAML
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
  const blocks = mountPluginBlocks(host, registry, { onMissing: () => undefined })

  try {
    await highlightPass(host)
    // 预览跟随文档主题的明暗：深色文档配深色图表，否则图里白底会刺眼
    await mermaidPass(host)
  } catch {
    // 高亮 / 图表失败不阻断预览：至少组件本体能看
  }
  if (current !== generation) {
    mount.dispose()
    blocks.dispose()
    return
  }
  loading.value = false
}

watch(
  () => [props.plugin, props.example],
  () => void load(),
  { immediate: true },
)

onBeforeUnmount(() => {
  generation += 1
  disposeMount()
})
</script>

<template>
  <div class="preview">
    <div class="preview__head">
      <span class="preview__title">{{ t('plugins.preview.title') }}</span>
      <code class="preview__kind">{{ kind }}</code>
      <button
        v-tooltip="t('plugins.preview.close')"
        class="preview__close"
        type="button"
        :aria-label="t('plugins.preview.close')"
        @click="emit('close')"
      >
        <X :size="14" :stroke-width="1.8" />
      </button>
    </div>
    <!--
      `doc-surface at-doc` 不是装饰：组件角色 token（--dv-c-* / --at-*）与正文主题
      变量都只在这两个类上定义。少了它，组件的 `fill: var(--at-bg)` 全部解析失败，
      SVG 退回黑色填充——预览里那一片纯黑块就是这么来的。
    -->
    <div ref="surface" class="preview__surface doc-surface at-doc" />
    <p v-if="loading" class="preview__hint">{{ t('plugins.preview.loading') }}</p>
    <p v-else-if="error" class="preview__error">{{ error }}</p>
  </div>
</template>

<style scoped>
.preview {
  margin-top: 12px;
  border: 1px solid var(--dv-ui-line);
  border-radius: var(--dv-ui-radius-md);
  background: var(--dv-ui-surface-2);
  overflow: hidden;
}

.preview__head {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 32px;
  padding: 0 8px 0 12px;
  border-bottom: 1px solid var(--dv-ui-line-soft);
}

.preview__title {
  font-size: 11.5px;
  font-weight: 560;
  color: var(--dv-ui-text-2);
}

.preview__kind {
  flex: 1;
  font-family: var(--dv-font-mono, ui-monospace, monospace);
  font-size: 10.5px;
  color: var(--dv-ui-text-dim);
}

.preview__close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: var(--dv-ui-radius-sm);
  background: transparent;
  color: var(--dv-ui-text-muted);
  cursor: pointer;
}

.preview__close:hover {
  background: var(--dv-ui-surface-3);
  color: var(--dv-ui-text);
}

/* 预览区按阅读列宽度渲染：与真实文档里的组件宽度一致 */
.preview__surface {
  padding: 16px;
  max-height: 480px;
  overflow: auto;
}

.preview__hint,
.preview__error {
  margin: 0;
  padding: 10px 12px;
  font-size: 12px;
  color: var(--dv-ui-text-muted);
}

.preview__error {
  color: var(--dv-ui-danger);
}
</style>
