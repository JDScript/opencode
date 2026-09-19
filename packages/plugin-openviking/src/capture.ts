export * as Capture from "./capture.js"

import type { Plugin } from "@opencode/plugin"
import type { Session } from "@opencode/schema/session"
import { sendSessionMessages } from "../vendor/openviking/shared/batch-send.mjs"
import {
  extractPartsFromPayload,
  extractTextFromContent,
  shouldCaptureText,
} from "../vendor/openviking/shared/capture-utils.mjs"
import { enqueue, replayPending } from "../vendor/openviking/shared/pending-queue.mjs"
import { isRetryableFailure } from "../vendor/openviking/shared/retryable.mjs"
import { effectivePeerId, fetchJSON, log, type Fetcher } from "../vendor/openviking/utils.mjs"
import { Runtime } from "./runtime.js"

type Info = Awaited<ReturnType<Plugin.Context["session"]["context"]>>[number]

/**
 * Pull-model capture. At a session boundary (turn finished, about to compact, deleted) read the
 * session's active context from the host and send whatever lies after the cursor. Nothing is
 * buffered between boundaries: the transcript already lives in the host's database, so a crash
 * loses nothing and memory does not grow with conversation length.
 */
export async function capture(
  ctx: Plugin.Context,
  sessionID: Session.ID,
  options: { commit: boolean; reason: string },
): Promise<void> {
  return Runtime.serial(sessionID, async () => {
    const state = await Runtime.session(ctx, sessionID)
    const cfg = Runtime.config(state.directory)
    if (!cfg.autoCapture) return
    const messages = await ctx.session.context({ sessionID })
    const start = state.cursor ? messages.findIndex((message) => message.id === state.cursor) + 1 : 0
    const fresh = messages.slice(start)
    if (fresh.length === 0) {
      if (options.commit) await commit(cfg, state.ov, options.reason)
      return
    }
    const fetcher: Fetcher = (endpoint, init = {}, opts = {}) => fetchJSON(cfg, endpoint, init, opts)
    const peer = effectivePeerId(cfg)
    const items = fresh.map((message) => ({ id: message.id, body: body(message, cfg, peer) }))
    const bodies = items.flatMap((item) => (item.body ? [item.body] : []))
    const sent = bodies.length ? await send(fetcher, state.ov, bodies) : 0
    // Advance past every message that was sent or had nothing to send, stopping at the first unsent one.
    let remaining = sent
    for (const item of items) {
      if (item.body) {
        if (remaining === 0) break
        remaining -= 1
      }
      state.cursor = item.id
    }
    Runtime.touch(state)
    if (sent > 0)
      log("INFO", "capture", "Captured session messages", {
        opencode_session: sessionID,
        openviking_session: state.ov,
        sent,
        skipped: fresh.length - bodies.length,
        reason: options.reason,
      })
    if (options.commit) await commit(cfg, state.ov, options.reason)
    else if (sent > 0) await commitIfOverThreshold(cfg, state.ov)
  })
}

/** Re-send anything an earlier run left in the offline queue. Cheap when the queue is empty. */
export async function replay(cfg: Runtime.Config) {
  if (!(await Runtime.healthy(cfg))) return
  await replayPending(
    (endpoint, init = {}, opts = {}) => fetchJSON(cfg, endpoint, init, opts),
    (stage, data) => log("DEBUG", "pending", stage, data),
  )
}

async function send(fetcher: Fetcher, ov: string, bodies: unknown[]) {
  const res = await sendSessionMessages(fetcher, ov, bodies, { enqueueOnRetryable: true })
  const added = res.sent + res.queued
  if (res.failed > 0 || res.enqueueFailed > 0)
    log("ERROR", "capture", "Failed to add messages to OpenViking session", {
      openviking_session: ov,
      status: res.lastError?.status,
      error: res.lastError?.error,
      failed: res.failed,
      enqueueFailed: res.enqueueFailed,
    })
  return added
}

async function commit(cfg: Runtime.Config, ov: string, reason: string) {
  const payload = { keep_recent_count: cfg.commitKeepRecentCount }
  const res = await fetchJSON(
    cfg,
    `/api/v1/sessions/${encodeURIComponent(ov)}/commit`,
    { method: "POST", body: JSON.stringify(payload) },
    { timeoutMs: 30_000 },
  )
  if (res.ok) {
    log("INFO", "session", "Committed OpenViking session", { openviking_session: ov, reason, trace_id: res.traceId })
    return
  }
  if (isRetryableFailure(res)) {
    await enqueue("commitSession", ov, payload)
    log("WARN", "session", "Queued OpenViking session commit", { openviking_session: ov, reason, status: res.status })
    return
  }
  log("ERROR", "session", "Failed to commit OpenViking session", {
    openviking_session: ov,
    reason,
    status: res.status,
    error: res.error,
    trace_id: res.traceId,
  })
}

async function commitIfOverThreshold(cfg: Runtime.Config, ov: string) {
  if (cfg.commitTokenThreshold <= 0) return
  const meta = await fetchJSON(cfg, `/api/v1/sessions/${encodeURIComponent(ov)}`, {}, { timeoutMs: 5000 })
  const pending = Number(meta.result?.pending_tokens || 0)
  if (!meta.ok || pending < cfg.commitTokenThreshold) return
  await commit(cfg, ov, "threshold")
}

/**
 * Turn one host message into an OpenViking capture body, or undefined when there is nothing worth
 * keeping. Synthetic messages are skipped: they are this plugin's own injections and the host's
 * reminders, and feeding them back would make memory recall recursive.
 */
export function body(message: Info, cfg: Runtime.Config, peer: string | null) {
  const built = (() => {
    if (message.type === "user") return fromText("user", message.text, cfg)
    if (message.type === "shell") return fromText("user", `$ ${message.command}`, cfg)
    if (message.type !== "assistant" || !cfg.captureAssistantTurns) return undefined
    const content = message.content.flatMap((part): Array<Record<string, unknown>> => {
      if (part.type === "text") return [{ type: "text", text: part.text }]
      if (part.type !== "tool") return []
      return [
        {
          type: "tool",
          id: part.id,
          name: part.name,
          state: {
            status: part.state.status,
            input: "input" in part.state ? part.state.input : undefined,
            output: part.state.status === "completed" ? contentText(part.state.content) : undefined,
            error: part.state.status === "error" ? part.state.error.message : undefined,
          },
        },
      ]
    })
    if (content.length === 0) return undefined
    const opts = { toolMaxChars: cfg.captureToolMaxChars }
    const parts = extractPartsFromPayload({ role: "assistant", content }, opts)
    const tools = parts.some((part) => part.type === "tool")
    const decision = shouldCaptureText(extractTextFromContent(content, opts), "assistant", cfg)
    if (!decision.shouldCapture && !tools) return undefined
    return parts.length ? { role: "assistant", parts } : { role: "assistant", content: decision.text }
  })()
  if (!built) return undefined
  return peer ? { ...built, peer_id: peer } : built
}

function fromText(role: string, text: string, cfg: Runtime.Config) {
  const decision = shouldCaptureText(text, role, cfg)
  if (!decision.shouldCapture) return undefined
  return { role, content: decision.text }
}

type ToolState = Extract<Extract<Info, { type: "assistant" }>["content"][number], { type: "tool" }>["state"]

function contentText(content: Extract<ToolState, { status: "completed" }>["content"]) {
  return content
    .map((item) => (item.type === "text" ? item.text : `[file ${item.name ?? item.uri}]`))
    .filter(Boolean)
    .join("\n")
}
