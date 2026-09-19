export * as Runtime from "./runtime.js"

import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { Plugin } from "@opencode/plugin"
import type { Session } from "@opencode/schema/session"
import { loadConfig, resolveDataDir, type Config } from "../vendor/openviking/config.mjs"
import { fetchJSON, initLogger, log } from "../vendor/openviking/utils.mjs"
import { deriveHarnessSessionId } from "../vendor/openviking/shared/session-model.mjs"

export type { Config }

/** Package root; the vendored config loader looks for a default config file here. */
export const ROOT = fileURLToPath(new URL("..", import.meta.url))

export const LEGACY_PACKAGE = "@openviking/opencode-plugin"

/**
 * Per-session bookkeeping. `cursor` is the id of the last message already sent to OpenViking, so
 * a capture only needs the messages after it; `injected` records that the session-start block was
 * shown once; `recalled` holds the user message ids a recall has already run for.
 */
export interface SessionState {
  ov: string
  directory: string
  cursor?: string
  injected?: boolean
  recalled: Set<string>
  updated: number
}

interface Persisted {
  version: 1
  sessions: Record<string, { ov: string; directory: string; cursor?: string; injected?: boolean; updated: number }>
}

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const SAVE_DEBOUNCE_MS = 1000
const HEALTH_TTL_MS = 30_000
const LEGACY_TTL_MS = 60_000

// One instance per process, shared by every location the plugin is set up for. The v1 plugin held a
// full copy of this per location, which is what made memory grow with the number of open projects.
const contexts = new Map<string, Plugin.Context>()
const configs = new Map<string, Config>()
const sessions = new Map<string, SessionState>()
const chains = new Map<string, Promise<unknown>>()
let store:
  | { path: string; ready: Promise<void>; timer?: ReturnType<typeof setTimeout>; writing: Promise<void> }
  | undefined
let health: { ok: boolean; at: number } | undefined
let legacy: { active: boolean; at: number; warned: boolean } | undefined

export function config(directory?: string) {
  const key = directory ?? ""
  const cached = configs.get(key)
  if (cached) return cached
  const loaded = loadConfig(ROOT, directory)
  configs.set(key, loaded)
  return loaded
}

/** True when OpenViking credentials or a plugin config file exist; otherwise the plugin stays inert. */
export function configured(cfg: Config) {
  if (cfg.enabled === false) return false
  return cfg.credentialSource !== "auto" || Boolean(cfg.apiKey) || Boolean(cfg.configPath)
}

/** Register a location's context. Returns its config, or undefined when the plugin should stay inert. */
export function register(ctx: Plugin.Context) {
  const cfg = config(ctx.location.directory)
  if (!configured(cfg)) return undefined
  if (!store) {
    const dir = resolveDataDir(ROOT, cfg)
    initLogger(dir)
    const file = path.join(dir, "openviking-capture-state.json")
    store = { path: file, ready: load(file), writing: Promise.resolve() }
  }
  contexts.set(ctx.location.directory, ctx)
  return cfg
}

export function unregister(ctx: Plugin.Context) {
  contexts.delete(ctx.location.directory)
}

export function contextCount() {
  return contexts.size
}

/** Any live context; session APIs are keyed by session id, so which location issues the call does not matter. */
export function anyContext(directory?: string) {
  return (directory && contexts.get(directory)) || contexts.values().next().value
}

export async function session(ctx: Plugin.Context, sessionID: Session.ID): Promise<SessionState> {
  await store?.ready
  const existing = sessions.get(sessionID)
  if (existing) return existing
  const info = await ctx.session.get({ sessionID })
  const state: SessionState = {
    ov: info.parentID
      ? deriveHarnessSessionId("oc-", info.parentID, `subagent-${sessionID}`)
      : deriveHarnessSessionId("oc-", sessionID),
    directory: info.location.directory,
    recalled: new Set(),
    updated: Date.now(),
  }
  sessions.set(sessionID, state)
  return state
}

export function forget(sessionID: string) {
  sessions.delete(sessionID)
  chains.delete(sessionID)
  save()
}

export function touch(state: SessionState) {
  state.updated = Date.now()
  save()
}

/** Run session work one step at a time so two boundaries cannot capture the same messages twice. */
export function serial<T>(sessionID: string, work: () => Promise<T>): Promise<T> {
  const previous = chains.get(sessionID) ?? Promise.resolve()
  const next = previous.then(work, work)
  chains.set(
    sessionID,
    next.catch(() => undefined),
  )
  return next
}

export async function healthy(cfg: Config) {
  if (health && Date.now() - health.at < HEALTH_TTL_MS) return health.ok
  const res = await fetchJSON(cfg, "/health", {}, { timeoutMs: 5000 })
  health = { ok: res.ok, at: Date.now() }
  if (!res.ok) log("WARN", "health", "OpenViking service is not reachable", { endpoint: cfg.endpoint })
  return res.ok
}

/**
 * When the v1 npm plugin is still configured it runs through the host's compatibility adapter and
 * would inject and capture alongside this one, so this plugin stands down until it is removed.
 */
export async function legacyActive(ctx: Plugin.Context) {
  if (legacy && Date.now() - legacy.at < LEGACY_TTL_MS) return legacy.active
  const listed = await ctx.plugin.list().catch(() => undefined)
  const active = (listed?.data ?? []).some(
    (plugin) =>
      plugin.state.status === "active" &&
      ((plugin.id ?? "").startsWith(LEGACY_PACKAGE) ||
        (plugin.source.type === "package" && plugin.source.target.startsWith(LEGACY_PACKAGE))),
  )
  const warned = legacy?.warned ?? false
  if (active && !warned) {
    log("WARN", "plugin", `${LEGACY_PACKAGE} is still configured; the built-in OpenViking plugin is standing down`, {
      hint: `remove "${LEGACY_PACKAGE}" from the plugins list in opencode.json to switch to the built-in plugin`,
    })
  }
  legacy = { active, at: Date.now(), warned: warned || active }
  return active
}

async function load(file: string) {
  const raw = await fs.readFile(file, "utf8").catch(() => undefined)
  if (!raw) return
  const parsed = (() => {
    try {
      return JSON.parse(raw) as Persisted
    } catch {
      return undefined
    }
  })()
  if (!parsed || parsed.version !== 1) return
  const cutoff = Date.now() - RETENTION_MS
  for (const [id, entry] of Object.entries(parsed.sessions)) {
    if (entry.updated < cutoff) continue
    sessions.set(id, { ...entry, recalled: new Set() })
  }
  log("INFO", "persistence", "Capture state loaded", { count: sessions.size })
}

function save() {
  const target = store
  if (!target) return
  if (target.timer) clearTimeout(target.timer)
  target.timer = setTimeout(() => {
    target.timer = undefined
    target.writing = target.writing.then(() => write(target.path)).catch(() => undefined)
  }, SAVE_DEBOUNCE_MS)
}

async function write(file: string) {
  const persisted: Persisted = { version: 1, sessions: {} }
  for (const [id, state] of sessions) {
    persisted.sessions[id] = {
      ov: state.ov,
      directory: state.directory,
      ...(state.cursor ? { cursor: state.cursor } : {}),
      ...(state.injected ? { injected: true } : {}),
      updated: state.updated,
    }
  }
  const tmp = `${file}.${process.pid}.tmp`
  await fs.writeFile(tmp, JSON.stringify(persisted), "utf8")
  await fs.rename(tmp, file)
}

/** Flush pending writes; used on dispose and by tests. */
export async function flush() {
  const target = store
  if (!target) return
  if (target.timer) {
    clearTimeout(target.timer)
    target.timer = undefined
    target.writing = target.writing.then(() => write(target.path)).catch(() => undefined)
  }
  await target.writing
}

/** Test hook: drop all shared state. */
export function reset() {
  contexts.clear()
  configs.clear()
  sessions.clear()
  chains.clear()
  if (store?.timer) clearTimeout(store.timer)
  store = undefined
  health = undefined
  legacy = undefined
}
