import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { brotliDecompressSync } from "node:zlib"
import { buildAppArchive } from "../script/app-assets"
import { AppArchive } from "../src/app-archive"

test("prebuilt UI assets use the runtime's binary archive format", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "opencode-ui-archive-"))
  const previous = process.env.OPENCODE_WEB_UI_DIST
  process.env.OPENCODE_WEB_UI_DIST = dir
  try {
    await Bun.write(path.join(dir, "index.html"), "<html>prebuilt</html>")
    await Bun.write(path.join(dir, "assets/app.js"), "console.log('prebuilt')")
    await Bun.write(path.join(dir, "assets/app.js.map"), "{}")

    const assets = AppArchive.decode(await buildAppArchive("latest"))
    expect(Object.keys(assets)).toEqual(["assets/app.js", "index.html"])
    expect(brotliDecompressSync(assets["index.html"]!).toString()).toBe("<html>prebuilt</html>")
    expect(brotliDecompressSync(assets["assets/app.js"]!).toString()).toBe("console.log('prebuilt')")
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_WEB_UI_DIST
    else process.env.OPENCODE_WEB_UI_DIST = previous
    await rm(dir, { recursive: true, force: true })
  }
})

test("skipping the UI produces a valid empty binary archive", async () => {
  expect(AppArchive.decode(await buildAppArchive("latest", { skipBuild: true }))).toEqual({})
})
