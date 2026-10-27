import { existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'

import type { ImageImportRequest, ImageImportResult } from '@docvi/shared'

import { resolveInside } from './content.ts'

/**
 * 图片入库：把外部图片字节落到文档同级的 `assets/`。
 *
 * 三条约束：
 *  1. **只按相对路径定位**：目标目录由「文档相对路径 → 同级 assets」推出，
 *     再经 `resolveInside` 校验，渲染进程无法指定任意磁盘位置；
 *  2. **文件名白名单**：只接受常见图片扩展名，主名清洗成安全字符——否则
 *     用户拖进来一个 `../../x.exe` 就能写到内容根外面；
 *  3. **重名自动加序号**：同一张图 paste 两次不该覆盖，也不该让用户改名。
 */

/** 支持的图片扩展名（大小写不敏感）。SVG 也算：它是文本，风险由内容作者承担。 */
const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.bmp',
  '.svg',
])

/** 单张图片上限：超过直接拒绝，避免把几百 MB 的文件读进内存再写一遍 */
const MAX_IMAGE_BYTES = 32 * 1024 * 1024

function fail(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

/** 主名清洗：去掉路径分隔符、控制字符与 Windows 保留字符，压掉多余空白 */
function safeStem(name: string, fallback: string): string {
  // 控制字符用 Unicode 属性类 `\p{Cc}` 表达：写成显式码点范围会被 no-control-regex 拦下，
  // 而这类字符必须在落盘前点掉（否则文件名在 Windows 上非法）
  const cleaned = name
    .replace(/[/\\]/g, '')
    .replace(/[<>:"|?*\p{Cc}]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/^[.\s-]+|[.\s-]+$/g, '')
    .slice(0, 60)
  return cleaned || fallback
}

/** 在目录里挑一个不撞名的文件名：`图.png` → `图-2.png` → `图-3.png` */
function uniquePath(dir: string, stem: string, ext: string): string {
  let candidate = join(dir, `${stem}${ext}`)
  let index = 2
  while (existsSync(candidate)) {
    candidate = join(dir, `${stem}-${index}${ext}`)
    index += 1
    if (index > 999) throw fail('E_EXISTS', '同名图片过多，请重命名后再试')
  }
  return candidate
}

/**
 * 文档所需的资源目录：与文档同级的 `assets/`（内容根内）。
 *
 * ⚠️ `resolveInside` 要求目标**已存在**（它做 realpath），所以不能直接拿
 * `docs/assets` 去校验。正确顺序是：先校验父目录（文档所在目录，必然存在），
 * 再在它下面建 `assets/`——这样越界判定仍走同一条防线，而目录可以按需创建。
 */
function assetDir(root: string, docRelPath: string): string {
  const docDir = docRelPath.includes('/') ? docRelPath.slice(0, docRelPath.lastIndexOf('/')) : ''
  const parent = docDir ? resolveInside(root, docDir) : realpathSync(root)
  const dir = join(parent, 'assets')
  mkdirSync(dir, { recursive: true })
  return dir
}

function toPosix(path: string): string {
  return path.replaceAll('\\', '/')
}

/** 相对文档目录的路径：`assets/图.png` / `../assets/图.png` 由调用方决定 */
function relativeFromDoc(docRelPath: string, absoluteAsset: string, root: string): string {
  const docDir = docRelPath.includes('/') ? docRelPath.slice(0, docRelPath.lastIndexOf('/')) : ''
  const assetRel = toPosix(absoluteAsset.slice(root.length).replace(/^[/\\]/, ''))
  if (!docDir) return assetRel
  // 素材目录与文档同级，直接去掉文档目录前缀即可（不做 ../ 计算：同级是本实现的约定）
  return assetRel.startsWith(`${docDir}/`) ? assetRel.slice(docDir.length + 1) : assetRel
}

export function importImage(root: string, request: ImageImportRequest): ImageImportResult {
  const rawName = request.name.trim() || 'image.png'
  const ext = extname(rawName).toLowerCase()
  if (!IMAGE_EXTENSIONS.has(ext)) {
    throw fail('E_INVALID', `不支持的图片格式：${ext || '无扩展名'}`)
  }

  // base64 可能是 data URL 形式（渲染进程直接透传 clipboard 的字符串）
  const base64 = request.data.replace(/^data:[^;]+;base64,/, '')
  if (!base64) throw fail('E_INVALID', '图片内容为空')

  const bytes = Buffer.from(base64, 'base64')
  if (bytes.length === 0) throw fail('E_INVALID', '图片内容为空')
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw fail('E_TOO_LARGE', '图片超过 32MB 上限')
  }

  const dir = assetDir(root, request.docRelPath)
  const stem = safeStem(rawName.slice(0, rawName.length - ext.length), 'image')
  const target = uniquePath(dir, stem, ext)
  writeFileSync(target, bytes)
  const stat = statSync(target)

  return {
    relPath: relativeFromDoc(request.docRelPath, target, root),
    absolutePath: toPosix(target),
    size: stat.size,
  }
}
