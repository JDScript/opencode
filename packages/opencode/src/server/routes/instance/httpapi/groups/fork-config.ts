/**
 * FORK-ONLY FILE — not present upstream, so it never conflicts on rebase.
 *
 * Raw access to the *global* config file, plus its JSON Schema, so the web UI can offer a real
 * config editor. Three reasons this cannot reuse the existing config endpoints:
 *
 *  - `GET /config` returns the **merged effective** config (global file + project files + remote
 *    well-known config + env overrides). Round-tripping that through a save would freeze every
 *    inherited value into whichever file was written, silently detaching it from its real source.
 *  - `PATCH /config` and `PATCH /global/config` deep-merge, so they can add and overwrite keys but
 *    can never *delete* one. An editor needs whole-file replace semantics.
 *  - Both parse and re-serialize, discarding `.jsonc` comments and formatting.
 *
 * Registered in ../api.ts (RootHttpApi) and ../server.ts (rootApiRoutes) — one line each.
 */
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { described } from "./metadata"

const JsonObject = Schema.Record(Schema.String, Schema.Unknown)

const RawConfigFile = Schema.Struct({
  path: Schema.String,
  /** Verbatim file contents. Empty string when the file does not exist yet. */
  content: Schema.String,
  exists: Schema.Boolean,
})

const RawConfigWriteInput = Schema.Struct({
  content: Schema.String,
})

/**
 * Write outcome. Validation failures come back as `ok: false` with a displayable message rather than
 * an HTTP error, mirroring `GlobalUpgradeResult` upstream — the UI always has a message to show, and
 * a bad edit can never leave the file in a state the server cannot parse.
 */
const RawConfigWriteResult = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    path: Schema.String,
    content: Schema.String,
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    error: Schema.String,
  }),
])

/**
 * Dry-run validation, so the editor can show errors while typing without writing anything.
 *
 * This is a server round-trip rather than a client-side check on purpose: the file is `.jsonc`, so
 * `JSON.parse` cannot read it, and any regex that strips comments gets string literals containing
 * `//` wrong. Validating here reuses the real JSONC parser and the real schema decode, so the
 * editor's verdict can never disagree with what a save would do.
 */
const ValidationResult = Schema.Struct({
  ok: Schema.Boolean,
  error: Schema.optional(Schema.String),
})

export const ForkConfigPaths = {
  schema: "/fork/config/schema",
  raw: "/fork/config/raw",
  validate: "/fork/config/validate",
} as const

export const ForkConfigApi = HttpApi.make("fork-config").add(
  HttpApiGroup.make("forkConfig")
    .add(
      HttpApiEndpoint.get("schemaGet", ForkConfigPaths.schema, {
        success: described(JsonObject, "JSON Schema document for the opencode config file"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "fork.config.schema",
          summary: "Get config JSON Schema",
          description:
            "JSON Schema (draft 2020-12) generated from this server's own config schema, for editor validation and completion. Generated at request time, so it always matches the running build.",
        }),
      ),
      HttpApiEndpoint.get("rawGet", ForkConfigPaths.raw, {
        success: described(RawConfigFile, "Raw global config file"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "fork.config.raw.get",
          summary: "Read raw global config file",
          description:
            "Verbatim contents of the global config file, comments and formatting intact. Unlike GET /config this is one specific file, not the merged effective config.",
        }),
      ),
      HttpApiEndpoint.post("validate", ForkConfigPaths.validate, {
        payload: RawConfigWriteInput,
        success: described(ValidationResult, "Validation result"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "fork.config.validate",
          summary: "Validate config content without writing",
          description:
            "Runs the same JSONC parse and schema decode a save would run, and writes nothing. Lets an editor report errors while typing using the authoritative parser.",
        }),
      ),
      HttpApiEndpoint.put("rawPut", ForkConfigPaths.raw, {
        payload: RawConfigWriteInput,
        success: described(RawConfigWriteResult, "Write result"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "fork.config.raw.put",
          summary: "Replace raw global config file",
          description:
            "Whole-file replace, so keys can be removed. Content is parsed and validated against the config schema before anything is written; on failure nothing is touched. On success all instances are disposed so the new config takes effect without restarting the server.",
        }),
      ),
    )
    // Auth is mandatory: the global config can hold provider API keys, so these endpoints must never
    // be reachable unauthenticated. Declared on the group (same as EventApi) rather than inheriting
    // from RootHttpApi, because this API is mounted standalone — see the note below.
    .middleware(Authorization)
    .annotateMerge(
      OpenApi.annotations({
        title: "fork-config",
        description: "Fork-only raw global config file access.",
      }),
    ),
)

/**
 * Mounted as its own top-level API on `OpenCodeHttpApi` rather than added to `RootHttpApi`.
 *
 * Adding a group to `RootHttpApi` changes that API's requirement set, which breaks every upstream
 * test that builds `HttpApiBuilder.layer(RootHttpApi)` with a fixed handler list
 * (test/server/httpapi-global.test.ts, test/server/httpapi-control-plane.test.ts). Mounting
 * standalone — the same way EventApi and PtyConnectApi are — keeps those files untouched and costs
 * two lines instead of four.
 */
