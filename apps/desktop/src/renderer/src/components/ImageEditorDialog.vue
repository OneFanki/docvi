<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { FolderOpen, ImagePlus, Link2, Trash2, Upload, X } from 'lucide-vue-next'

import { parseImage, serializeImage, type ImageModel } from '@docvi/editor'

import { isWebHost } from '../lib/host'

/**
 * 图片块的可视化编辑器。
 *
 * 为什么需要它：图片的 Markdown 语法（`![描述](路径 "标题")`）对非技术写作者
 * 完全是障碍——路径要相对文档目录、含空格要尖括号、标题是可选项。直接给三个
 * 输入框，外加「选文件 / 拖进来」两个入口，用户只描述「用哪张图、写什么说明」。
 *
 * 产物仍是**一行标准 Markdown**（见 `image-model.ts`），不引入私有语法。
 * 素材文件落在文档同级 `assets/`，由宿主写盘（渲染进程没有写权限）。
 */
const props = defineProps<{
  open: boolean
  /** 现有图片源码；新建时为空串 */
  source: string
  /** 预览用的当前图片地址（已经过资源前缀解析） */
  preview?: string | null
  /** 当前宿主能否写盘（容器读者面没有写权限） */
  canImport?: boolean
  /** 工作区 id：图片要落到它下面的素材目录 */
  workspaceId?: string | null
  /** 文档在内容根内的相对路径：素材落在文档同级 `assets/` */
  docRelPath?: string | null
}>()

const emit = defineEmits<{
  save: [model: ImageModel]
  close: []
}>()

const draft = ref<ImageModel>({ alt: '', src: '', title: '' })
const dragOver = ref(false)
const busy = ref(false)
const failure = ref<string | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const altInput = ref<HTMLInputElement | null>(null)

/** 路径留空时预览一张占位图，避免弹窗一开就是一块空白让人以为坏了 */
const previewSrc = computed(() => {
  const src = draft.value.src.trim()
  if (!src) return null
  if (/^(https?:|data:|docvi:|\/\/|\/)/.test(src)) return src
  return props.preview ?? null
})

watch(
  () => props.open,
  async open => {
    failure.value = null
    dragOver.value = false
    if (!open) return
    const parsed = props.source ? parseImage(props.source) : null
    draft.value = parsed ?? { alt: '', src: '', title: '' }
    await nextTick()
    // 没有描述时先让用户写描述：那是唯一必填的「人话」字段
    if (!draft.value.alt) altInput.value?.focus()
  },
)

const canImport = computed(() => props.canImport && !isWebHost)

/** 把 File 读成 base64（不带 data: 前缀，由主进程统一处理） */
async function readBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer()
  let binary = ''
  const bytes = new Uint8Array(buffer)
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

/**
 * 导入一批图片文件：第一张写进字段，其余提示用户。
 *
 * 一格 Markdown 图片语法只能表达一张图；一次拖入五张时静默只取第一张会让用户
 * 以为丢图了，所以明确提示「一次一张」。
 */
async function importFiles(files: File[]): Promise<void> {
  const images = files.filter(
    file =>
      file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(file.name),
  )
  if (!images.length) {
    failure.value = '这里只能放图片文件'
    return
  }
  if (images.length > 1) {
    failure.value = `一次只能插入一张图片，已使用「${images[0]!.name}」`
  } else {
    failure.value = null
  }
  const file = images[0]!

  // 桌面宿主走落盘：拿到相对路径再写进 Markdown
  if (canImport.value) {
    const context = imageContext()
    if (!context) {
      failure.value = '当前文档不在工作区内，图片没法存进素材目录；可以改用本地路径或网络地址'
      return
    }
    busy.value = true
    try {
      const data = await readBase64(file)
      const result = await window.docvi.imageImport({
        workspaceId: context.workspaceId,
        docRelPath: context.docRelPath,
        name: file.name,
        data,
      })
      if (!result.ok) {
        failure.value = result.error.message
        return
      }
      draft.value = {
        ...draft.value,
        src: result.data.relPath,
        alt: draft.value.alt || file.name.replace(/\.[^.]+$/, ''),
      }
    } finally {
      busy.value = false
    }
    return
  }

  /*
   * 容器读者面 / 单文件：没有可写的工作区，退化成 data URL。
   *
   * 这是有意识的降级：图能看到、语法合法，只是文件会变大。不拦下来是因为
   * 「看一眼效果」的诉求真实存在，拦了用户就只能去别处拼图片链接。
   */
  busy.value = true
  try {
    const data = await readBase64(file)
    draft.value = {
      ...draft.value,
      src: `data:${file.type || 'image/png'};base64,${data}`,
      alt: draft.value.alt || file.name.replace(/\.[^.]+$/, ''),
    }
    failure.value = '当前文档不在工作区内，图片以 data URL 内嵌（文件会变大）'
  } finally {
    busy.value = false
  }
}

/**
 * 当前文档的写入上下文。
 *
 * 由宿主（EditorView → App）作为 props 传进来，弹窗不自己去找全局状态：
 * 「这篇文档在哪个工作区、相对路径是什么」只有宿主知道。
 */
function imageContext(): { workspaceId: string; docRelPath: string } | null {
  const workspaceId = props.workspaceId ?? ''
  if (!workspaceId) return null
  return { workspaceId, docRelPath: props.docRelPath ?? '' }
}

async function pickFile(): Promise<void> {
  // 容器读者面没有磁盘写权限：只能用浏览器文件框（走 data URL 降级）
  const context = imageContext()
  if (!canImport.value || !context) {
    fileInput.value?.click()
    return
  }
  /*
   * 桌面宿主：系统文件框 + 直接入库。
   *
   * 不能把选中的绝对路径写进 Markdown——渲染时会被当相对路径拼资源前缀，
   * 结果是破图。主进程读完字节直接落盘，回传的是「相对文档目录」的路径。
   */
  busy.value = true
  try {
    const picked = await window.docvi.imagePick({
      workspaceId: context.workspaceId,
      docRelPath: context.docRelPath,
    })
    if (!picked.ok) {
      failure.value = picked.error.message
      return
    }
    if (!picked.data) return
    draft.value = {
      ...draft.value,
      src: picked.data.relPath,
      alt:
        draft.value.alt ||
        picked.data.relPath
          .split('/')
          .pop()
          ?.replace(/\.[^.]+$/, '') ||
        '',
    }
    failure.value = null
  } finally {
    busy.value = false
  }
}

function onFileInput(event: Event): void {
  const files = Array.from((event.target as HTMLInputElement).files ?? [])
  if (files.length) void importFiles(files)
  // 清空以便重复选同一个文件也能触发 change
  if (fileInput.value) fileInput.value.value = ''
}

function onDrop(event: DragEvent): void {
  event.preventDefault()
  dragOver.value = false
  const files = Array.from(event.dataTransfer?.files ?? [])
  if (files.length) void importFiles(files)
}

function onDragOver(event: DragEvent): void {
  event.preventDefault()
  dragOver.value = true
}

function clear(): void {
  draft.value = { alt: '', src: '', title: '' }
  failure.value = null
}

function submit(): void {
  const model = { ...draft.value, src: draft.value.src.trim() }
  if (!model.src) {
    failure.value = '请先选择图片或填写图片地址'
    return
  }
  if (model.src.startsWith('data:') && model.src.length > 400_000) {
    failure.value = '图片太大，嵌进 Markdown 会让文件难以维护；请放进工作区后再引用'
    return
  }
  emit('save', model)
}

function onKeydown(event: KeyboardEvent): void {
  if (!props.open || event.key !== 'Escape') return
  event.preventDefault()
  event.stopPropagation()
  emit('close')
}

onMounted(() => window.addEventListener('keydown', onKeydown, true))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown, true))
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="img" @mousedown.self="emit('close')">
      <section class="img__card" role="dialog" aria-modal="true" aria-label="插入图片">
        <header class="img__head">
          <div>
            <h2 class="img__title">图片</h2>
            <p class="img__sub">选择文件、拖进来，或直接填图片地址</p>
          </div>
          <button class="img__icon" type="button" aria-label="关闭" @click="emit('close')">
            <X :size="15" :stroke-width="2" />
          </button>
        </header>

        <div class="img__body">
          <div
            class="img__drop"
            :class="{ 'is-over': dragOver, 'is-empty': !previewSrc }"
            @dragover="onDragOver"
            @dragleave="dragOver = false"
            @drop="onDrop"
          >
            <img v-if="previewSrc" :src="previewSrc" alt="" class="img__preview" />
            <div v-else class="img__placeholder">
              <ImagePlus :size="26" :stroke-width="1.4" aria-hidden="true" />
              <p>把图片拖到这里，或点下面的按钮选择</p>
            </div>
          </div>

          <div class="img__actions">
            <button class="img__btn" type="button" :disabled="busy" @click="pickFile">
              <FolderOpen :size="13" /> 选择本地文件
            </button>
            <label class="img__btn" :class="{ 'is-disabled': busy }">
              <Upload :size="13" /> 从浏览器选
              <input
                ref="fileInput"
                class="img__file"
                type="file"
                accept="image/*"
                @change="onFileInput"
              />
            </label>
            <button class="img__btn img__btn--ghost" type="button" @click="clear">
              <Trash2 :size="13" /> 清空
            </button>
          </div>

          <label class="img__field">
            <span class="img__label">图片地址</span>
            <span class="img__inputwrap">
              <Link2 :size="13" class="img__inputicon" />
              <input
                v-model="draft.src"
                class="img__input"
                type="text"
                spellcheck="false"
                :placeholder="
                  canImport ? '选择文件后自动填入，或粘贴 https:// 地址' : '粘贴图片地址'
                "
              />
            </span>
          </label>

          <label class="img__field">
            <span class="img__label">描述（替代文字）</span>
            <input
              ref="altInput"
              v-model="draft.alt"
              class="img__input"
              type="text"
              placeholder="这张图在说什么（读屏软件与图片加载失败时会显示）"
            />
          </label>

          <label class="img__field">
            <span class="img__label">标题（可选）</span>
            <input
              v-model="draft.title"
              class="img__input"
              type="text"
              placeholder="鼠标悬停时显示的说明"
            />
          </label>

          <p v-if="failure" class="img__error">{{ failure }}</p>
        </div>

        <footer class="img__foot">
          <code class="img__syntax">{{ draft.src ? serializeImage(draft) : '![](…)' }}</code>
          <button class="img__btn" type="button" @click="emit('close')">取消</button>
          <button class="img__btn img__btn--primary" type="button" @click="submit">保存</button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
/*
 * 尺寸与表格弹窗同一套策略：不写死宽度，按可用空间自适应；
 * 弹窗本体限高 92vh，内部滚动，窗口再小也不会被裁。
 */
.img {
  position: fixed;
  inset: 0;
  z-index: 96;
  display: grid;
  place-items: center;
  padding: clamp(8px, 2vh, 24px);
  background: color-mix(in srgb, var(--dv-ui-bg) 62%, transparent);
}

.img__card {
  display: flex;
  flex-direction: column;
  width: min(620px, 100%);
  max-height: min(92vh, 100%);
  border: 1px solid var(--dv-ui-line);
  border-radius: var(--dv-ui-radius-md);
  background: var(--dv-ui-surface-2);
  box-shadow: var(--dv-ui-shadow-2);
  overflow: hidden;
}

.img__head {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 16px 18px 12px;
  border-bottom: 1px solid var(--dv-ui-line-soft);
  flex: none;
}

.img__title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--dv-ui-text);
}

.img__sub {
  margin: 3px 0 0;
  font-size: 11.5px;
  color: var(--dv-ui-text-dim);
}

.img__icon {
  margin-left: auto;
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border: none;
  border-radius: var(--dv-ui-radius-sm);
  background: transparent;
  color: var(--dv-ui-text-dim);
  cursor: pointer;
}

.img__icon:hover {
  background: var(--dv-ui-surface-3);
  color: var(--dv-ui-text);
}

.img__body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 14px 18px 4px;
}

.img__drop {
  display: grid;
  place-items: center;
  min-height: 180px;
  max-height: 40vh;
  margin-bottom: 12px;
  padding: 10px;
  overflow: hidden;
  border: 1px dashed var(--dv-ui-line);
  border-radius: var(--dv-ui-radius-md);
  background: var(--dv-ui-bg);
  transition:
    border-color var(--dv-ui-dur-1, 0.12s) ease,
    background var(--dv-ui-dur-1, 0.12s) ease;
}

.img__drop.is-over {
  border-color: var(--dv-ui-accent);
  background: color-mix(in srgb, var(--dv-ui-accent) 10%, transparent);
}

.img__preview {
  max-width: 100%;
  max-height: 38vh;
  object-fit: contain;
}

.img__placeholder {
  display: grid;
  justify-items: center;
  gap: 8px;
  color: var(--dv-ui-text-dim);
  font-size: 12px;
}

.img__placeholder p {
  margin: 0;
}

.img__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 14px;
}

.img__btn {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--dv-ui-line-soft);
  border-radius: var(--dv-ui-radius-sm);
  background: transparent;
  color: var(--dv-ui-text-2);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.img__btn:hover {
  background: var(--dv-ui-surface-3);
  color: var(--dv-ui-text);
}

.img__btn:disabled,
.img__btn.is-disabled {
  opacity: 0.5;
  cursor: default;
}

.img__btn--ghost {
  border-color: transparent;
  color: var(--dv-ui-text-dim);
}

.img__btn--primary {
  border-color: transparent;
  background: var(--dv-ui-accent);
  color: var(--dv-ui-accent-fg);
}

.img__file {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
}

.img__field {
  display: block;
  margin-bottom: 12px;
}

.img__label {
  display: block;
  margin-bottom: 5px;
  font-size: 11.5px;
  color: var(--dv-ui-text-dim);
}

.img__inputwrap {
  position: relative;
  display: block;
}

.img__inputicon {
  position: absolute;
  left: 9px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--dv-ui-text-dim);
  pointer-events: none;
}

.img__input {
  width: 100%;
  height: 32px;
  padding: 0 9px;
  border: 1px solid var(--dv-ui-line-soft);
  border-radius: var(--dv-ui-radius-sm);
  background: var(--dv-ui-bg);
  color: var(--dv-ui-text);
  font: inherit;
  font-size: 12.5px;
  outline: none;
}

.img__inputwrap .img__input {
  padding-left: 28px;
}

.img__input:focus {
  border-color: var(--dv-ui-accent);
}

.img__error {
  margin: 0 0 10px;
  font-size: 11.5px;
  color: var(--dv-ui-danger);
}

.img__foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 18px 14px;
  border-top: 1px solid var(--dv-ui-line-soft);
  flex: none;
}

.img__syntax {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--dv-font-mono, ui-monospace, monospace);
  font-size: 11px;
  color: var(--dv-ui-text-dim);
}
</style>
