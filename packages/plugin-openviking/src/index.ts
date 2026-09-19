import { Plugin } from "@opencode/plugin"
import type { Session } from "@opencode/schema/session"
import { effectivePeerId, fetchJSON, log } from "../vendor/openviking/utils.mjs"
import { Capture } from "./capture.js"
import { Recall } from "./recall.js"
import { Runtime } from "./runtime.js"

export const MCP_NAME = "openviking"

/**
 * OpenViking memory for OpenCode v2. Reuses the user's existing OpenViking credentials
 * (`~/.openviking/ovcli.conf`, `OPENVIKING_*` env, or `openviking-config.json`) and stays inert when
 * none are present. Compared with the v1 npm plugin: one shared runtime per process instead of one
 * per open project, the MCP server is a direct remote connection instead of a node proxy process,
 * captures are pulled from the host at turn boundaries instead of buffered from the event stream,
 * and injected memory is a synthetic transcript message instead of text prepended to the prompt.
 */
export default Plugin.define({
  id: "opencode.openviking",
  async setup(ctx) {
    const cfg = Runtime.register(ctx)
    if (!cfg) return
    log("INFO", "plugin", "OpenViking plugin set up", {
      directory: ctx.location.directory,
      endpoint: cfg.endpoint,
      credentialSource: cfg.credentialSource,
      peer: effectivePeerId(cfg),
    })
    const repos = repoContext(cfg)
    const registrations = [
      cfg.mcp.enabled
        ? await ctx.mcp.transform((editor) => {
            if (editor.get(MCP_NAME)?.disabled) return
            editor.set(MCP_NAME, {
              type: "remote",
              url: cfg.mcpUrl,
              headers: mcpHeaders(cfg),
              timeout: { startup: 15_000, catalog: 15_000, execution: 60_000 },
            })
          })
        : undefined,
      await ctx.session.hook("prompt", (event) =>
        guard("prompt", async () => {
          if (await Runtime.legacyActive(ctx)) return
          await Recall.inject(ctx, event)
        }),
      ),
      await ctx.session.hook("context", (event) =>
        guard("context", async () => {
          if (await Runtime.legacyActive(ctx)) return
          const prompt = await repos.prompt()
          if (prompt) event.system.push({ type: "text", text: prompt })
        }),
      ),
      await ctx.session.hook("compaction", (event) =>
        guard("compaction", async () => {
          if (await Runtime.legacyActive(ctx)) return
          await Capture.capture(ctx, event.sessionID, { commit: true, reason: "compaction" })
        }),
      ),
    ]
    const events = eventLoop(ctx)
    // Anything a previous process left in the offline queue; the loop also replays on new sessions.
    if (Runtime.contextCount() === 1) void guard("replay", () => Capture.replay(cfg))
    return async () => {
      events.stop()
      for (const registration of registrations) await registration?.dispose()
      Runtime.unregister(ctx)
      if (Runtime.contextCount() === 0) await Runtime.flush()
    }
  },
})

/** Hooks run under `Effect.promise`, where a rejection is a defect; keep every failure inside the plugin. */
async function guard(name: string, run: () => Promise<void>) {
  try {
    await run()
  } catch (error) {
    log("WARN", name, `OpenViking ${name} hook failed`, {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

function mcpHeaders(cfg: Runtime.Config) {
  return {
    ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
    ...(cfg.account ? { "X-OpenViking-Account": cfg.account } : {}),
    ...(cfg.user ? { "X-OpenViking-User": cfg.user } : {}),
    ...(cfg.recallPeerScope === "actor" && cfg.peerId ? { "X-OpenViking-Actor-Peer": cfg.peerId } : {}),
    ...(cfg.userAgent ? { "User-Agent": cfg.userAgent } : {}),
  }
}

/**
 * Session boundaries arrive as events. The bus is process-wide, so only one location's loop runs at a
 * time; when that location is torn down the next registered one takes over.
 */
function eventLoop(ctx: Plugin.Context) {
  const controller = new AbortController()
  void (async () => {
    for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
      if (controller.signal.aborted) return
      if (Runtime.anyContext() !== ctx) continue
      if (event.type === "session.created") await guard("event", () => created(ctx, id(event.data.sessionID)))
      if (
        event.type === "session.execution.succeeded" ||
        event.type === "session.execution.failed" ||
        event.type === "session.execution.interrupted"
      )
        await guard("event", () => boundary(ctx, id(event.data.sessionID), false, event.type))
      if (event.type === "session.deleted")
        await guard("event", async () => {
          await boundary(ctx, id(event.data.sessionID), true, event.type)
          Runtime.forget(event.data.sessionID)
        })
    }
  })().catch((error: unknown) => {
    if (controller.signal.aborted) return
    log("ERROR", "event", "OpenViking event loop ended", {
      error: error instanceof Error ? error.message : String(error),
    })
  })
  return { stop: () => controller.abort() }
}

// Event payloads carry plain strings; the session API wants the branded id.
const id = (value: string) => value as Session.ID

async function created(ctx: Plugin.Context, sessionID: Session.ID) {
  if (await Runtime.legacyActive(ctx)) return
  const state = await Runtime.session(ctx, sessionID)
  log("INFO", "event", "OpenViking session derived", { opencode_session: sessionID, openviking_session: state.ov })
  await Capture.replay(Runtime.config(state.directory))
}

async function boundary(ctx: Plugin.Context, sessionID: Session.ID, commit: boolean, reason: string) {
  if (await Runtime.legacyActive(ctx)) return
  await Capture.capture(ctx, sessionID, { commit, reason })
}

/** System-prompt note listing the repositories indexed in OpenViking, refreshed on a TTL. */
function repoContext(cfg: Runtime.Config) {
  let cached: string | undefined
  let at = 0
  return {
    prompt: async () => {
      if (!cfg.repoContext?.enabled) return undefined
      if (cached !== undefined && Date.now() - at < cfg.repoContext.cacheTtlMs) return cached || undefined
      const res = await fetchJSON(
        cfg,
        `/api/v1/fs/ls?uri=${encodeURIComponent("viking://resources/")}&recursive=false&simple=false`,
        {},
        { timeoutMs: 8000, actorPeerId: effectivePeerId(cfg) },
      )
      if (!res.ok) return cached || undefined
      at = Date.now()
      const items = (Array.isArray(res.result) ? res.result : []) as Array<{
        uri?: string
        abstract?: string
        overview?: string
      }>
      const lines = items
        .filter((item) => item.uri?.startsWith("viking://resources/") && item.uri !== "viking://resources/")
        .map((item) => {
          const name = item.uri!.replace("viking://resources/", "").replace(/\/$/, "") || "resources"
          const abstract = item.abstract || item.overview
          return abstract ? `- **${name}** (${item.uri})\n  ${abstract}` : `- **${name}** (${item.uri})`
        })
      cached = lines.length
        ? [
            "## OpenViking - Indexed Code Repositories",
            "",
            "The following external repositories are indexed in OpenViking and searchable through tools.",
            "When the user asks about these projects or their internals, use the OpenViking tools before answering.",
            "",
            "Tool guidance:",
            "- Use the `openviking_search` MCP tool for semantic or conceptual repository questions.",
            "- Use `openviking_grep` for exact symbols, error strings, class names, function names, and regex-like searches.",
            "- Use `openviking_glob` to enumerate files by pattern.",
            "- Use `openviking_list` to inspect directory structure and `openviking_read` to read specific URIs.",
            "- Use `openviking_add_resource` and `openviking_forget` for repository resource management when explicitly requested.",
            "",
            ...lines,
          ].join("\n")
        : ""
      log("INFO", "repo-context", "Repo context refreshed", { count: lines.length })
      return cached || undefined
    },
  }
}
