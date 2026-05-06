import { ActionContext, Context, Plugin, PluginInitParams, PublicAPI, Query, Result, ResultTail, WoxImage, WoxPreviewListData, WoxPreviewListItem } from "@wox-launcher/wox-plugin"
import { spawn } from "child_process"
import fs from "fs"
import path from "path"

let api: PublicAPI
let pluginDirectory = ""

const toolbarMsgId = "rimage-compress-status"
const appIcon: WoxImage = {
  ImageType: "relative",
  ImageData: "images/app.svg"
}
const loadingLottieData = JSON.stringify({
  v: "5.7.4",
  fr: 60,
  ip: 0,
  op: 60,
  w: 128,
  h: 128,
  nm: "spinner",
  ddd: 0,
  assets: [],
  layers: [
    {
      ddd: 0,
      ind: 1,
      ty: 4,
      nm: "spinner",
      sr: 1,
      ks: {
        o: { a: 0, k: 100 },
        r: {
          a: 1,
          k: [
            { t: 0, s: [0] },
            { t: 60, s: [360] }
          ]
        },
        p: { a: 0, k: [64, 64, 0] },
        a: { a: 0, k: [64, 64, 0] },
        s: { a: 0, k: [100, 100, 100] }
      },
      shapes: [
        {
          ty: "gr",
          it: [
            { ty: "el", p: { a: 0, k: [64, 64] }, s: { a: 0, k: [84, 84] }, nm: "circle" },
            { ty: "tm", s: { a: 0, k: 0 }, e: { a: 0, k: 72 }, o: { a: 0, k: 0 }, m: 1, nm: "trim" },
            { ty: "st", c: { a: 0, k: [0.09, 0.47, 1, 1] }, o: { a: 0, k: 100 }, w: { a: 0, k: 10 }, lc: 2, lj: 2, nm: "stroke" },
            { ty: "tr", p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } }
          ],
          nm: "spinner-group"
        }
      ],
      ao: 0
    }
  ]
})
const loadingIcon: WoxImage = {
  ImageType: "lottie",
  ImageData: loadingLottieData
}
const doneIcon: WoxImage = {
  ImageType: "svg",
  ImageData:
    '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><rect x="12" y="12" width="104" height="104" rx="28" fill="#22C55E"/><path d="M38 66.5 56.5 85 91 43" fill="none" stroke="#FFFFFF" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/></svg>'
}

const imageCodecs: Record<string, string> = {
  ".jpg": "mozjpeg",
  ".jpeg": "mozjpeg",
  ".jpe": "mozjpeg",
  ".png": "oxipng",
  ".webp": "webp",
  ".avif": "avif"
}

interface ImageFile {
  path: string
  codec: string
}

interface PlatformBinary {
  directory: string
  executable: string
}

interface CompressionSettings {
  replaceOriginal: boolean
  stripMetadata: boolean
  threads?: number
  resize: string
  resizePolicy: "default" | "downscale" | "upscale"
  jpegQuality: number
  pngEffort: number
  pngInterlace: boolean
  webpQuality: number
  webpLossless: boolean
  avifQuality: number
  avifSpeed: number
}

type CompressionStatus = "pending" | "loading" | "done"

interface CompressionItem {
  originalPath: string
  outputPath: string
  codec: string
  beforeSize: number
  afterSize?: number
  changePercent?: number
  status: CompressionStatus
}

export const plugin: Plugin = {
  init: async (ctx: Context, initParams: PluginInitParams) => {
    api = initParams.API
    pluginDirectory = initParams.PluginDirectory || process.cwd()
    await api.Log(ctx, "Info", "RImage init finished")
  },

  query: async (ctx: Context, query: Query): Promise<Result[]> => {
    if (query.Type !== "selection") {
      return []
    }

    if (query.Selection.Type !== "file" || query.Selection.FilePaths.length === 0) {
      return [
        {
          Title: await tr(ctx, "select_images_title"),
          SubTitle: await tr(ctx, "select_images_subtitle"),
          Icon: appIcon
        }
      ]
    }

    const imageFiles = getSupportedImageFiles(query.Selection.FilePaths)

    if (imageFiles.length === 0) {
      return [
        {
          Title: await tr(ctx, "no_supported_images_title"),
          SubTitle: await tr(ctx, "supported_formats_subtitle"),
          Icon: appIcon
        }
      ]
    }

    const previewProperties = await buildPreviewProperties(ctx, imageFiles.length, getImageFilesSize(imageFiles))
    const previewData = buildPreviewListData(imageFiles.map(file => ({ path: file.path, status: "pending" })))

    return [
      {
        Title: await tr(ctx, "compress_images_title", { count: imageFiles.length }),
        Icon: appIcon,
        Preview: {
          PreviewType: "list",
          PreviewData: JSON.stringify(previewData),
          PreviewProperties: previewProperties
        },
        Actions: [
          {
            Name: await tr(ctx, "compress_action"),
            IsDefault: true,
            PreventHideAfterAction: true,
            ContextData: {
              files: JSON.stringify(imageFiles.map(file => file.path))
            },
            Action: async (actionCtx: Context, actionContext: ActionContext) => {
              const files = parseActionFiles(actionContext.ContextData.files)
              await compressFiles(actionCtx, files, actionContext.ResultId)
            }
          }
        ]
      }
    ]
  }
}

function getSupportedImageFiles(filePaths: string[]): ImageFile[] {
  const result: ImageFile[] = []
  for (const filePath of filePaths) {
    if (!isFile(filePath)) {
      continue
    }

    const codec = imageCodecs[path.extname(filePath).toLowerCase()]
    if (!codec) {
      continue
    }

    result.push({ path: filePath, codec })
  }

  return result
}

function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile()
  } catch {
    return false
  }
}

function parseActionFiles(rawFiles: string | undefined): string[] {
  if (!rawFiles) {
    return []
  }

  const parsed = JSON.parse(rawFiles)
  if (!Array.isArray(parsed)) {
    return []
  }

  return parsed.filter((item): item is string => typeof item === "string")
}

async function tr(ctx: Context, key: string, params: Record<string, string | number> = {}): Promise<string> {
  const template = typeof api.GetTranslation === "function" ? await api.GetTranslation(ctx, key) : key
  return Object.entries(params).reduce((result, [name, value]) => result.replace(new RegExp(`\\{${name}\\}`, "g"), String(value)), template)
}

async function buildPreviewProperties(ctx: Context, fileCount: number, totalSize: number): Promise<Record<string, string>> {
  return {
    [await tr(ctx, "preview_file_count")]: await tr(ctx, "preview_file_count_value", { count: fileCount }),
    [await tr(ctx, "preview_total_size")]: await tr(ctx, "preview_total_size_value", { size: formatBytes(totalSize) })
  }
}

function buildPreviewListData(files: Array<{ path: string; status: CompressionStatus; changePercent?: number }>): WoxPreviewListData {
  return {
    items: files.map(file => buildPreviewListItem(file.path, file.status, file.changePercent))
  }
}

function buildPreviewListItem(filePath: string, status: CompressionStatus, changePercent?: number): WoxPreviewListItem {
  const tails: ResultTail[] = []
  if (status === "done" && changePercent !== undefined) {
    tails.push({
      Type: "text",
      Text: formatChangePercent(changePercent),
      TextCategory: "danger"
    })
  }

  return {
    icon: getPreviewIcon(status),
    title: path.basename(filePath),
    subtitle: path.dirname(filePath),
    tails
  }
}

function getPreviewIcon(status: CompressionStatus): WoxImage {
  if (status === "loading") {
    return loadingIcon
  }
  if (status === "done") {
    return doneIcon
  }

  return appIcon
}

function formatChangePercent(percent: number): string {
  if (percent > 0) {
    return `+${percent}%`
  }

  return `${percent}%`
}

async function updateCompressionPreview(ctx: Context, resultId: string | undefined, files: CompressionItem[], previewProperties: Record<string, string>): Promise<void> {
  if (!resultId || typeof api.UpdateResult !== "function") {
    return
  }

  try {
    await api.UpdateResult(ctx, {
      Id: resultId,
      Preview: {
        PreviewType: "list",
        PreviewData: JSON.stringify(buildPreviewListData(files.map(file => ({ path: file.originalPath, status: file.status, changePercent: file.changePercent })))),
        PreviewProperties: previewProperties
      }
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await api.Log(ctx, "Warning", `UpdateResult preview failed: ${message}`)
  }
}

async function compressFiles(ctx: Context, filePaths: string[], resultId?: string): Promise<void> {
  const imageFiles = getSupportedImageFiles(filePaths)
  if (imageFiles.length === 0) {
    await api.Notify(ctx, await tr(ctx, "no_compressible_images_notify"))
    return
  }

  const binaryPath = await getRimageBinaryPath(ctx)
  if (!fs.existsSync(binaryPath)) {
    await api.Notify(ctx, await tr(ctx, "missing_binary_notify", { path: binaryPath }))
    await api.Log(ctx, "Error", `Missing rimage binary: ${binaryPath}`)
    return
  }

  const settings = await getCompressionSettings(ctx)
  const compressionItems: CompressionItem[] = imageFiles.map(file => ({
    originalPath: file.path,
    outputPath: settings.replaceOriginal ? file.path : getCompressedOutputPath(file.path),
    codec: file.codec,
    beforeSize: getFileSize(file.path),
    status: "pending"
  }))
  const sizeBefore = compressionItems.reduce((total, file) => total + file.beforeSize, 0)
  const previewProperties = await buildPreviewProperties(ctx, compressionItems.length, sizeBefore)
  let completed = 0

  await showToolbar(ctx, await tr(ctx, "toolbar_compressing", { count: imageFiles.length }), 0)

  try {
    for (const item of compressionItems) {
      await showToolbar(ctx, await tr(ctx, "toolbar_codec", { codec: item.codec, count: 1 }), Math.round((completed / compressionItems.length) * 100))
      item.status = "loading"
      await updateCompressionPreview(ctx, resultId, compressionItems, previewProperties)

      if (!settings.replaceOriginal) {
        fs.copyFileSync(item.originalPath, item.outputPath)
      }

      await runRimage(binaryPath, item.codec, settings, [item.outputPath])
      item.afterSize = getFileSize(item.outputPath)
      item.changePercent = calculateChangePercent(item.beforeSize, item.afterSize)
      item.status = "done"
      completed += 1
      await updateCompressionPreview(ctx, resultId, compressionItems, previewProperties)
      await showToolbar(ctx, await tr(ctx, "toolbar_file_done", { completed, total: compressionItems.length }), Math.round((completed / compressionItems.length) * 100))
    }

    const sizeAfter = compressionItems.reduce((total, file) => total + (file.afterSize ?? getFileSize(file.outputPath)), 0)
    const savedBytes = Math.max(sizeBefore - sizeAfter, 0)
    const message = savedBytes > 0 ? await tr(ctx, "compress_done_with_saved", { bytes: formatBytes(savedBytes) }) : await tr(ctx, "compress_done")
    await api.Notify(ctx, message)
    await api.Log(ctx, "Info", `${message}. files=${imageFiles.length}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await api.Notify(ctx, await tr(ctx, "compress_failed", { error: message }))
    await api.Log(ctx, "Error", `RImage compress failed: ${message}`)
  } finally {
    await clearToolbar(ctx)
  }
}

async function getRimageBinaryPath(ctx: Context): Promise<string> {
  const binary = await getPlatformBinary(ctx)
  return path.join(pluginDirectory, "vendor", "rimage", binary.directory, binary.executable)
}

async function getPlatformBinary(ctx: Context): Promise<PlatformBinary> {
  if (process.platform === "darwin" && process.arch === "arm64") {
    return { directory: "darwin-arm64", executable: "rimage" }
  }
  if (process.platform === "darwin" && process.arch === "x64") {
    return { directory: "darwin-x64", executable: "rimage" }
  }
  if (process.platform === "linux" && process.arch === "x64") {
    return { directory: "linux-x64", executable: "rimage" }
  }
  if (process.platform === "win32" && process.arch === "x64") {
    return { directory: "windows-x64", executable: "rimage.exe" }
  }

  throw new Error(await tr(ctx, "unsupported_platform", { platform: process.platform, arch: process.arch }))
}

async function getCompressionSettings(ctx: Context): Promise<CompressionSettings> {
  return {
    replaceOriginal: await getBooleanSetting(ctx, "replace_original", true),
    stripMetadata: await getBooleanSetting(ctx, "strip_metadata", false),
    threads: await getOptionalPositiveIntegerSetting(ctx, "threads"),
    resize: (await getSetting(ctx, "resize", "")).trim(),
    resizePolicy: normalizeResizePolicy(await getSetting(ctx, "resize_policy", "default")),
    jpegQuality: await getIntegerSetting(ctx, "jpeg_quality", 75, 0, 100),
    pngEffort: await getIntegerSetting(ctx, "png_effort", 2, 0, 6),
    pngInterlace: await getBooleanSetting(ctx, "png_interlace", false),
    webpQuality: await getIntegerSetting(ctx, "webp_quality", 75, 0, 100),
    webpLossless: await getBooleanSetting(ctx, "webp_lossless", false),
    avifQuality: await getIntegerSetting(ctx, "avif_quality", 50, 0, 100),
    avifSpeed: await getIntegerSetting(ctx, "avif_speed", 6, 1, 10)
  }
}

async function getSetting(ctx: Context, key: string, defaultValue: string): Promise<string> {
  if (typeof api.GetSetting !== "function") {
    return defaultValue
  }

  const value = await api.GetSetting(ctx, key)
  return value === "" ? defaultValue : value
}

async function getBooleanSetting(ctx: Context, key: string, defaultValue: boolean): Promise<boolean> {
  const value = (await getSetting(ctx, key, String(defaultValue))).trim().toLowerCase()
  return value === "true" || value === "1" || value === "yes"
}

async function getIntegerSetting(ctx: Context, key: string, defaultValue: number, min: number, max: number): Promise<number> {
  const parsed = Number.parseInt(await getSetting(ctx, key, String(defaultValue)), 10)
  if (!Number.isFinite(parsed)) {
    return defaultValue
  }

  return Math.min(Math.max(parsed, min), max)
}

async function getOptionalPositiveIntegerSetting(ctx: Context, key: string): Promise<number | undefined> {
  const value = (await getSetting(ctx, key, "")).trim()
  if (!value) {
    return undefined
  }

  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined
  }

  return parsed
}

function normalizeResizePolicy(value: string): CompressionSettings["resizePolicy"] {
  if (value === "downscale" || value === "upscale") {
    return value
  }

  return "default"
}

function buildRimageArgs(codec: string, settings: CompressionSettings, files: string[]): string[] {
  const args = [codec, "--quiet", "--no-progress"]
  if (settings.stripMetadata) {
    args.push("-x")
  }
  if (settings.threads) {
    args.push("-t", String(settings.threads))
  }
  if (settings.resize) {
    args.push("--resize", settings.resize)
    if (settings.resizePolicy === "downscale") {
      args.push("--downscale", "--no-upscale")
    } else if (settings.resizePolicy === "upscale") {
      args.push("--upscale", "--no-downscale")
    }
  }

  if (codec === "mozjpeg") {
    args.push("--quality", String(settings.jpegQuality))
  } else if (codec === "oxipng") {
    args.push("--effort", String(settings.pngEffort))
    if (settings.pngInterlace) {
      args.push("--interlace")
    }
  } else if (codec === "webp") {
    if (settings.webpLossless) {
      args.push("--lossless")
    } else {
      args.push("--quality", String(settings.webpQuality))
    }
  } else if (codec === "avif") {
    args.push("--quality", String(settings.avifQuality), "--speed", String(settings.avifSpeed))
  }

  args.push(...files)
  return args
}

function getCompressedOutputPath(file: string): string {
  const ext = path.extname(file)
  return path.join(path.dirname(file), `compress_${path.basename(file, ext)}${ext}`)
}

function getImageFilesSize(files: ImageFile[]): number {
  return files.reduce((total, file) => total + getFileSize(file.path), 0)
}

function calculateChangePercent(beforeSize: number, afterSize: number): number {
  if (beforeSize <= 0) {
    return 0
  }

  return Math.round(((afterSize - beforeSize) / beforeSize) * 100)
}

function getFileSize(file: string): number {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}

function runRimage(binaryPath: string, codec: string, settings: CompressionSettings, files: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = buildRimageArgs(codec, settings, files)
    const child = spawn(binaryPath, args, { windowsHide: true })
    let output = ""

    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString()
    })
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString()
    })
    child.on("error", reject)
    child.on("close", code => {
      if (code === 0) {
        resolve()
        return
      }

      reject(new Error(output.trim() || `rimage exited with code ${code}`))
    })
  })
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

async function showToolbar(ctx: Context, title: string, progress: number): Promise<void> {
  if (typeof api.ShowToolbarMsg !== "function") {
    return
  }

  await api.ShowToolbarMsg(ctx, {
    Id: toolbarMsgId,
    Title: title,
    Icon: appIcon,
    Progress: progress
  })
}

async function clearToolbar(ctx: Context): Promise<void> {
  if (typeof api.ClearToolbarMsg !== "function") {
    return
  }

  await api.ClearToolbarMsg(ctx, toolbarMsgId)
}
