<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  Clock,
  CloudUpload,
  FilePlus2,
  FolderGit2,
  FolderPlus,
  FolderUp,
  GitBranch,
  RefreshCw,
  Share2,
  Trash2,
} from 'lucide-vue-next'

import type { PortalWorkspace, RecentEntry, WorkspaceEntry } from '@docvi/shared'
import { LOCAL_PREVIEW_ID } from '@docvi/shared'
import { useI18n } from '../lib/i18n'
import BranchPicker from './BranchPicker.vue'
import ContextMenu, { type MenuItem } from './ContextMenu.vue'

/**
 * 库视图：工作区卡片网格 + 最近打开。
 *
 * 空状态是首次启动的唯一入口，必须把「添加目录」做成最显眼的动作——
 * 旧版首页在这一步放了太多说明文字，反而让人不知道该点什么。
 */
const props = defineProps<{
  workspaces: WorkspaceEntry[]
  activeId: string | null
  recent: RecentEntry[]
  /**
   * 只读宿主（容器版）：没有本地目录、没有 git、没有临时分享。
   *
   * 三个添加入口与卡片上的 git / 删除动作整体不渲染——它们在容器里全是
   * 必然失败的操作。工作区卡片仍然可点（那就是「进入这个仓库」）。
   */
  readonly?: boolean
  /** 工作区清单正在加载：首屏占位，不显示「还没有文档目录」 */
  loading?: boolean
  /** 容器读者面：当前仓库的分支选择（缺省 = 各仓默认分支） */
  branchOf?: (slug: string) => string | null
}>()

const emit = defineEmits<{
  add: []
  clone: []
  open: [id: string]
  remove: [id: string]
  switchBranch: [id: string]
  pull: [id: string]
  share: [id: string]
  openFile: []
  openRecent: [entry: RecentEntry]
  clearRecent: []
  /** 容器版：切到某个已发布分支（只改 URL 上的 ?branch=） */
  selectBranch: [payload: { slug: string; branch: string }]
  /** 容器版：装载本地 Markdown 预览 */
  localPreview: [payload: { files: Array<{ path: string; text: string }>; kind: 'files' | 'dir' }]
  /** 容器版：复制 MCP 端点地址 */
  copyMcp: []
}>()

/** 最近打开里，仍然存在于工作区列表的条目给出归属标记 */
const { t } = useI18n()

/** 工作区卡片右键：打开 / 切分支 / 拉取 / 移除（与命令面板同源） */
const menu = ref<{ open: boolean; x: number; y: number; id: string }>({
  open: false,
  x: 0,
  y: 0,
  id: '',
})

function openMenu(event: MouseEvent, id: string): void {
  menu.value = { open: true, x: event.clientX, y: event.clientY, id }
}

const menuWorkspace = computed(
  () => props.workspaces.find(item => item.id === menu.value.id) ?? null,
)

const menuItems = computed<MenuItem[]>(() => {
  const git = menuWorkspace.value?.git
  return [
    { id: 'open', label: t('ws.openNewTab') },
    ...(props.readonly
      ? []
      : [
          { id: 'share', label: t('library.shareDir') },
          ...(git
            ? [
                { id: 'switch', label: t('git.switchBranch'), hint: git.branch },
                { id: 'pull', label: t('git.pullNow') },
              ]
            : []),
          { id: 'remove', label: t('ws.remove'), danger: true, separatorBefore: true },
        ]),
  ]
})

function onMenuSelect(id: string): void {
  if (id === 'open') emit('open', menu.value.id)
  else if (id === 'share') emit('share', menu.value.id)
  else if (id === 'switch') emit('switchBranch', menu.value.id)
  else if (id === 'pull') emit('pull', menu.value.id)
  else if (id === 'remove') emit('remove', menu.value.id)
}

const workspaceNames = computed(
  () => new Map(props.workspaces.map(workspace => [workspace.id, workspace.name])),
)

/* ---------- 容器读者面：仓库状态与入口 ---------- */

/** 本地预览工作区：卡片上不显示分支/同步状态，也不给运维等操作 */
function isLocalPreview(ws: WorkspaceEntry): boolean {
  return ws.id === LOCAL_PREVIEW_ID
}

/** 卡片角标：克隆中 / 同步失败 / 最近同步时间（桌面工作区没有 portal，不显示） */
function syncBadge(ws: WorkspaceEntry): { text: string; tone: 'warn' | 'dim' } | null {
  const portal = ws.portal
  if (!portal) return null
  if (portal.cloning) return { text: t('portal.cloning'), tone: 'dim' }
  if (portal.syncError)
    return { text: t('portal.syncError', { message: portal.syncError }), tone: 'warn' }
  if (!portal.syncAt) return { text: t('portal.neverSynced'), tone: 'dim' }
  return { text: t('portal.syncAt', { time: formatTime(Date.parse(portal.syncAt)) }), tone: 'dim' }
}

/** MCP 端点：容器里就是当前站点源 + /mcp（部署器固定路由） */
const mcpUrl = computed(() => (typeof location === 'undefined' ? '/mcp' : `${location.origin}/mcp`))
const mcpCopied = ref(false)

async function copyMcp(): Promise<void> {
  try {
    await navigator.clipboard.writeText(mcpUrl.value)
    mcpCopied.value = true
    window.setTimeout(() => {
      mcpCopied.value = false
    }, 1600)
    emit('copyMcp')
  } catch {
    // 剪贴板被拒（非安全上下文）：地址本身可见可手选，不打断使用
  }
}

/**
 * 本地 Markdown 选择。
 *
 * 两个隐藏 input 而不是 `showOpenFilePicker`：后者在 Firefox/Safari 不支持，
 * 而且目录选择只有 `webkitdirectory` 这一条跨浏览器可行的路。
 */
const fileInput = ref<HTMLInputElement | null>(null)
const dirInput = ref<HTMLInputElement | null>(null)
const reading = ref(false)
const localError = ref('')

async function readEntries(list: FileList | null, kind: 'files' | 'dir'): Promise<void> {
  if (!list?.length) return
  reading.value = true
  localError.value = ''
  try {
    const picked = [...list].filter(file => /\.md$/i.test(file.name))
    if (!picked.length) {
      localError.value = t('portal.localEmpty')
      return
    }
    const files = await Promise.all(
      picked.map(async file => ({
        // 目录选择时 webkitRelativePath 带用户选中那层目录名，交给宿主剥共同根
        path: kind === 'dir' ? file.webkitRelativePath || file.name : file.name,
        text: await file.text(),
      })),
    )
    emit('localPreview', { files, kind })
  } catch (error) {
    localError.value = `${t('portal.localFailed')}：${(error as Error).message}`
  } finally {
    reading.value = false
    if (fileInput.value) fileInput.value.value = ''
    if (dirInput.value) dirInput.value.value = ''
  }
}

/** 卡片上的分支选择器只给容器仓库，且至少有两个分支时才值得显示 */
function showBranchPicker(ws: WorkspaceEntry): boolean {
  return (ws.portal?.branches.length ?? 0) > 1
}

/**
 * 卡片是否可进入：仓库还没有任何可浏览分支时点进去只有空树。
 *
 * 克隆中的仓库要显示（读者知道它存在），但进去看一页空白更像故障——
 * 所以卡片保留、点击不开。
 */
function canEnter(ws: WorkspaceEntry): boolean {
  const portal = ws.portal
  if (!portal) return true
  if (portal.cloning) return false
  return portal.branches.some(item => item.artifact === 'ready')
}

function onCardClick(ws: WorkspaceEntry): void {
  if (!canEnter(ws)) return
  emit('open', ws.id)
}

/** 命令面板的「本地预览」入口复用这里的选择框，避免两处各挂一个 input */
defineExpose({ pickLocalFiles: () => fileInput.value?.click() })

function formatTime(ts: number): string {
  const diff = Date.now() - ts
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (diff < minute) return '刚刚'
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`
  if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`
  return new Date(ts).toLocaleDateString('zh-CN')
}
</script>

<template>
  <div class="library">
    <div class="library__inner">
      <div class="library__head">
        <h1 class="library__title">文档库</h1>
        <div v-if="!readonly" class="library__actions">
          <button class="btn" type="button" @click="emit('openFile')">
            <FilePlus2 :size="15" :stroke-width="1.8" />
            <span>{{ t('library.openFile') }}</span>
          </button>
          <button class="btn" type="button" @click="emit('clone')">
            <FolderGit2 :size="15" :stroke-width="1.8" />
            <span>{{ t('library.clone') }}</span>
          </button>
          <button class="btn btn--primary" type="button" @click="emit('add')">
            <FolderPlus :size="15" :stroke-width="1.8" />
            <span>{{ t('library.addFolder') }}</span>
          </button>
        </div>
      </div>

      <!--
        容器读者面：MCP 与本地预览合成一条工具条。
        它们原先各占一张大卡（图标 + 标题 + 两行说明 + 操作行），半屏被这两块
        吃掉，真正要点的仓库列表被推到了首屏之外。说明性文字改挂 tooltip，
        需要时悬停看得到，常态不占位。
      -->
      <section v-if="readonly" class="portal-bar">
        <div class="portal-bar__item">
          <CloudUpload :size="14" :stroke-width="1.8" class="portal-bar__icon" />
          <span v-tooltip="t('portal.mcpDesc')" class="portal-bar__label">{{
            t('portal.mcpTitle')
          }}</span>
          <code class="portal-bar__url">{{ mcpUrl }}</code>
          <button class="portal-bar__btn" type="button" @click="copyMcp">
            {{ mcpCopied ? t('portal.mcpCopied') : t('portal.mcpCopy') }}
          </button>
        </div>
        <span class="portal-bar__sep" aria-hidden="true" />
        <div class="portal-bar__item">
          <FolderUp :size="14" :stroke-width="1.8" class="portal-bar__icon" />
          <span v-tooltip="t('portal.localDesc')" class="portal-bar__label">{{
            t('portal.localTitle')
          }}</span>
          <button
            class="portal-bar__btn"
            type="button"
            :disabled="reading"
            @click="fileInput?.click()"
          >
            {{ t('portal.localPick') }}
          </button>
          <button
            class="portal-bar__btn"
            type="button"
            :disabled="reading"
            @click="dirInput?.click()"
          >
            {{ t('portal.localPickDir') }}
          </button>
        </div>
        <span v-if="localError" class="portal-bar__error" role="alert">{{ localError }}</span>
      </section>
      <input
        v-if="readonly"
        ref="fileInput"
        class="portal-file"
        type="file"
        accept=".md,text/markdown"
        multiple
        @change="readEntries(($event.target as HTMLInputElement).files, 'files')"
      />
      <input
        v-if="readonly"
        ref="dirInput"
        class="portal-file"
        type="file"
        webkitdirectory
        multiple
        @change="readEntries(($event.target as HTMLInputElement).files, 'dir')"
      />

      <div v-if="!workspaces.length && loading" class="empty">
        <p class="empty__text">{{ t('library.loading') }}</p>
      </div>
      <div v-else-if="!workspaces.length" class="empty">
        <div class="empty__art" aria-hidden="true">
          <span class="empty__sheet" />
          <span class="empty__sheet" />
          <span class="empty__sheet" />
        </div>
        <h2 class="empty__title">
          {{ readonly ? t('library.emptyWeb') : t('library.emptyTitle') }}
        </h2>
        <p v-if="!readonly" class="empty__text">{{ t('library.emptyText') }}</p>
        <div v-if="!readonly" class="empty__actions">
          <button class="btn btn--primary" type="button" @click="emit('add')">
            <FolderPlus :size="15" :stroke-width="1.8" />
            <span>{{ t('library.pickFolder') }}</span>
          </button>
          <button class="btn" type="button" @click="emit('clone')">
            <FolderGit2 :size="15" :stroke-width="1.8" />
            <span>{{ t('library.cloneRepo') }}</span>
          </button>
          <button class="btn" type="button" @click="emit('openFile')">
            <FilePlus2 :size="15" :stroke-width="1.8" />
            <span>{{ t('library.openSingle') }}</span>
          </button>
        </div>
      </div>

      <section v-if="workspaces.length" class="section">
        <h2 class="section__title">{{ t('library.workspaces') }}</h2>
        <div class="grid">
          <article
            v-for="ws in workspaces"
            :key="ws.id"
            class="card"
            :class="{ 'is-active': ws.id === activeId, 'is-disabled': !canEnter(ws) }"
            @click="onCardClick(ws)"
            @contextmenu.prevent="openMenu($event, ws.id)"
          >
            <div class="card__head">
              <h3 class="card__name">{{ ws.name }}</h3>
              <div v-if="!readonly" class="card__head-actions">
                <!--
                  分享与删除都是「对这张卡片的动作」，放在同一组图标里。
                  原先分享是下方一枚带文字的按钮，卡片上就出现了两种操作形态
                  （图标 vs 文字），扫一眼分不清哪些是同级动作。
                -->
                <button
                  v-tooltip="t('library.shareDir')"
                  class="card__icon"
                  type="button"
                  :aria-label="t('library.shareDir')"
                  @click.stop="emit('share', ws.id)"
                >
                  <Share2 :size="14" :stroke-width="1.7" />
                </button>
                <button
                  v-tooltip="t('library.removeHint')"
                  class="card__icon card__icon--danger"
                  type="button"
                  :aria-label="t('ws.remove')"
                  @click.stop="emit('remove', ws.id)"
                >
                  <Trash2 :size="14" :stroke-width="1.7" />
                </button>
              </div>
            </div>
            <p v-tooltip="ws.root" class="card__path">{{ ws.root }}</p>
            <div class="card__foot">
              <template v-if="ws.git">
                <span v-tooltip="ws.git.url" class="card__git">
                  <GitBranch :size="12" :stroke-width="1.7" />
                  <span class="card__branch">{{ ws.git.branch }}</span>
                </span>
              </template>
              <template v-else-if="isLocalPreview(ws)">
                <FolderUp :size="12" :stroke-width="1.7" />
                <span>{{ t('portal.localBadge') }}</span>
              </template>
              <template v-else>
                <Clock :size="12" :stroke-width="1.7" />
                <span>{{ t('library.openedAt', { time: formatTime(ws.lastOpenedAt) }) }}</span>
              </template>
            </div>
            <!--
              容器仓库的状态带：克隆中 / 同步失败 / 最近同步。读者据此知道
              「看不到新内容」是平台还没同步，而不是自己找错地方了。
            -->
            <p
              v-if="syncBadge(ws)"
              class="card__sync"
              :class="{ 'is-warn': syncBadge(ws)?.tone === 'warn' }"
            >
              {{ syncBadge(ws)?.text }}
            </p>
            <div v-if="readonly && showBranchPicker(ws)" class="card__branchrow" @click.stop>
              <BranchPicker
                :workspace="ws.portal as PortalWorkspace"
                :current="branchOf?.(ws.id) ?? null"
                @select="emit('selectBranch', { slug: ws.id, branch: $event })"
              />
            </div>
            <div v-if="!readonly && ws.git" class="card__git-actions">
              <template v-if="ws.git">
                <button class="mini" type="button" @click.stop="emit('switchBranch', ws.id)">
                  <GitBranch :size="11" :stroke-width="1.8" />
                  <span>{{ t('git.switchBranch') }}</span>
                </button>
                <button class="mini" type="button" @click.stop="emit('pull', ws.id)">
                  <RefreshCw :size="11" :stroke-width="1.8" />
                  <span>{{ t('git.pullNow') }}</span>
                </button>
              </template>
            </div>
          </article>
        </div>
      </section>

      <section v-if="recent.length" class="section">
        <div class="section__head">
          <h2 class="section__title">{{ t('library.recent') }}</h2>
          <button class="link" type="button" @click="emit('clearRecent')">
            {{ t('library.clearRecent') }}
          </button>
        </div>
        <div class="recents">
          <button
            v-for="entry in recent"
            :key="entry.path"
            v-tooltip="entry.path"
            class="recent"
            type="button"
            @click="emit('openRecent', entry)"
          >
            <span class="recent__title">{{ entry.title }}</span>
            <span class="recent__meta">
              <span v-if="entry.workspaceId" class="recent__badge">{{
                workspaceNames.get(entry.workspaceId) ?? t('library.removedWorkspace')
              }}</span>
              <span v-else class="recent__badge recent__badge--file">{{
                t('library.singleFile')
              }}</span>
              <span class="recent__time">{{ formatTime(entry.openedAt) }}</span>
            </span>
          </button>
        </div>
      </section>
    </div>
  </div>

  <ContextMenu
    :open="menu.open"
    :x="menu.x"
    :y="menu.y"
    :items="menuItems"
    @close="menu.open = false"
    @select="onMenuSelect"
  />
</template>

<style scoped>
/*
 * 两层结构：外层是滚动容器，必须吃满画布宽度；内层才是限宽的内容列。
 *
 * 原先外层同时承担 max-width 与 overflow-y，滚动条就贴着 1100px 内容列的
 * 右缘浮在窗口中间，离窗口右边还有两百多像素——看起来像没贴边。
 * 滚动条的位置由「overflow 元素的实际宽度」决定，想要贴边，滚动容器就必须
 * 是满宽的，限宽只能落在它内部的子元素上。
 */
.library {
  height: 100%;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.library__inner {
  max-width: 1100px;
  margin: 0 auto;
  /* 右侧多留 96px：右上角的运维按钮是 fixed 的，不与内容列抢位 */
  padding: 32px 32px 64px;
}

.library__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 22px;
}

.library__title {
  margin: 0;
  font-size: 20px;
  font-weight: 620;
  letter-spacing: -0.01em;
  color: var(--dv-ui-text);
}

.library__actions {
  display: flex;
  gap: 8px;
}

.btn {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 32px;
  padding: 0 14px;
  border: 1px solid var(--dv-ui-line-soft);
  border-radius: var(--dv-ui-radius-sm);
  background: transparent;
  color: var(--dv-ui-text-2);
  font-size: 12.5px;
  cursor: pointer;
  transition:
    background var(--dv-ui-dur-1) var(--dv-ui-ease),
    border-color var(--dv-ui-dur-1) var(--dv-ui-ease);
}

.btn:hover {
  background: var(--dv-ui-surface-2);
  border-color: var(--dv-ui-line);
}

.btn--primary {
  background: var(--dv-ui-accent);
  border-color: transparent;
  color: var(--dv-ui-accent-fg);
  font-weight: 560;
}

.btn--primary:hover {
  background: var(--dv-ui-accent-strong);
}

.empty {
  margin-top: 8vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
}

.empty__art {
  display: flex;
  gap: 5px;
  margin-bottom: 22px;
}

.empty__sheet {
  width: 18px;
  height: 26px;
  border: 1px solid var(--dv-ui-line);
  border-radius: 3px;
  background: var(--dv-ui-surface-1);
}

.empty__sheet:nth-child(2) {
  transform: translateY(-5px);
  border-color: var(--dv-ui-accent);
}

.empty__title {
  margin: 0 0 8px;
  font-size: 16px;
  font-weight: 600;
  color: var(--dv-ui-text);
}

.empty__text {
  max-width: 400px;
  margin: 0 0 20px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--dv-ui-text-muted);
}

.empty__actions {
  display: flex;
  gap: 10px;
}

.section {
  margin-top: 26px;
}

.section__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}

.section__title {
  margin: 0 0 12px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--dv-ui-text-dim);
}

.link {
  border: none;
  background: transparent;
  color: var(--dv-ui-text-dim);
  font-size: 11.5px;
  cursor: pointer;
}

.link:hover {
  color: var(--dv-ui-text-2);
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(258px, 1fr));
  gap: 12px;
}

.card {
  padding: 14px;
  border: 1px solid var(--dv-ui-line-soft);
  border-radius: var(--dv-ui-radius-md);
  background: var(--dv-ui-surface-1);
  cursor: pointer;
  transition:
    border-color var(--dv-ui-dur-1) var(--dv-ui-ease),
    background var(--dv-ui-dur-1) var(--dv-ui-ease);
}

.card:hover {
  border-color: var(--dv-ui-line);
  background: var(--dv-ui-surface-2);
}

.card.is-active {
  border-color: var(--dv-ui-accent);
}

.card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.card__name {
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--dv-ui-text);
}

.card__head-actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: 2px;
}

/*
 * 卡片头部的图标动作：默认隐藏，悬停整卡才出现。
 * 常驻会在一屏十几张卡片上形成密集的图标噪声；删除与分享都不是需要
 * 一直看见的信息。键盘用户靠 focus-visible 仍能唤出。
 */
.card__icon {
  flex: none;
  width: 24px;
  height: 24px;
  display: grid;
  place-items: center;
  border: none;
  border-radius: var(--dv-ui-radius-sm);
  background: transparent;
  color: var(--dv-ui-text-dim);
  cursor: pointer;
  opacity: 0;
  transition:
    opacity var(--dv-ui-dur-1) var(--dv-ui-ease),
    background var(--dv-ui-dur-1) var(--dv-ui-ease),
    color var(--dv-ui-dur-1) var(--dv-ui-ease);
}

.card:hover .card__icon,
.card__icon:focus-visible {
  opacity: 1;
}

.card__icon:hover {
  background: var(--dv-ui-surface-3);
  color: var(--dv-ui-text);
}

.card__icon--danger:hover {
  color: var(--dv-ui-danger);
}

.card__path {
  margin: 6px 0 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
  text-align: left;
  font-size: 11.5px;
  color: var(--dv-ui-text-dim);
}

.card__foot {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11.5px;
  color: var(--dv-ui-text-dim);
}

/* 容器仓库的同步状态：失败要能一眼看见，正常就低调 */
.card__sync {
  margin: 8px 0 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--dv-ui-text-dim);
}

.card__sync.is-warn {
  color: var(--dv-ui-danger);
}

.card__branchrow {
  margin-top: 10px;
}

/* 还没有可浏览分支的仓库：卡片保留（读者要知道它存在），但不给可点的暗示 */
.card.is-disabled {
  cursor: default;
  opacity: 0.72;
}

.card.is-disabled:hover {
  border-color: var(--dv-ui-line);
}

/* ---------- 容器读者面：平台级入口 ---------- */

/* 容器读者面：MCP 与本地预览合成一条工具条，说明文字挂 tooltip，常态只留一行 */
.portal-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 18px;
  padding: 8px 12px;
  border: 1px solid var(--dv-ui-line);
  border-radius: var(--dv-ui-radius-md);
  background: var(--dv-ui-surface-1);
  font-size: 12px;
}

.portal-bar__item {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}

.portal-bar__icon {
  flex: none;
  color: var(--dv-ui-text-dim);
}

.portal-bar__label {
  flex: none;
  color: var(--dv-ui-text-2);
  cursor: help;
  border-bottom: 1px dotted var(--dv-ui-line);
}

.portal-bar__url {
  min-width: 0;
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 2px 6px;
  border-radius: var(--dv-ui-radius-sm);
  background: var(--dv-ui-surface-2);
  font-family: var(--dv-font-mono);
  font-size: 11px;
  color: var(--dv-ui-text-dim);
}

.portal-bar__btn {
  flex: none;
  padding: 2px 8px;
  border: 1px solid var(--dv-ui-line);
  border-radius: var(--dv-ui-radius-sm);
  background: var(--dv-ui-surface-2);
  color: var(--dv-ui-text-2);
  font-size: 11.5px;
  cursor: pointer;
}

.portal-bar__btn:hover:not(:disabled) {
  border-color: var(--dv-ui-accent);
  color: var(--dv-ui-accent);
}

.portal-bar__btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.portal-bar__sep {
  width: 1px;
  height: 16px;
  background: var(--dv-ui-line);
}

.portal-bar__error {
  color: var(--dv-ui-danger);
}

/* 隐藏的系统文件选择框：按钮负责触发，原生控件不参与布局 */
.portal-file {
  display: none;
}

/* git 分支徽标：同一行只放一个，长分支名截断而不是把图标挤走 */
.card__git {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  max-width: 100%;
  color: var(--dv-ui-text-2);
}

.card__branch {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--dv-font-mono, ui-monospace, monospace);
  font-size: 11px;
}

.card__git-actions {
  display: flex;
  gap: 6px;
  margin-top: 10px;
}

.mini {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 8px;
  border: 1px solid var(--dv-ui-line-soft);
  border-radius: var(--dv-ui-radius-sm);
  background: transparent;
  color: var(--dv-ui-text-muted);
  font-size: 11px;
  cursor: pointer;
}

.mini:hover {
  border-color: var(--dv-ui-line);
  background: var(--dv-ui-surface-3);
  color: var(--dv-ui-text);
}

.recents {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.recent {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid transparent;
  border-radius: var(--dv-ui-radius-sm);
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.recent:hover {
  border-color: var(--dv-ui-line-soft);
  background: var(--dv-ui-surface-1);
}

.recent__title {
  font-size: 12.5px;
  color: var(--dv-ui-text);
}

.recent__meta {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
}

.recent__badge {
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--dv-ui-surface-2);
  font-size: 10.5px;
  color: var(--dv-ui-text-dim);
}

.recent__badge--file {
  background: color-mix(in srgb, var(--dv-ui-accent) 16%, transparent);
  color: var(--dv-ui-accent);
}

.recent__time {
  font-size: 10.5px;
  color: var(--dv-ui-text-dim);
}
</style>
