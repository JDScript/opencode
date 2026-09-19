import { Database } from "@opencode/core/database/database" // FORK
import { sql } from "drizzle-orm" // FORK
import { stat } from "node:fs/promises" // FORK
import { Duration, Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { PersistentPty } from "@opencode/core/persistent-pty"
import { UnauthorizedError } from "@opencode/protocol/errors"
import { Api } from "../api"
import { ServerAuth } from "../auth"
import { ServerInfo } from "../server-info"
import { ServerPairing } from "../pairing"

// FORK: process memory and database file sizes for GET /api/experimental/server/stats.
const stats = Effect.gen(function* () {
  const database = yield* Database.Service
  // The file behind the serving handle, so this never opens a second database or guesses a path.
  // Empty for :memory: and for SqlClient-backed deployments, which have no on-disk size to report.
  const file = yield* database.db
    .get<{ file: string }>(sql`SELECT file FROM pragma_database_list WHERE name = 'main'`)
    .pipe(
      Effect.map((row) => row?.file || undefined),
      Effect.orElseSucceed(() => undefined),
    )
  // node:fs directly: the handler layer has no FileSystem service, and a missing sidecar is simply 0.
  const size = (path: string) =>
    Effect.promise(() => stat(path).then((info) => info.size)).pipe(Effect.orElseSucceed(() => 0))
  const memory = typeof process.memoryUsage === "function" ? process.memoryUsage() : undefined
  return {
    sampledAt: Date.now(),
    process: {
      pid: process.pid ?? 0,
      uptimeMs: Math.round((typeof process.uptime === "function" ? process.uptime() : 0) * 1000),
      memory: memory
        ? {
            rssBytes: memory.rss,
            heapUsedBytes: memory.heapUsed,
            heapTotalBytes: memory.heapTotal,
            externalBytes: memory.external,
          }
        : null,
    },
    database: file
      ? {
          path: file,
          mainBytes: yield* size(file),
          walBytes: yield* size(`${file}-wal`),
          shmBytes: yield* size(`${file}-shm`),
        }
      : null,
  }
})

export const ServerHandler = HttpApiBuilder.group(Api, "server.server", (handlers) =>
  Effect.gen(function* () {
    const pairing = yield* ServerPairing.Service
    const auth = yield* ServerAuth.Config

    return handlers
      .handle("server.info", () =>
        Effect.gen(function* () {
          const info = yield* ServerInfo.Service
          return {
            version: info.app.version ?? "unknown",
            pid: process.pid ?? 0,
            urls: info.urls(),
            paths: info.paths,
            capabilities: { persistentPty: PersistentPty.available },
          }
        }),
      )
      .handle("server.pair", () => pairing.issue())
      .handle(
        "server.connect",
        Effect.fn(function* (ctx) {
          const request = yield* HttpServerRequest.HttpServerRequest
          // Browser navigations ask for HTML; everything else is an API client that wants the token.
          const browser = request.headers.accept?.includes("text/html") === true
          const token = (yield* pairing.consume(ctx.params.code)) ? ServerAuth.issueSession(auth) : undefined
          if (token === undefined) {
            if (!browser) return yield* new UnauthorizedError({ message: "Pairing link expired or already used" })
            return HttpServerResponse.text(
              "This pairing link expired or was already used. Run `opencode pair` to get a new one.",
              { status: 401 },
            )
          }
          if (!browser) return { token }
          return HttpServerResponse.redirect("/").pipe(
            HttpServerResponse.setCookieUnsafe(ServerAuth.sessionCookieName(request.headers.host), token, {
              path: "/",
              httpOnly: true,
              sameSite: "lax",
              maxAge: Duration.seconds(ServerAuth.SESSION_TTL_SECONDS),
            }),
          )
        }),
      )
      .handle("server.stats", () => stats) // FORK
  }),
)
