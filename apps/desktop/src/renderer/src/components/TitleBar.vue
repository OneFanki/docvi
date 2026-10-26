<script setup lang="ts">
import { Blocks, PanelLeft, PanelRight, Search, Server, Settings } from 'lucide-vue-next'

import { useI18n } from '../lib/i18n'
import { isWebHost } from '../lib/host'

/**
 * 标题栏：44px，整条是系统拖拽区。
 *
 * 交互元素必须挂 `no-drag`——否则在拖拽区上的点击会被窗口管理器吃掉，
 * 表现为「按钮按不动」（旧壳踩过同类问题）。
 *
 * **这里不放工作区标识**：标题栏在标签之上，任何放在这里的东西都会被读成
 * 「全局状态」，而工作区是标签内的上下文。工作区名显示在标签内的目录树顶部。
 *
 * **这里也不放主题切换**：主题是「选一套」，不是「翻到反面」。两套主题时
 * 一个翻转按钮勉强成立，插件主题进来后它只能在内置两套之间来回，等于对
 * 用户说谎。主题选择统一收在状态栏右下角的下拉里（见 StatusBar / ThemeMenu），
 * 那里能列出全部主题。
 *
 * 搜索是**长得像输入框的按钮**：真正的搜索发生在 Ctrl+K 浮层里，这个框只是
 * 把「有个全局搜索」这件事放到第一眼能看到的位置，点击即开浮层。它不可输入，
 * 因此也不需要处理输入法、焦点与 Esc 语义。
 */
defineProps<{
  /** 当前标签是否显示目录树（决定左侧按钮是否可用） */
  treeAvailable: boolean
  treeVisible: boolean
  outlineAvailable: boolean
  outlineVisible: boolean
}>()

const emit = defineEmits<{
  openPalette: []
  toggleTree: []
  toggleOutline: []
  openSettings: []
  /** 桌面端的插件中心（容器读者面没有安装能力，入口由父组件按宿主编排） */
  openPlugins: []
}>()

const { t } = useI18n()
</script>

<template>
  <header class="titlebar" :class="{ 'is-web': isWebHost }">
    <div class="titlebar__brand no-drag">
      <!--
        与应用图标同一套几何与配色（scripts/lib/logo.mjs 的 LOGO_MARK）：三张错位的
        琥珀色文档页 + 一条把右下角切掉的深色斜带。

        **这里不带底板**：深色方块贴在浅色主题的标题栏上就是一块黑补丁。去掉底板后
        黄色在深浅主题下都成立，与应用图标仍一眼是同一个标志。

        这段 SVG 的坐标必须与 logo.mjs 的 PAGE / STACK / BAND 一致——那边改了几何，
        这里要同步（脚本只生成 PNG/SVG，组件里这份是手写的）。
        `scripts/logo-consistency.test.mjs` 会断言两处没有漂。
      -->
      <svg
        class="titlebar__logo"
        viewBox="0 0 32 32"
        width="16"
        height="16"
        aria-hidden="true"
        focusable="false"
      >
        <rect
          x="10.4"
          y="8.2"
          width="15.4"
          height="18.6"
          rx="2.6"
          class="logo__page"
          opacity="0.34"
        />
        <rect
          x="8.6"
          y="6.8"
          width="15.4"
          height="18.6"
          rx="2.6"
          class="logo__page"
          opacity="0.62"
        />
        <g clip-path="url(#dv-tb-clip)">
          <rect x="6.8" y="5.4" width="15.4" height="18.6" rx="2.6" class="logo__page" />
          <g transform="rotate(-34 14.5 14.7)">
            <rect x="5.1" y="18.2" width="17.6" height="4.4" rx="2.2" class="logo__band" />
          </g>
        </g>
        <clipPath id="dv-tb-clip">
          <rect x="6.8" y="5.4" width="15.4" height="18.6" rx="2.6" />
        </clipPath>
      </svg>
      <span class="titlebar__name">{{ t('app.name') }}</span>
    </div>

    <div class="titlebar__spacer" />

    <button
      v-tooltip="{ text: `${t('titlebar.searchPlaceholder')}（Ctrl+K）`, placement: 'bottom' }"
      class="titlebar__search no-drag"
      type="button"
      :aria-label="t('titlebar.searchPlaceholder')"
      @click="emit('openPalette')"
    >
      <Search :size="13" :stroke-width="1.8" class="titlebar__search-icon" aria-hidden="true" />
      <span class="titlebar__search-text">{{ t('titlebar.searchPlaceholder') }}</span>
      <kbd class="titlebar__search-key">Ctrl K</kbd>
    </button>

    <div class="titlebar__group no-drag">
      <button
        v-tooltip="{ text: `${t('titlebar.toggleTree')}（Ctrl+B）`, placement: 'bottom' }"
        class="titlebar__icon"
        type="button"
        :disabled="!treeAvailable"
        :aria-pressed="treeVisible"
        :aria-label="t('titlebar.toggleTree')"
        :class="{ 'is-on': treeAvailable && treeVisible }"
        @click="emit('toggleTree')"
      >
        <PanelLeft :size="15" :stroke-width="1.7" />
      </button>

      <button
        v-tooltip="{ text: `${t('titlebar.toggleOutline')}（Ctrl+Alt+B）`, placement: 'bottom' }"
        class="titlebar__icon"
        type="button"
        :disabled="!outlineAvailable"
        :aria-pressed="outlineVisible"
        :aria-label="t('titlebar.toggleOutline')"
        :class="{ 'is-on': outlineAvailable && outlineVisible }"
        @click="emit('toggleOutline')"
      >
        <PanelRight :size="15" :stroke-width="1.7" />
      </button>

      <!--
        设置入口：删掉左侧图标栏后，设置只剩命令面板一个入口，等于没有。
        页面型标签（设置/插件）本身可以关掉，所以入口必须常驻。
      -->
      <button
        v-tooltip="{ text: t('titlebar.settings'), placement: 'bottom' }"
        class="titlebar__icon"
        type="button"
        :aria-label="t('titlebar.settings')"
        @click="emit('openSettings')"
      >
        <Settings :size="15" :stroke-width="1.7" />
      </button>

      <!--
        插件中心：桌面端有插件安装与启停，容器读者面没有（安装是运维的活）。
        常驻在标题栏而不是塞进设置——插件会新增组件与主题，是「扩展能力」的
        一级入口，藏进设置等于没人知道它能扩展。
      -->
      <button
        v-if="!isWebHost"
        v-tooltip="{ text: t('app.plugins'), placement: 'bottom' }"
        class="titlebar__icon"
        type="button"
        :aria-label="t('app.plugins')"
        @click="emit('openPlugins')"
      >
        <Blocks :size="15" :stroke-width="1.7" />
      </button>

      <!--
        平台运维：只有容器读者面有（运维页由部署器伺服）。放在标题栏右侧，
        与其余图标同一条视觉行——此前它被绝对定位浮在标签栏上，位置是错的。
      -->
      <a
        v-if="isWebHost"
        v-tooltip="{ text: t('portal.opsHint'), placement: 'bottom' }"
        class="titlebar__icon"
        :aria-label="t('portal.ops')"
        href="/_/admin"
        target="_blank"
        rel="noreferrer"
      >
        <Server :size="15" :stroke-width="1.7" />
      </a>
    </div>
  </header>
</template>

<style scoped>
.titlebar {
  position: relative;
  height: var(--dv-ui-titlebar-h);
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 12px;
  background: var(--dv-ui-bg);
  border-bottom: 1px solid var(--dv-ui-line-soft);
  -webkit-app-region: drag;
  /* 为 Windows 原生窗口按钮留出空间（titleBarOverlay 宽度）。
     容器版没有原生窗口按钮，见模板上的 is-web 覆盖。 */
  padding-right: 148px;
}

/* 容器读者面：没有原生窗口按钮，右侧图标直接贴边。
   留 148px 会把设置/运维图标白白推离右边缘（用户实测「应该靠最右侧」）。 */
.titlebar.is-web {
  padding-right: 12px;
}

.no-drag {
  -webkit-app-region: no-drag;
}

.titlebar__brand {
  display: flex;
  align-items: center;
  gap: 7px;
  user-select: none;
}

.titlebar__logo {
  flex: none;
  display: block;
}

/*
 * 标记配色与应用图标一致，但**不跟随主题变量**。
 *
 * 图标是一个品牌物，深浅主题下都应该是同一组颜色——如果纸张改用
 * `--dv-ui-text`，浅色主题里它变成黑纸，品牌就没了。三个色值直接对齐
 * logo.mjs 的 LOGO_COLORS（琥珀纸 / 深斜带）。
 */
.logo__page {
  fill: #eeb254;
}

.logo__band {
  fill: #1b1d22;
}

.titlebar__name {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.2px;
  color: var(--dv-ui-text);
}

/*
 * 伪输入框：和真输入框视觉一致，但不接收输入。
 *
 * 绝对居中于**窗口**（`left: 50%` 相对标题栏的 padding box，含右侧 overlay 占位），
 * 所以左右留白不对称也不会让它偏。宽度随窗口收缩，避免在窄窗口压到右侧按钮
 * （窗口最小 880px：30vw=264px，右缘距窗口按钮仍有 160px 余量）。
 */
.titlebar__search {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: clamp(160px, 30vw, 320px);
  height: 26px;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 0 8px;
  border: 1px solid var(--dv-ui-line-soft);
  border-radius: var(--dv-ui-radius-sm);
  background: var(--dv-ui-surface-1);
  color: var(--dv-ui-text-dim);
  font-size: 12px;
  cursor: pointer;
  transition:
    background var(--dv-ui-dur-1) var(--dv-ui-ease),
    border-color var(--dv-ui-dur-1) var(--dv-ui-ease);
}

.titlebar__search:hover {
  border-color: var(--dv-ui-line);
  background: var(--dv-ui-surface-2);
  color: var(--dv-ui-text-muted);
}

.titlebar__search-icon {
  flex: none;
}

.titlebar__search-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
}

.titlebar__search-key {
  flex: none;
  padding: 1px 5px;
  border: 1px solid var(--dv-ui-line-soft);
  border-radius: 4px;
  font-size: 10px;
  font-family: inherit;
  color: var(--dv-ui-text-dim);
}

.titlebar__spacer {
  flex: 1;
}

.titlebar__group {
  display: flex;
  align-items: center;
  gap: 2px;
}

.titlebar__icon {
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  border: none;
  border-radius: var(--dv-ui-radius-sm);
  background: transparent;
  color: var(--dv-ui-text-muted);
  cursor: pointer;
  transition:
    background var(--dv-ui-dur-1) var(--dv-ui-ease),
    color var(--dv-ui-dur-1) var(--dv-ui-ease);
}

.titlebar__icon:hover:not(:disabled) {
  background: var(--dv-ui-surface-2);
  color: var(--dv-ui-text);
}

/* 面板可见时按钮保持点亮：用户一眼就能看出这个按钮控制的是哪块面板 */
.titlebar__icon.is-on {
  background: var(--dv-ui-surface-3);
  color: var(--dv-ui-text);
}

.titlebar__icon:disabled {
  opacity: 0.3;
  cursor: default;
}
</style>
