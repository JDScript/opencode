import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"

export const ServerInfo = Schema.Struct({
  version: Schema.String,
  // 0 means the runtime has no OS process identity (e.g. workerd).
  pid: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  urls: Schema.Array(Schema.String),
  paths: Schema.Struct({
    tmp: Schema.String,
  }),
}).annotate({ identifier: "ServerInfo" })
export type ServerInfo = typeof ServerInfo.Type

const Bytes = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

export const ServerStats = Schema.Struct({
  sampledAt: Schema.Number,
  process: Schema.Struct({
    pid: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    uptimeMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    // null when the runtime exposes no process memory accounting (e.g. workerd).
    memory: Schema.NullOr(
      Schema.Struct({
        rssBytes: Bytes,
        heapUsedBytes: Bytes,
        heapTotalBytes: Bytes,
        externalBytes: Bytes,
      }),
    ),
  }),
  // null when the database is not file-backed (in-memory or a remote SqlClient). A missing sidecar is 0.
  database: Schema.NullOr(
    Schema.Struct({
      path: Schema.String,
      mainBytes: Bytes,
      walBytes: Bytes,
      shmBytes: Bytes,
    }),
  ),
}).annotate({ identifier: "ServerStats" })
export type ServerStats = typeof ServerStats.Type

export const ServerGroup = HttpApiGroup.make("server.server")
  .add(
    HttpApiEndpoint.get("server.info", "/api/info", {
      success: ServerInfo,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "server.info",
        summary: "Get server info",
        description: "Return the server identity, connection URLs, paths, and readiness status.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("server.stats", "/api/experimental/server/stats", {
      success: ServerStats,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "experimental.server.stats",
        summary: "Get server resource usage",
        description:
          "Return the serving process's memory and the on-disk size of its database files. Process-wide; takes no location.",
      }),
    ),
  )
  .annotateMerge(OpenApi.annotations({ title: "server" }))
