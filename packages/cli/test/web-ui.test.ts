import { NodeFileSystem, NodeHttpServer } from "@effect/platform-node"
import { afterAll, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { HttpServer, HttpServerError, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { createServer } from "node:http"
import { createHash } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { WebUi } from "../src/services/web-ui"

const root = await mkdtemp(path.join(tmpdir(), "opencode-web-ui-"))
afterAll(() => rm(root, { recursive: true, force: true }))

describe("web UI", () => {
  test.each(["text", "bytes", "missing"])("isolates only the bundled preview shell (%s)", async (kind) => {
    const preload = "document.documentElement.dataset.theme = 'dark'"
    const index = `<html><script id="oc-theme-preload-script">${preload}</script><body>host</body></html>`
    const shell = "<html><base href='about:blank'><script>console.log('preview')</script></html>"
    const hostCsp =
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: blob:; font-src 'self' data:; media-src 'self' data:; connect-src * data: blob:"
    const indexCsp = hostCsp.replace(
      "'wasm-unsafe-eval'",
      `'wasm-unsafe-eval' 'sha256-${createHash("sha256").update(preload).digest("base64")}'`,
    )
    const previewCsp =
      "default-src 'none'; script-src http: https: data: blob: 'unsafe-inline' 'unsafe-eval'; style-src http: https: data: blob: 'unsafe-inline'; img-src http: https: data: blob:; media-src http: https: data: blob:; font-src http: https: data: blob:; connect-src http: https: data: blob:; base-uri about:; sandbox allow-scripts allow-forms allow-popups allow-downloads"
    const assets = {
      "index.html": index,
      "_assets/app.js": "hostScript()",
      "other.html": shell,
      "nested/preview-shell.html": shell,
      ...(kind === "missing"
        ? {}
        : { "preview-shell.html": kind === "text" ? shell : new TextEncoder().encode(shell) }),
    }
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const transform = yield* WebUi.handler({ assets })
          const http = yield* NodeHttpServer.make(createServer, { host: "127.0.0.1", port: 0 })
          yield* http.serve(
            transform(
              HttpServerRequest.HttpServerRequest.pipe(
                Effect.flatMap((request) =>
                  Effect.fail(
                    new HttpServerError.HttpServerError({ reason: new HttpServerError.RouteNotFound({ request }) }),
                  ),
                ),
              ),
            ),
          )
          const origin = HttpServer.formatAddress(http.address)
          yield* Effect.forEach(["/preview-shell.html", "/preview-shell.html?report=test"], (pathname) =>
            Effect.gen(function* () {
              const response = yield* Effect.promise(() => fetch(`${origin}${pathname}`))
              expect(response.status).toBe(kind === "missing" ? 404 : 200)
              expect(yield* Effect.promise(() => response.text())).toBe(kind === "missing" ? "" : shell)
              expect(response.headers.get("cache-control")).toBe(kind === "missing" ? "no-store" : "no-cache")
              expect(response.headers.get("content-security-policy")).toBe(kind === "missing" ? null : previewCsp)
              if (kind === "missing") return
              expect(response.headers.get("content-type")).toContain("text/html")
              expect(response.headers.get("x-content-type-options")).toBe("nosniff")
              expect(response.headers.get("referrer-policy")).toBe("no-referrer")
              expect(response.headers.get("content-security-policy")).not.toContain("allow-same-origin")
            }),
          )
          const head = yield* Effect.promise(() => fetch(`${origin}/preview-shell.html`, { method: "HEAD" }))
          expect(head.status).toBe(kind === "missing" ? 404 : 200)
          expect(yield* Effect.promise(() => head.text())).toBe("")
          expect(head.headers.get("content-security-policy")).toBe(kind === "missing" ? null : previewCsp)
          const post = yield* Effect.promise(() => fetch(`${origin}/preview-shell.html`, { method: "POST" }))
          expect(post.status).toBe(kind === "missing" ? 404 : 405)
          yield* Effect.forEach(
            [
              "/",
              "/index.html",
              "/workspace/example",
              "/preview-shell.html/missing",
              "/preview-shell.html.bak",
              "/missing.html",
              "/index.html?preview-shell.html",
            ],
            (pathname) =>
              Effect.gen(function* () {
                const response = yield* Effect.promise(() => fetch(`${origin}${pathname}`))
                expect(response.status).toBe(200)
                expect(yield* Effect.promise(() => response.text())).toBe(index)
                expect(response.headers.get("content-security-policy")).toBe(indexCsp)
                expect(response.headers.get("cache-control")).toBe("no-cache")
                expect(response.headers.get("referrer-policy")).toBeNull()
              }),
          )
          yield* Effect.forEach(["/_assets/app.js", "/other.html", "/nested/preview-shell.html"], (pathname) =>
            Effect.gen(function* () {
              const response = yield* Effect.promise(() => fetch(`${origin}${pathname}`))
              expect(response.status).toBe(200)
              expect(response.headers.get("content-security-policy")).toBe(hostCsp)
              expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
              expect(response.headers.get("referrer-policy")).toBeNull()
            }),
          )
        }),
      ).pipe(Effect.provide(NodeFileSystem.layer)),
    )
  })

  test("falls back from API routes to assets and the SPA index", async () => {
    const index = path.join(root, "index.html")
    const asset = path.join(root, "app.js")
    await writeFile(index, "<html><body>embedded</body></html>")
    await writeFile(asset, "console.log('embedded')")
    const assets = {
      "index.html": await Bun.file(index).text(),
      "_assets/app.js": await Bun.file(asset).text(),
      "sw.js": "service worker",
      "registerSW.js": "registration",
      "font.woff2": new Uint8Array([0, 1, 2, 255]),
    }

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const transform = yield* WebUi.handler({ assets })
          const http = yield* NodeHttpServer.make(createServer, { host: "127.0.0.1", port: 0 })
          yield* http.serve(
            transform(
              Effect.gen(function* () {
                const request = yield* HttpServerRequest.HttpServerRequest
                const pathname = new URL(request.url, "http://localhost").pathname
                if (pathname === "/api/info")
                  return HttpServerResponse.jsonUnsafe({
                    version: "test",
                    pid: 1,
                    urls: [origin],
                    paths: { tmp: "/tmp/opencode" },
                  })
                return yield* Effect.fail(
                  new HttpServerError.HttpServerError({
                    reason: new HttpServerError.RouteNotFound({ request }),
                  }),
                )
              }),
            ),
          )
          const origin = HttpServer.formatAddress(http.address)

          const status = yield* Effect.promise(() => fetch(`${origin}/api/info`))
          expect(yield* Effect.promise(() => status.json())).toEqual({
            version: "test",
            pid: 1,
            urls: [origin],
            paths: { tmp: "/tmp/opencode" },
          })

          const missing = yield* Effect.promise(() => fetch(`${origin}/api/missing`))
          expect(missing.status).toBe(404)
          expect(yield* Effect.promise(() => missing.text())).toBe("")

          yield* Effect.forEach(["/_assets/old.js", "/_assets/old.css", "/_assets/missing"], (pathname) =>
            Effect.gen(function* () {
              const missing = yield* Effect.promise(() => fetch(`${origin}${pathname}`))
              expect(missing.status).toBe(404)
              expect(missing.headers.get("cache-control")).toBe("no-store")
              expect(yield* Effect.promise(() => missing.text())).toBe("")
            }),
          )

          const script = yield* Effect.promise(() => fetch(`${origin}/_assets/app.js`))
          expect(yield* Effect.promise(() => script.text())).toBe("console.log('embedded')")
          expect(script.headers.get("content-type")).toContain("javascript")
          expect(script.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")

          const worker = yield* Effect.promise(() => fetch(`${origin}/sw.js`))
          expect(worker.headers.get("cache-control")).toBe("no-cache")

          const registration = yield* Effect.promise(() => fetch(`${origin}/registerSW.js`))
          expect(registration.headers.get("cache-control")).toBe("no-cache")

          const font = yield* Effect.promise(() => fetch(`${origin}/font.woff2`))
          expect(font.headers.get("content-type")).toBe("font/woff2")
          expect(new Uint8Array(yield* Effect.promise(() => font.arrayBuffer()))).toEqual(
            new Uint8Array([0, 1, 2, 255]),
          )

          const fallback = yield* Effect.promise(() => fetch(`${origin}/workspace/example`))
          expect(yield* Effect.promise(() => fallback.text())).toContain("embedded")
          expect(fallback.headers.get("content-security-policy")).toContain("default-src 'self'")
          expect(fallback.headers.get("content-security-policy")).toContain("connect-src * data: blob:")

          const dotted = yield* Effect.promise(() => fetch(`${origin}/workspace/example.js`))
          expect(dotted.status).toBe(200)
          expect(yield* Effect.promise(() => dotted.text())).toContain("embedded")

          const legacy = yield* Effect.promise(() => fetch(`${origin}/assets/missing.js`))
          expect(legacy.status).toBe(200)
          expect(yield* Effect.promise(() => legacy.text())).toContain("embedded")
        }),
      ).pipe(Effect.provide(NodeFileSystem.layer)),
    )
  })
})
