import { Database } from "@opencode/core/database/database"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { stat } from "node:fs/promises"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { ServerInfo } from "../server-info"

export const ServerHandler = HttpApiBuilder.group(Api, "server.server", (handlers) =>
  handlers
    .handle("server.info", () =>
      Effect.gen(function* () {
        const info = yield* ServerInfo.Service
        return {
          version: info.app.version ?? "unknown",
          pid: process.pid ?? 0,
          urls: info.urls(),
          paths: info.paths,
        }
      }),
    )
    .handle("server.stats", () =>
      Effect.gen(function* () {
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
      }),
    ),
)
