/**
 * FORK-ONLY FILE — not present upstream, so it never conflicts on rebase.
 *
 * Handlers for ../groups/fork-config.ts. See that file for why raw file access is needed instead of
 * the existing config endpoints.
 */
import { Config } from "@/config/config"
import { EffectBridge } from "@/effect/bridge"
import { disposeAllInstancesAndEmitGlobalDisposed } from "@/server/global-lifecycle"
import { ConfigParse } from "@/config/parse"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect, Schema } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser"
import { ForkConfigApi } from "../groups/fork-config"

const DIALECT_URI: Record<string, string> = {
  "draft-2020-12": "https://json-schema.org/draft/2020-12/schema",
  "draft-07": "http://json-schema.org/draft-07/schema#",
}

let schemaCache: Record<string, unknown> | undefined

/**
 * The config schema as a JSON Schema document an editor can consume directly.
 *
 * `Schema.toJsonSchemaDocument` returns `{ dialect, schema, definitions }` where `schema` is only a
 * root `$ref` (`#/$defs/Config`) and every ref is `#/$defs/...` — so definitions must be published
 * under `$defs`, not `definitions`, or nothing resolves.
 *
 * Cached: generation walks 19 definitions and the settings dialog would otherwise pay for it on
 * every open. The result only depends on the compiled schema, so it can never go stale at runtime.
 */
function configJsonSchema(): Record<string, unknown> {
  if (schemaCache) return schemaCache
  const doc = Schema.toJsonSchemaDocument(ConfigV1.Info) as {
    dialect?: string
    schema: Record<string, unknown>
    definitions?: Record<string, unknown>
  }
  const dialect = doc.dialect ? DIALECT_URI[doc.dialect] : undefined
  schemaCache = {
    ...(dialect ? { $schema: dialect } : {}),
    ...doc.schema,
    $defs: doc.definitions ?? {},
  }
  return schemaCache
}

function jsoncSyntaxErrors(content: string): string | undefined {
  const errors: ParseError[] = []
  parseJsonc(content, errors, { allowTrailingComma: true })
  if (!errors.length) return undefined
  return errors
    .slice(0, 5)
    .map((e) => {
      const before = content.slice(0, e.offset).split("\n")
      const line = before.length
      const column = (before[before.length - 1]?.length ?? 0) + 1
      return `${printParseErrorCode(e.error)} at line ${line}, column ${column}`
    })
    .join("\n")
}

type NamedErrorData = {
  message?: string
  issues?: ReadonlyArray<{ message?: string; path?: ReadonlyArray<string> }>
}

/**
 * Renders a config error into something a user can act on.
 *
 * `ConfigParse` throws `NamedError` subclasses, which put every field on `error.data` and pass only the
 * error *name* to `super()`. So `error.message` is the bare string "ConfigInvalidError" — reading it
 * tells the user nothing about which key is wrong. The useful content is `data.issues`.
 */
function describeConfigError(error: unknown): string {
  const data = (error as { data?: NamedErrorData }).data
  const issues = data?.issues

  if (Array.isArray(issues) && issues.length) {
    return issues
      .slice(0, 10)
      .map((issue) => {
        const at = issue.path?.length ? issue.path.join(".") : "(root)"
        return `${at}: ${issue.message ?? "invalid"}`
      })
      .join("\n")
  }

  if (data?.message) return data.message
  if (error instanceof Error && error.message) return error.message
  return String(error)
}

/**
 * Rejects anything the config loader itself would choke on.
 *
 * This matters because a broken global config file is not a local failure: `loadInstanceState` pipes
 * both the JSONC parse and the schema decode through `Effect.orDie`, so a bad file makes *every*
 * directory fail to bootstrap. For a server reached only through its web UI, that is unrecoverable
 * without shell access — exactly the situation an in-browser config editor could otherwise create.
 *
 * Deliberately no stricter than the loader: `ConfigParse.schema` decodes with
 * `onExcessProperty: "ignore"`, so unknown keys pass here too.
 */
function validate(content: string, file: string): { ok: true } | { ok: false; error: string } {
  // An empty file means "no global overrides" and is what the loader sees before one is written.
  if (content.trim() === "") return { ok: true }

  const syntax = jsoncSyntaxErrors(content)
  if (syntax) return { ok: false, error: syntax }

  let parsed: unknown
  try {
    parsed = ConfigParse.jsonc(content, file)
  } catch (error) {
    return { ok: false, error: describeConfigError(error) }
  }

  try {
    ConfigParse.schema(ConfigV1.Info, parsed, file)
  } catch (error) {
    return { ok: false, error: describeConfigError(error) }
  }

  return { ok: true }
}

export const forkConfigHandlers = HttpApiBuilder.group(ForkConfigApi, "forkConfig", (handlers) =>
  Effect.gen(function* () {
    const config = yield* Config.Service
    const fs = yield* FSUtil.Service
    const bridge = yield* EffectBridge.make()

    const schemaGet = Effect.fn("ForkConfigHttpApi.schemaGet")(function* () {
      return configJsonSchema()
    })

    const rawGet = Effect.fn("ForkConfigHttpApi.rawGet")(function* () {
      const file = Config.globalConfigFile()
      const content = yield* fs.readFileStringSafe(file).pipe(Effect.orDie)
      return { path: file, content: content ?? "", exists: content !== undefined }
    })

    const validateOnly = Effect.fn("ForkConfigHttpApi.validate")(function* (ctx: { payload: { content: string } }) {
      const check = validate(ctx.payload.content, Config.globalConfigFile())
      return check.ok ? { ok: true } : { ok: false, error: check.error }
    })

    const rawPut = Effect.fn("ForkConfigHttpApi.rawPut")(function* (ctx: { payload: { content: string } }) {
      const file = Config.globalConfigFile()
      const check = validate(ctx.payload.content, file)
      if (!check.ok) return { ok: false as const, error: check.error }

      yield* fs.writeFileString(file, ctx.payload.content).pipe(Effect.orDie)
      yield* config.invalidate()
      // Same mechanism PATCH /global/config uses: drop every instance so the next request rebuilds
      // against the new config. Forked because callers should not wait on teardown.
      bridge.fork(disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true }))

      return { ok: true as const, path: file, content: ctx.payload.content }
    })

    return handlers
      .handle("schemaGet", schemaGet)
      .handle("rawGet", rawGet)
      .handle("validate", validateOnly)
      .handle("rawPut", rawPut)
  }),
)
