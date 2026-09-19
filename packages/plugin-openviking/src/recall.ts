export * as Recall from "./recall.js"

import type { Plugin } from "@opencode/plugin"
import type { SessionPrompt } from "@opencode/plugin/promise/session"
import { buildProfileBlock } from "../vendor/openviking/shared/profile-inject.mjs"
import { buildRecallBlock } from "../vendor/openviking/shared/recall-core.mjs"
import { isBypassed } from "../vendor/openviking/shared/session-model.mjs"
import { effectivePeerId, fetchJSON, log, type Fetcher } from "../vendor/openviking/utils.mjs"
import { Runtime } from "./runtime.js"

const MARKER = "<openviking-context"

/**
 * Memory injection for a new user prompt. Runs from the `prompt` hook, which the host calls while
 * admitting the prompt and before its inbox row exists, so a synthetic message admitted here lands
 * in front of the prompt: both are promoted together and the model reads the memory, then the
 * question, in one request. The synthetic shows up in the transcript as its own collapsible entry
 * and later turns see it from history, so nothing is injected twice.
 */
export async function inject(ctx: Plugin.Context, event: SessionPrompt) {
  const state = await Runtime.session(ctx, event.sessionID)
  if (state.recalled.has(event.messageID)) return
  state.recalled.add(event.messageID)
  const cfg = Runtime.config(state.directory)
  if (event.prompt.text.includes(MARKER)) return
  if (isBypassed(cfg, { sessionId: event.sessionID, cwd: state.directory })) return
  if (!(await Runtime.healthy(cfg))) return

  const blocks = [
    ...(state.injected || cfg.noAutoInject || state.ov.includes("__subagent-") ? [] : [await sessionStart(cfg, state)]),
    ...(cfg.autoRecall?.enabled ? [await recall(cfg, state, event.prompt.text)] : []),
  ].flatMap((block) => (block ? [block] : []))
  if (!state.injected) {
    state.injected = true
    Runtime.touch(state)
  }

  for (const block of blocks) {
    await ctx.session.synthetic({
      sessionID: event.sessionID,
      text: block.text,
      description: block.description,
      metadata: { openviking: block.kind },
      resume: false,
    })
    log("INFO", block.kind, `Injected OpenViking ${block.kind} context`, {
      opencode_session: event.sessionID,
      openviking_session: state.ov,
    })
  }
}

interface Block {
  kind: "session-start" | "recall"
  text: string
  description: string
}

/** Profile, preferences and the previous archive of this session, shown once per session. */
async function sessionStart(cfg: Runtime.Config, state: Runtime.SessionState): Promise<Block | undefined> {
  const peer = effectivePeerId(cfg)
  const fetcher: Fetcher = (endpoint, init = {}, opts = {}) =>
    fetchJSON(cfg, endpoint, init, { ...opts, actorPeerId: peer, timeoutMs: 10_000 })
  const profile = await buildProfileBlock(fetcher, cfg.profileTokenBudget, peer)
  const archive = await fetcher(
    `/api/v1/sessions/${encodeURIComponent(state.ov)}/context?token_budget=${Math.max(1024, cfg.resumeContextBudget)}`,
  )
  const overview = archive.ok ? String(archive.result?.latest_archive_overview ?? "").trim() : ""
  const parts = [
    ...(profile?.block ? [profile.block] : []),
    ...(overview ? [[`<session-archive session="${state.ov}">`, overview, "</session-archive>"].join("\n")] : []),
  ]
  if (parts.length === 0) return undefined
  return {
    kind: "session-start",
    description: overview ? "OpenViking profile and session archive" : "OpenViking profile",
    text: [`${MARKER} source="session-start">`, ...parts, "</openviking-context>"].join("\n"),
  }
}

async function recall(cfg: Runtime.Config, state: Runtime.SessionState, query: string): Promise<Block | undefined> {
  const trimmed = query.trim()
  if (trimmed.length < cfg.autoRecall.minQueryLength) return undefined
  const fetcher: Fetcher = (endpoint, init = {}, opts = {}) =>
    fetchJSON(cfg, endpoint, init, { ...opts, timeoutMs: opts.timeoutMs ?? 5000 })
  const text = await buildRecallBlock(fetcher, cfg, trimmed, {
    actorPeerId: effectivePeerId(cfg),
    legacyPeerId: cfg.effectivePeer?.legacyPeerId ?? "",
    sessionId: state.ov,
    log: (stage, data) => log("DEBUG", "recall", stage, data),
  })
  if (!text) return undefined
  const count = (text.match(/<memory /g) ?? []).length
  return {
    kind: "recall",
    description:
      count > 0 ? `OpenViking recalled ${count} ${count === 1 ? "memory" : "memories"}` : "OpenViking recall",
    text,
  }
}
