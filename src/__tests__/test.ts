import fs from "fs"
import os from "os"
import path from "path"
import { EventEmitter } from "events"
import { Context, PublicAPI, Query, WoxImage } from "@wox-launcher/wox-plugin"
import { plugin } from "../index"
import pluginManifest from "../../plugin.json"

const manifest = pluginManifest as { I18n: Record<string, Record<string, string>> }
const spawnMock = jest.fn()
const updateResultMock = jest.fn()

jest.mock("child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args)
}))

function createQuery(overrides: Partial<Query>): Query {
  return {
    Id: "1",
    Env: { ActiveWindowTitle: "", ActiveWindowPid: 0, ActiveBrowserUrl: "", ActiveWindowIcon: {} as WoxImage },
    RawQuery: "",
    Selection: { Type: "text", Text: "", FilePaths: [] },
    Type: "input",
    Search: "",
    TriggerKeyword: "ri",
    Command: "",
    IsGlobalQuery(): boolean {
      return false
    },
    ...overrides
  } as Query
}

beforeEach(async () => {
  spawnMock.mockReset()
  updateResultMock.mockReset()
  updateResultMock.mockResolvedValue(true)
  await plugin.init({} as Context, {
    PluginDirectory: process.cwd(),
    API: {
      Log: async () => undefined,
      GetTranslation: async (_ctx: Context, key: string) => manifest.I18n.zh_CN[key] || key,
      GetSetting: async () => "",
      Notify: async () => undefined,
      ShowToolbarMsg: async () => undefined,
      ClearToolbarMsg: async () => undefined,
      UpdateResult: updateResultMock
    } as unknown as PublicAPI
  })
})

test("ignores input query because the plugin is selection-only", async () => {
  const results = await plugin.query({} as Context, createQuery({ Type: "input", Search: "test" }))

  expect(results).toHaveLength(0)
})

test("returns batch compression result for selected images", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wox-rimage-test-"))
  const jpgPath = path.join(tempDir, "photo.jpg")
  const pngPath = path.join(tempDir, "icon.png")
  const textPath = path.join(tempDir, "notes.txt")
  fs.writeFileSync(jpgPath, "jpeg")
  fs.writeFileSync(pngPath, "png")
  fs.writeFileSync(textPath, "text")

  const results = await plugin.query(
    {} as Context,
    createQuery({
      Type: "selection",
      Selection: { Type: "file", Text: "", FilePaths: [jpgPath, pngPath, textPath] }
    })
  )

  expect(results).toHaveLength(1)
  expect(results[0].Title).toBe("压缩 2 张图片")
  expect(results[0].SubTitle).toBeUndefined()
  expect(results[0].Preview?.PreviewType).toBe("list")
  expect(JSON.parse(results[0].Preview?.PreviewData || "{}")).toEqual({
    items: [
      { icon: { ImageType: "relative", ImageData: "images/app.svg" }, title: "photo.jpg", subtitle: tempDir, tails: [] },
      { icon: { ImageType: "relative", ImageData: "images/app.svg" }, title: "icon.png", subtitle: tempDir, tails: [] }
    ]
  })
  expect(results[0].Preview?.PreviewProperties).toEqual({
    文件: "2 文件",
    大小: "共 7 B"
  })
  expect(results[0].Tails).toBeUndefined()
  expect(results[0].Actions?.[0].Name).toBe("压缩图片")
  expect(results[0].Actions?.[0].IsDefault).toBe(true)
})

test("updates list preview while compressing selected images", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wox-rimage-preview-test-"))
  const firstPath = path.join(tempDir, "first.jpg")
  const secondPath = path.join(tempDir, "second.jpg")
  fs.writeFileSync(firstPath, "a".repeat(100))
  fs.writeFileSync(secondPath, "b".repeat(200))

  spawnMock.mockImplementation((_binaryPath: string, args: string[]) => {
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    setImmediate(() => {
      const targetPath = args[args.length - 1]
      fs.writeFileSync(targetPath, targetPath === firstPath ? "a".repeat(66) : "b".repeat(100))
      child.emit("close", 0)
    })
    return child
  })

  const results = await plugin.query(
    {} as Context,
    createQuery({
      Type: "selection",
      Selection: { Type: "file", Text: "", FilePaths: [firstPath, secondPath] }
    })
  )
  const action = results[0].Actions?.[0] as {
    Action: (ctx: Context, actionContext: { ResultId: string; ResultActionId: string; ContextData: Record<string, string> }) => Promise<void>
    ContextData?: Record<string, string>
  }

  await action.Action({} as Context, {
    ResultId: "result",
    ResultActionId: "action",
    ContextData: action.ContextData || {}
  })

  expect(updateResultMock).toHaveBeenCalled()
  const firstUpdatePreview = JSON.parse(updateResultMock.mock.calls[0][1].Preview.PreviewData)
  expect(firstUpdatePreview.items[0].icon.ImageType).toBe("lottie")
  expect(JSON.parse(firstUpdatePreview.items[0].icon.ImageData)).toMatchObject({
    v: expect.any(String),
    fr: expect.any(Number),
    layers: expect.any(Array)
  })

  const finalUpdatePreview = JSON.parse(updateResultMock.mock.calls[updateResultMock.mock.calls.length - 1][1].Preview.PreviewData)
  expect(updateResultMock.mock.calls[0][1].Preview.PreviewProperties).toEqual({
    文件: "2 文件",
    大小: "共 300 B"
  })
  expect(finalUpdatePreview.items[0].icon.ImageType).toBe("svg")
  expect(finalUpdatePreview.items[0].icon.ImageData).toContain("#22C55E")
  expect(finalUpdatePreview.items[0].tails).toEqual([{ Type: "text", Text: "-34%", TextCategory: "danger" }])
  expect(finalUpdatePreview.items[1].icon.ImageType).toBe("svg")
  expect(finalUpdatePreview.items[1].icon.ImageData).toContain("#22C55E")
  expect(finalUpdatePreview.items[1].tails).toEqual([{ Type: "text", Text: "-50%", TextCategory: "danger" }])
})

test("keeps zh_CN and en_US translation keys aligned", () => {
  expect(Object.keys(manifest.I18n.zh_CN).sort()).toEqual(Object.keys(manifest.I18n.en_US).sort())
})

test("passes compression settings to rimage", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wox-rimage-settings-test-"))
  const jpgPath = path.join(tempDir, "photo.jpg")
  fs.writeFileSync(jpgPath, "jpeg")

  const settings: Record<string, string> = {
    strip_metadata: "true",
    threads: "4",
    resize: "1000w",
    resize_policy: "downscale",
    jpeg_quality: "68"
  }

  await plugin.init({} as Context, {
    PluginDirectory: process.cwd(),
    API: {
      Log: async () => undefined,
      GetTranslation: async (_ctx: Context, key: string) => manifest.I18n.zh_CN[key] || key,
      GetSetting: async (_ctx: Context, key: string) => settings[key] || "",
      Notify: async () => undefined,
      ShowToolbarMsg: async () => undefined,
      ClearToolbarMsg: async () => undefined
    } as unknown as PublicAPI
  })

  spawnMock.mockImplementation(() => {
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    setImmediate(() => child.emit("close", 0))
    return child
  })

  const results = await plugin.query(
    {} as Context,
    createQuery({
      Type: "selection",
      Selection: { Type: "file", Text: "", FilePaths: [jpgPath] }
    })
  )
  const action = results[0].Actions?.[0] as {
    Action: (ctx: Context, actionContext: { ResultId: string; ResultActionId: string; ContextData: Record<string, string> }) => Promise<void>
    ContextData?: Record<string, string>
  }
  await action.Action({} as Context, {
    ResultId: "result",
    ResultActionId: "action",
    ContextData: action.ContextData || {}
  })

  expect(spawnMock).toHaveBeenCalledTimes(1)
  expect(spawnMock.mock.calls[0][1]).toEqual(["mozjpeg", "--quiet", "--no-progress", "-x", "-t", "4", "--resize", "1000w", "--downscale", "--no-upscale", "--quality", "68", jpgPath])
})

test("compresses sibling copies when replace original is disabled", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wox-rimage-copy-test-"))
  const jpgPath = path.join(tempDir, "photo.jpg")
  const compressedPath = path.join(tempDir, "compress_photo.jpg")
  fs.writeFileSync(jpgPath, "original jpeg")

  await plugin.init({} as Context, {
    PluginDirectory: process.cwd(),
    API: {
      Log: async () => undefined,
      GetTranslation: async (_ctx: Context, key: string) => manifest.I18n.zh_CN[key] || key,
      GetSetting: async (_ctx: Context, key: string) => (key === "replace_original" ? "false" : ""),
      Notify: async () => undefined,
      ShowToolbarMsg: async () => undefined,
      ClearToolbarMsg: async () => undefined
    } as unknown as PublicAPI
  })

  spawnMock.mockImplementation((_binaryPath: string, args: string[]) => {
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    setImmediate(() => {
      fs.writeFileSync(args[args.length - 1], "compressed jpeg")
      child.emit("close", 0)
    })
    return child
  })

  const results = await plugin.query(
    {} as Context,
    createQuery({
      Type: "selection",
      Selection: { Type: "file", Text: "", FilePaths: [jpgPath] }
    })
  )
  const action = results[0].Actions?.[0] as {
    Action: (ctx: Context, actionContext: { ResultId: string; ResultActionId: string; ContextData: Record<string, string> }) => Promise<void>
    ContextData?: Record<string, string>
  }
  await action.Action({} as Context, {
    ResultId: "result",
    ResultActionId: "action",
    ContextData: action.ContextData || {}
  })

  expect(results[0].Preview?.PreviewProperties).toMatchObject({
    文件: "1 文件",
    大小: "共 13 B"
  })
  expect(spawnMock.mock.calls[0][1][spawnMock.mock.calls[0][1].length - 1]).toBe(compressedPath)
  expect(fs.readFileSync(jpgPath, "utf-8")).toBe("original jpeg")
  expect(fs.readFileSync(compressedPath, "utf-8")).toBe("compressed jpeg")
})
