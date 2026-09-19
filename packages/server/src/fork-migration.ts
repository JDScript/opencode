/**
 * FORK-ONLY FILE — not present upstream, so it never conflicts on rebase.
 *
 * The V1 → V2 session-history migration, gated on the user instead of run on first start.
 *
 * Upstream forks `V1Migration.layer` into the server on startup, so a V2 build opening a V1 database
 * migrates it before the user sees anything: the `event` table is cleared, V1 sessions are copied into
 * `session_v2`/`session_message`, and from then on V1 tables are never read again. That is irreversible
 * and, on a real database, took 70 s and freed nothing until a VACUUM. This fork removes the startup
 * fork (routes.ts) and offers it here instead:
 *
 *   GET  /api/fork/migration/v1   what would happen: legacy row counts, database size, backup destination
 *   POST /api/fork/migration/v1   acknowledge: back up, migrate, VACUUM — in that order, in the background
 *
 * Upstream's `GET /api/experimental/migration/v1` keeps reporting `required` until the user acknowledges;
 * its TUI overlay shows nothing for that state, so the TUI simply has no history until then.
 *
 * The backup is `VACUUM INTO`, not a file copy: it is a consistent snapshot regardless of WAL state and
 * of concurrent writes, and it needs no filesystem support. It costs a full write of the live data (about
 * as long as the migration itself) and the same disk space again; the pre-flight GET reports both so the
 * client can say so before the user clicks.
 *
 * VACUUM afterwards is what actually returns the space: the migration deletes the multi-gigabyte `event`
 * log but SQLite keeps the pages. Measured 9.4 GB → 2.3 GB in 36 s. A failed VACUUM is recorded, not
 * fatal — the migrated data is already correct.
 */
import { Database } from "@opencode/core/database/database"
import { V1Migration } from "@opencode/core/database/v1-migration"
import { KVTable } from "@opencode/core/kv/sql"
import { Global } from "@opencode/util/global"
import { Authorization } from "@opencode/protocol/middleware/authorization"
import { V1MigrationStatus } from "@opencode/protocol/groups/migration"
import { eq, sql } from "drizzle-orm"
import { Cause, Effect, Layer, Option, Schema } from "effect"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import path from "node:path"

const Bytes = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

const Backup = Schema.Struct({ path: Schema.String, bytes: Bytes, time: Schema.Number })
const Vacuum = Schema.Struct({ before: Bytes, after: Bytes, time: Schema.Number })

/** Persisted beside upstream's own `migration.v1-v2` key so the record survives restarts. */
const Record = Schema.Struct({
  backup: Schema.optional(Backup),
  vacuum: Schema.optional(Vacuum),
  error: Schema.optional(Schema.String),
})

const Report = Schema.Struct({
  /** Upstream's status, unchanged: `required` until acknowledged, then `running` → `completed`. */
  status: V1MigrationStatus,
  /** The fork's own phase, which upstream's status does not cover. */
  phase: Schema.Literals(["idle", "backup", "migrating", "vacuum", "done", "error"]),
  database: Schema.Struct({ path: Schema.String, bytes: Bytes }),
  legacy: Schema.Struct({ sessions: Bytes, messages: Bytes, parts: Bytes, events: Bytes }),
  /** Where the backup will be (or was) written. Same directory as the database, so same disk. */
  backupPath: Schema.String,
  ...Record.fields,
})

const Start = Schema.Struct({
  /** Defaults to true. Only the client that told the user what it means should turn it off. */
  backup: Schema.optional(Schema.Boolean),
})

export const ForkMigrationGroup = HttpApiGroup.make("fork.migration")
  .add(
    HttpApiEndpoint.get("fork.migration.v1.report", "/api/fork/migration/v1", { success: Report }).annotateMerge(
      OpenApi.annotations({
        summary: "Describe the pending V1 migration",
        description: "Legacy row counts, database size and backup destination, so a client can ask before starting.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("fork.migration.v1.start", "/api/fork/migration/v1", {
      payload: Start,
      success: Report,
    }).annotateMerge(
      OpenApi.annotations({
        summary: "Acknowledge and start the V1 migration",
        description: "Backs the database up, migrates V1 history into V2, then VACUUMs. Runs in the background.",
      }),
    ),
  )
  .annotateMerge(OpenApi.annotations({ title: "fork.migration" }))

export const ForkApi = HttpApi.make("fork").add(ForkMigrationGroup).middleware(Authorization)

const KEY = "fork.migration.v1"

// Process-local like upstream's `runtimeState`; the durable part is in the kv row.
let phase: typeof Report.Type.phase = "idle"
// One stamp per process, so the pre-flight GET names the same file the POST will write.
const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)

export const forkMigrationHandlers = HttpApiBuilder.group(ForkApi, "fork.migration", (handlers) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const global = yield* Global.Service
    const db = database.db
    // Core's migration effects name their services; bind them here so the request needs nothing extra.
    const provide = <A, E>(effect: Effect.Effect<A, E, Database.Service | Global.Service>) =>
      effect.pipe(Effect.provideService(Database.Service, database), Effect.provideService(Global.Service, global))

    const size = (file: string) =>
      Effect.promise(() => Bun.file(file).stat()).pipe(
        Effect.map((info) => info.size),
        Effect.orElseSucceed(() => 0),
      )

    const count = (table: string) =>
      db.get<{ value: number }>(sql`SELECT COUNT(*) AS value FROM ${sql.identifier(table)}`).pipe(
        Effect.map((row) => row?.value ?? 0),
        Effect.orElseSucceed(() => 0),
      )

    const record = () =>
      db
        .select({ value: KVTable.value })
        .from(KVTable)
        .where(eq(KVTable.key, KEY))
        .get()
        .pipe(
          Effect.map((row) =>
            Option.getOrElse(Schema.decodeUnknownOption(Record)(row?.value ?? {}), (): typeof Record.Type => ({})),
          ),
          Effect.orDie,
        )

    const remember = (value: typeof Record.Type) =>
      db
        .insert(KVTable)
        .values({ key: KEY, value })
        .onConflictDoUpdate({ target: KVTable.key, set: { value, time_updated: Date.now() } })
        .run()
        .pipe(Effect.orDie)

    const report = Effect.fn("ForkMigration.report")(function* () {
      const file = (yield* db
        .get<{ file: string }>(sql`SELECT file FROM pragma_database_list WHERE name = 'main'`)
        .pipe(Effect.orDie))?.file
      if (!file) return yield* Effect.die(new Error("database has no file (in-memory?)"))
      const status = yield* provide(V1Migration.status())
      const legacy =
        status.status === "required" || phase !== "idle"
          ? {
              sessions: yield* count("session"),
              messages: yield* count("message"),
              parts: yield* count("part"),
              events: yield* count("event"),
            }
          : { sessions: 0, messages: 0, parts: 0, events: 0 }
      const saved = yield* record()
      return {
        status,
        phase: phase === "idle" && status.status === "completed" && saved.backup ? ("done" as const) : phase,
        database: { path: file, bytes: yield* size(file) },
        legacy,
        backupPath: saved.backup?.path ?? backupPath(file),
        ...saved,
      }
    })

    const run = (input: { backup: boolean; file: string }) =>
      Effect.gen(function* () {
        let state: typeof Record.Type = { ...(yield* record()), error: undefined }
        if (input.backup) {
          phase = "backup"
          const target = backupPath(input.file)
          yield* db.run(sql`VACUUM INTO ${target}`)
          state = { ...state, backup: { path: target, bytes: yield* size(target), time: Date.now() } }
          yield* remember(state)
        }
        phase = "migrating"
        yield* provide(V1Migration.start)
        const status = yield* provide(V1Migration.status())
        if (status.status === "error") return yield* Effect.fail(new Error(status.error))
        phase = "vacuum"
        const before = yield* size(input.file)
        yield* db.run(sql`VACUUM`).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              state = { ...state, vacuum: { before, after: yield* size(input.file), time: Date.now() } }
            }),
          ),
          Effect.catch((cause) =>
            Effect.logWarning("fork migration: VACUUM failed; data is migrated, space not reclaimed", cause),
          ),
        )
        yield* remember(state)
        phase = "done"
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            phase = "error"
            yield* Effect.logError("fork migration failed", { cause })
            yield* remember({ ...(yield* record()), error: String(Cause.squash(cause)) })
          }),
        ),
      )

    const start = Effect.fn("ForkMigration.start")(function* (ctx: { payload: typeof Start.Type }) {
      const current = yield* report()
      if (current.status.status === "required" && phase === "idle") {
        yield* run({ backup: ctx.payload.backup ?? true, file: current.database.path }).pipe(Effect.forkDetach)
        // Let the forked effect set its first phase before the client reads it back.
        yield* Effect.yieldNow
        return yield* report()
      }
      // Already running, done, or nothing to migrate: idempotent.
      return current
    })

    return handlers.handle("fork.migration.v1.report", report).handle("fork.migration.v1.start", start)
  }),
)

function backupPath(file: string) {
  const parsed = path.parse(file)
  return path.join(parsed.dir, `${parsed.name}.v1-backup-${stamp}.db`)
}

export const forkMigrationApiLayer = HttpApiBuilder.layer(ForkApi).pipe(Layer.provide(forkMigrationHandlers))
