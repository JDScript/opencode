/**
 * FORK-ONLY FILE — not present upstream, so it never conflicts on rebase.
 *
 * Runs OpenCode v1 plugins (`@opencode-ai/plugin` shape) on the v2 host. A v1 plugin is a factory,
 * `async (input, options) => Hooks`, exported as default, as `default.server`, or as named exports; v2
 * wants `{ id, setup }`. This wraps the factory in a v2 definition and translates each v1 hook into the
 * v2 domain hook that means the same thing, so a user who already has v1 plugins configured keeps them
 * working after upgrading to this fork's v2 build. Upstream documents the migration
 * (opencode.ai/v2/docs/build/plugins/migrate-v1) but offers no runtime compatibility.
 *
 * What maps, and how:
 *
 *   config(cfg)                          → cfg.mcp diff applied through ctx.mcp.transform
 *   event({event})                       → ctx.event.subscribe(), v2 events translated to v1 envelopes
 *   chat.message(input, {message,parts}) → session.hook("prompt"): text parts joined back into prompt.text
 *   experimental.chat.system.transform   → session.hook("context"): strings pushed as system parts
 *   experimental.session.compacting      → session.hook("compaction"): output.context pushed as system parts
 *   tool.execute.before / after          → tool.hook("execute.before" / "execute.after")
 *   permission.ask                       → permission.hook("evaluate")
 *   shell.env                            → shell.hook("create.before")
 *   chat.headers                         → session.hook("model.request")
 *   dispose                              → setup's cleanup
 *
 * Not mapped, with a warning at load: `tool` (custom tools: v1 uses zod schemas, v2 Effect schemas),
 * `auth`, `provider`, `chat.params`, `command.execute.before`, `experimental.chat.messages.transform`,
 * `experimental.compaction.autocontinue`, `experimental.text.complete`, `experimental.provider.small_model`.
 *
 * The v1 `client` (an HTTP SDK) has no in-process counterpart; the shim answers `tui.showToast` and
 * `app.log` by logging and every other call with `{ data: undefined }` after one warning, so a plugin
 * that reaches for it degrades instead of crashing.
 *
 * Event translation is the substantive part. v2 has no `message.*` events; v1 `message.updated` and
 * `message.part.updated` are synthesised from `session.inbox.enqueued` (user text), `session.step.*`
 * (assistant message), `session.text.ended` / `session.reasoning.ended` (parts) and `session.tool.*`
 * (tool parts, with the name remembered from `session.tool.input.started`). `session.idle` comes from
 * `session.execution.succeeded|interrupted`, `session.error` from `session.execution.failed`,
 * `session.compacted` from `session.compaction.ended`. Untranslated v2 events are forwarded as-is with
 * `properties = data`, so a plugin already aware of v2 names sees them too.
 */
import type { Context, Plugin } from "@opencode/plugin/promise/plugin"
import type { Mcp } from "@opencode/schema/mcp"
import type { Tool } from "@opencode/schema/tool"

type Hook = (...args: any[]) => Promise<unknown> | unknown
type Hooks = Record<string, unknown>
type Factory = (input: Record<string, unknown>, options?: Record<string, unknown>) => Promise<Hooks> | Hooks

/** The factories a v1 module exposes, or undefined when the module is not v1-shaped. */
export function detect(module: unknown): ReadonlyArray<Factory> | undefined {
  if (typeof module !== "object" || module === null) return undefined
  const record = module as Record<string, unknown>
  const main = record.default
  if (typeof main === "function") return [main as Factory]
  if (typeof main === "object" && main !== null && typeof (main as { server?: unknown }).server === "function")
    return [(main as { server: Factory }).server]
  const named = Object.entries(record)
    .filter(([key, value]) => key !== "default" && typeof value === "function")
    .map(([, value]) => value as Factory)
  return named.length ? named : undefined
}

export function fromLegacy(id: string, factories: ReadonlyArray<Factory>): Plugin {
  return {
    id,
    setup: async (ctx) => {
      const warned = new Set<string>()
      const warn = (key: string, message: string) => {
        if (warned.has(key)) return
        warned.add(key)
        console.warn(`[plugin ${id}] ${message}`)
      }
      const input = {
        client: legacyClient(id, warn),
        project: {
          id: ctx.location.project.id,
          worktree: ctx.location.project.directory,
          vcs: undefined,
          time: { created: 0, updated: 0 },
        },
        directory: ctx.location.directory,
        worktree: ctx.location.project.directory,
        serverUrl: new URL("http://127.0.0.1"),
        $: Bun.$,
        experimental_workspace: { register: () => undefined },
      }
      const all = await Promise.all(factories.map((factory) => Promise.resolve(factory(input, ctx.options))))
      const hooks: Hooks = Object.assign({}, ...all)
      const cleanups: Array<() => Promise<unknown> | unknown> = []
      const fn = (name: string) => (typeof hooks[name] === "function" ? (hooks[name] as Hook) : undefined)
      const guard =
        (name: string, run: (...args: any[]) => Promise<unknown>) =>
        async (...args: any[]) => {
          try {
            await run(...args)
          } catch (error) {
            warn(`hook:${name}`, `v1 hook ${name} failed: ${error instanceof Error ? error.message : String(error)}`)
          }
        }

      for (const name of Object.keys(hooks))
        if (!SUPPORTED.has(name))
          warn(`unsupported:${name}`, `v1 hook ${name} is not supported by the v2 adapter and was ignored`)

      const config = fn("config")
      if (config) await applyConfig(ctx, config)

      const event = fn("event")
      if (event) {
        const controller = new AbortController()
        cleanups.push(() => controller.abort())
        const translate = eventTranslator(ctx)
        void (async () => {
          try {
            for await (const item of ctx.event.subscribe({ signal: controller.signal })) {
              for (const legacy of translate(item))
                await guard("event", () => Promise.resolve(event({ event: legacy })))()
            }
          } catch (error) {
            if (!controller.signal.aborted)
              warn("event:stream", `event stream ended: ${error instanceof Error ? error.message : String(error)}`)
          }
        })()
      }

      const message = fn("chat.message")
      if (message)
        cleanups.push(
          (
            await ctx.session.hook(
              "prompt",
              guard("chat.message", async (e) => {
                const parts: Array<Record<string, unknown>> = [
                  {
                    id: `${e.messageID}:text`,
                    messageID: e.messageID,
                    sessionID: e.sessionID,
                    type: "text",
                    text: e.prompt.text,
                  },
                ]
                const output = {
                  message: { id: e.messageID, sessionID: e.sessionID, role: "user", time: { created: Date.now() } },
                  parts,
                }
                await message({ sessionID: e.sessionID, messageID: e.messageID }, output)
                e.prompt.text = output.parts
                  .filter((part) => part.type === "text" && typeof part.text === "string")
                  .map((part) => part.text as string)
                  .join("\n\n")
              }),
            )
          ).dispose,
        )

      const system = fn("experimental.chat.system.transform")
      if (system)
        cleanups.push(
          (
            await ctx.session.hook(
              "context",
              guard("experimental.chat.system.transform", async (e) => {
                const output = { system: [] as string[] }
                await system({ sessionID: e.sessionID, model: e.model }, output)
                for (const text of output.system) e.system.push({ type: "text", text })
              }),
            )
          ).dispose,
        )

      const compacting = fn("experimental.session.compacting")
      if (compacting)
        cleanups.push(
          (
            await ctx.session.hook(
              "compaction",
              guard("experimental.session.compacting", async (e) => {
                const output = { context: [] as string[], prompt: undefined as string | undefined }
                await compacting({ sessionID: e.sessionID }, output)
                for (const text of output.context) e.system.push({ type: "text", text })
              }),
            )
          ).dispose,
        )

      const before = fn("tool.execute.before")
      if (before)
        cleanups.push(
          (
            await ctx.tool.hook(
              "execute.before",
              guard("tool.execute.before", async (e) => {
                const output = { args: e.input }
                await before({ tool: e.tool, sessionID: e.sessionID, callID: e.id }, output)
                e.input = output.args
              }),
            )
          ).dispose,
        )

      const after = fn("tool.execute.after")
      if (after)
        cleanups.push(
          (
            await ctx.tool.hook(
              "execute.after",
              guard("tool.execute.after", async (e) => {
                if (e.status !== "completed") return
                const content = e.result.content
                const text =
                  typeof content === "string"
                    ? content
                    : (content ?? [])
                        .flatMap((item: Tool.Content) => (item.type === "text" ? [item.text] : []))
                        .join("\n")
                const output = { title: e.tool, output: text, metadata: { ...(e.result.metadata ?? {}) } }
                await after({ tool: e.tool, sessionID: e.sessionID, callID: e.id, args: e.input }, output)
                if (output.output !== text || output.metadata !== e.result.metadata)
                  e.result = { ...e.result, content: output.output, metadata: output.metadata }
              }),
            )
          ).dispose,
        )

      const permission = fn("permission.ask")
      if (permission)
        cleanups.push(
          (
            await ctx.permission.hook(
              "evaluate",
              guard("permission.ask", async (e) => {
                const output = { status: e.effect as "ask" | "deny" | "allow" }
                await permission(
                  {
                    id: "",
                    type: e.action,
                    pattern: e.resources,
                    sessionID: e.sessionID,
                    metadata: e.metadata ?? {},
                    time: { created: Date.now() },
                  },
                  output,
                )
                e.effect = output.status
              }),
            )
          ).dispose,
        )

      const shell = fn("shell.env")
      if (shell)
        cleanups.push(
          (
            await ctx.shell.hook(
              "create.before",
              guard("shell.env", async (e) => {
                const output = { env: { ...e.env } as Record<string, string> }
                await shell({ cwd: e.cwd }, output)
                e.env = output.env
              }),
            )
          ).dispose,
        )

      const headers = fn("chat.headers")
      if (headers)
        cleanups.push(
          (
            await ctx.session.hook(
              "model.request",
              guard("chat.headers", async (e) => {
                const output = { headers: { ...e.headers } }
                await headers({ sessionID: e.sessionID, model: e.model }, output)
                e.headers = output.headers
              }),
            )
          ).dispose,
        )

      const dispose = fn("dispose")
      return async () => {
        for (const cleanup of cleanups.reverse()) await Promise.resolve(cleanup()).catch(() => undefined)
        if (dispose) await Promise.resolve(dispose()).catch(() => undefined)
      }
    },
  }
}

const SUPPORTED = new Set([
  "config",
  "event",
  "chat.message",
  "chat.headers",
  "experimental.chat.system.transform",
  "experimental.session.compacting",
  "tool.execute.before",
  "tool.execute.after",
  "permission.ask",
  "shell.env",
  "dispose",
])

/**
 * v1 `config(cfg)` mutated the whole config object; only `cfg.mcp` had a consumer worth carrying. The
 * plugin sees the current servers in v1 shape, and whatever it adds or changes is written back through
 * the v2 editor, translating `enabled` → `disabled` and the flat `timeout` into v2's split one.
 */
async function applyConfig(ctx: Context, config: Hook) {
  const current: Record<string, unknown> = {}
  await ctx.mcp.transform((editor) => {
    for (const [name, server] of editor.list()) current[name] = toLegacyMcp(server)
  })
  const cfg: Record<string, unknown> = { mcp: { ...current }, plugin: [] }
  await config(cfg)
  const next = (cfg.mcp ?? {}) as Record<string, unknown>
  const changed = Object.entries(next).filter(
    ([name, value]) => JSON.stringify(value) !== JSON.stringify(current[name]),
  )
  if (!changed.length) return
  await ctx.mcp.transform((editor) => {
    for (const [name, value] of changed) {
      const server = fromLegacyMcp(value)
      if (server) editor.set(name, server)
    }
  })
}

function toLegacyMcp(server: Mcp.ServerConfig): Record<string, unknown> {
  const { disabled, timeout, ...rest } = server as unknown as Record<string, unknown> & {
    disabled?: boolean
    timeout?: { catalog?: number; execution?: number }
  }
  return {
    ...rest,
    enabled: disabled !== true,
    ...(timeout?.execution !== undefined ? { timeout: timeout.execution } : {}),
  }
}

function fromLegacyMcp(value: unknown): Mcp.ServerConfig | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const { enabled, timeout, ...rest } = value as Record<string, unknown> & { enabled?: boolean; timeout?: number }
  const base = {
    ...rest,
    ...(enabled === false ? { disabled: true } : {}),
    ...(typeof timeout === "number" ? { timeout: { catalog: timeout, execution: timeout } } : {}),
  }
  return base as Mcp.ServerConfig
}

/** Minimal stand-in for the v1 SDK client. */
function legacyClient(id: string, warn: (key: string, message: string) => void) {
  const make = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_target, property) => (typeof property === "string" ? make([...path, property]) : undefined),
      apply: (_target, _this, args) => {
        const name = path.join(".")
        if (name === "tui.showToast") {
          const body = (args[0] as { body?: { title?: string; message?: string } } | undefined)?.body
          console.log(`[plugin ${id}] toast: ${[body?.title, body?.message].filter(Boolean).join(" — ")}`)
          return Promise.resolve({ data: true })
        }
        if (name === "app.log") return Promise.resolve({ data: true })
        warn(`client:${name}`, `v1 client.${name}() is not available on the v2 host; returning no data`)
        return Promise.resolve({ data: undefined })
      },
    })
  return make([])
}

type Envelope = { readonly type: string; readonly data: unknown; readonly created?: number }
type Legacy = { type: string; properties: Record<string, unknown> }

/** Stateful because tool parts need the name from `session.tool.input.started` and calls carry only ids. */
function eventTranslator(ctx: Context) {
  const toolNames = new Map<string, string>()
  const directory = ctx.location.directory
  return (event: Envelope): Legacy[] => {
    const data = (event.data ?? {}) as Record<string, any>
    const created = event.created ?? Date.now()
    const part = (messageID: string, sessionID: string, id: string, body: Record<string, unknown>): Legacy => ({
      type: "message.part.updated",
      properties: { part: { id, messageID, sessionID, ...body } },
    })
    switch (event.type) {
      case "session.created":
        return [
          {
            type: "session.created",
            properties: {
              info: {
                id: data.sessionID,
                projectID: data.projectID,
                directory: data.location?.directory ?? directory,
                parentID: data.parentID,
                title: data.title ?? data.slug ?? "",
                version: "2",
                time: { created, updated: created },
              },
            },
          },
        ]
      case "session.deleted":
        return [
          {
            type: "session.deleted",
            properties: { info: { id: data.sessionID, time: { created, updated: created } } },
          },
        ]
      case "session.execution.succeeded":
      case "session.execution.interrupted":
        return [{ type: "session.idle", properties: { sessionID: data.sessionID } }]
      case "session.execution.failed":
        return [{ type: "session.error", properties: { sessionID: data.sessionID, error: data.error } }]
      case "session.compaction.ended":
        return [{ type: "session.compacted", properties: { sessionID: data.sessionID } }]
      case "session.inbox.enqueued": {
        if (data.item?.type !== "user") return []
        const id = data.inboxID
        return [
          {
            type: "message.updated",
            properties: { info: { id, sessionID: data.sessionID, role: "user", time: { created } } },
          },
          part(id, data.sessionID, `${id}:text`, { type: "text", text: data.item.payload?.text ?? "" }),
        ]
      }
      case "session.step.started":
        return [
          {
            type: "message.updated",
            properties: {
              info: { id: data.assistantMessageID, sessionID: data.sessionID, role: "assistant", time: { created } },
            },
          },
        ]
      case "session.step.ended":
        return [
          {
            type: "message.updated",
            properties: {
              info: {
                id: data.assistantMessageID,
                sessionID: data.sessionID,
                role: "assistant",
                finish: data.finish,
                cost: data.cost,
                tokens: data.tokens,
                time: { created, completed: created },
              },
            },
          },
        ]
      case "session.text.ended":
        return [
          part(data.assistantMessageID, data.sessionID, `${data.assistantMessageID}:text:${data.ordinal}`, {
            type: "text",
            text: data.text,
          }),
        ]
      case "session.reasoning.ended":
        return [
          part(data.assistantMessageID, data.sessionID, `${data.assistantMessageID}:reasoning:${data.ordinal}`, {
            type: "reasoning",
            text: data.text,
          }),
        ]
      case "session.tool.input.started":
        toolNames.set(data.id, data.name)
        return []
      case "session.tool.called":
        return [
          part(data.assistantMessageID, data.sessionID, data.id, {
            type: "tool",
            callID: data.id,
            tool: toolNames.get(data.id) ?? "unknown",
            state: { status: "running", input: data.input },
          }),
        ]
      case "session.tool.success": {
        const output = (data.content ?? [])
          .flatMap((item: any) => (item?.type === "text" ? [item.text] : []))
          .join("\n")
        return [
          part(data.assistantMessageID, data.sessionID, data.id, {
            type: "tool",
            callID: data.id,
            tool: toolNames.get(data.id) ?? "unknown",
            state: { status: "completed", output, metadata: data.metadata ?? {} },
          }),
        ]
      }
      case "session.tool.failed":
        return [
          part(data.assistantMessageID, data.sessionID, data.id, {
            type: "tool",
            callID: data.id,
            tool: toolNames.get(data.id) ?? "unknown",
            state: { status: "error", error: data.error?.message ?? String(data.error) },
          }),
        ]
      default:
        return [{ type: event.type, properties: data }]
    }
  }
}

export * as PluginLegacyV1 from "./legacy-v1.js"
