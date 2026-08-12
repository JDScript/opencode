/**
 * FORK-ONLY FILE — not present upstream, so it never conflicts on rebase.
 *
 * Thin client for the fork's own `/fork/*` endpoints.
 *
 * These endpoints are deliberately *not* added to the generated SDKs (`@opencode-ai/sdk`,
 * `@opencode-ai/client`): those are produced by codegen into checked-in `generated/` directories, and
 * regenerating them would rewrite thousands of lines that upstream also regenerates on every release
 * — the single worst rebase conflict this fork could create. A hand-written fetch wrapper costs a few
 * lines and keeps every generated file untouched.
 *
 * Auth and fetch come from the same places the real SDK uses, so behaviour matches on desktop, WSL
 * and remote servers alike.
 */
import type { ServerConnection } from "@/context/server"
import { authTokenFromCredentials } from "@/utils/server"

export type ForkConfigFile = {
  path: string
  content: string
  exists: boolean
}

export type ForkConfigWriteResult = { ok: true; path: string; content: string } | { ok: false; error: string }

export type ForkConfigValidation = {
  ok: boolean
  error?: string
}

/** JSON Schema document: root `$ref` into `$defs`, as produced by `Schema.toJsonSchemaDocument`. */
export type ForkConfigSchema = {
  $ref?: string
  $defs?: Record<string, JsonSchemaNode>
  [key: string]: unknown
}

export type JsonSchemaNode = {
  type?: string | string[]
  description?: string
  properties?: Record<string, JsonSchemaNode>
  additionalProperties?: boolean | JsonSchemaNode
  items?: JsonSchemaNode
  anyOf?: JsonSchemaNode[]
  oneOf?: JsonSchemaNode[]
  allOf?: JsonSchemaNode[]
  enum?: unknown[]
  const?: unknown
  $ref?: string
  [key: string]: unknown
}

export const USAGE_DIMENSIONS = ["time", "session", "project", "model", "agent", "variant"] as const
export type UsageDimension = (typeof USAGE_DIMENSIONS)[number]

export type UsageTokens = {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

/**
 * One aggregate group.
 *
 * Dimension fields are present only when that dimension was grouped by — and absent on a dimension that
 * *was* grouped by means the stored value was null (`variant` on messages predating reasoning tiers).
 * `UsageResult.groupBy` echoes what the server applied, so the two cases stay distinguishable.
 */
export type UsageRow = {
  bucket?: number
  sessionID?: string
  parentSessionID?: string
  /** Session title, sent for the same reason as `projectWorktree`. Sub-agent sessions have titles too. */
  sessionTitle?: string
  projectID?: string
  /** Worktree path, sent with `projectID` because only the active server's projects are in the sync store. */
  projectWorktree?: string
  providerID?: string
  modelID?: string
  agent?: string
  variant?: string
  requests: number
  cost: number
  /**
   * Reasoning time, absolute. Zero where the provider does not stream timed reasoning — Anthropic times its
   * reasoning but reports no reasoning tokens, OpenAI the reverse — so this is per-model detail, never a
   * headline figure, and it is not comparable with `tokens.reasoning`.
   */
  thinkingMs: number
  tokens: UsageTokens
}

export type UsageResult = {
  rows: UsageRow[]
  groupBy: UsageDimension[]
  bucketMs?: number
  originMs: number
  truncated: boolean
}

export type UsageParams = {
  from?: number
  to?: number
  /**
   * Bucket width in ms — a duration, never a calendar unit. The server does the division and holds no
   * timezone knowledge, so a local day is 86400000 paired with an `originMs` derived here.
   */
  bucketMs?: number
  /** Bucket alignment origin. Compute with {@link localDayOrigin} for calendar-aligned buckets. */
  originMs?: number
  groupBy?: readonly UsageDimension[]
  sessionID?: string
  includeChildren?: boolean
  projectID?: string
  providerID?: string
  modelID?: string
  agent?: string
  variant?: string
}

/**
 * Epoch ms of the most recent day boundary at or before `at`, in the browser's own timezone.
 *
 * This is the piece of the design SQLite cannot do: it has no tzdata, so
 * `date(ts, 'unixepoch', 'Asia/Shanghai')` returns NULL and the server could only apply a fixed offset —
 * which misplaces spend around DST transitions. `Date` here has the real rules.
 *
 * `dayStartHour` moves the boundary off midnight, which is not a nicety: on a real history 75% of spend
 * fell between local 00:00 and 03:00, so a calendar day splits one night's work across two columns.
 */
export function localDayOrigin(at: number | Date = Date.now(), dayStartHour = 0): number {
  const date = new Date(at)
  date.setHours(dayStartHour, 0, 0, 0)
  // Before the boundary, the current day started on the previous calendar date.
  if (date.getTime() > new Date(at).getTime()) date.setDate(date.getDate() - 1)
  return date.getTime()
}

/**
 * Just the call signature, not `typeof globalThis.fetch`.
 *
 * The wrapper only ever invokes it, and the full type carries extras (bun's `preconnect`) that any stub
 * would have to reimplement to satisfy the compiler — making the injection point untestable without a
 * cast, for no benefit.
 */
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export type ForkApiFailure =
  /** The server has no `/fork/*` routes — an official build, or one older than the endpoint. */
  | "unsupported"
  /** Credentials missing or rejected. */
  | "unauthorized"
  /** Reached the endpoint and it failed. */
  | "http"

export class ForkApiError extends Error {
  readonly kind: ForkApiFailure
  readonly status: number

  constructor(kind: ForkApiFailure, status: number, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "ForkApiError"
    this.kind = kind
    this.status = status
  }
}

/**
 * True when the server simply does not have the endpoint.
 *
 * Worth distinguishing from a failure, because it is a normal state rather than a fault: the app can be
 * pointed at several servers at once, and any of them may be an official build or one predating the
 * endpoint. Callers show "not available here", not an error.
 */
export const isForkUnsupported = (error: unknown) => error instanceof ForkApiError && error.kind === "unsupported"

export function createForkApi(input: { server: ServerConnection.HttpBase; fetch?: FetchLike }) {
  const doFetch = input.fetch ?? globalThis.fetch.bind(globalThis)
  const base = input.server.url.replace(/\/+$/, "")

  const buildHeaders = (hasBody: boolean) => {
    const headers: Record<string, string> = {}
    if (input.server.password) {
      headers.Authorization = `Basic ${authTokenFromCredentials({
        username: input.server.username,
        password: input.server.password,
      })}`
    }
    if (hasBody) headers["content-type"] = "application/json"
    return headers
  }

  async function call<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
    const response = await doFetch(`${base}${path}`, {
      method: init?.method ?? "GET",
      headers: buildHeaders(init?.body !== undefined),
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    })
    const method = init?.method ?? "GET"
    const contentType = response.headers.get("content-type") ?? ""
    const isJson = contentType.includes("json")

    if (response.status === 401 || response.status === 403) {
      throw new ForkApiError("unauthorized", response.status, `${method} ${path} → ${response.status}`)
    }

    /**
     * A server without the fork's routes does **not** answer 404.
     *
     * `server/shared/ui.ts` registers a catch-all (`router.add("*", "/*")`) that serves the SPA for any
     * unrouted path, so `/fork/*` on an official build — or on one older than the endpoint — comes back
     * `200 text/html` with an index.html body. Verified against both: an official 1.18.15 install and a
     * source run predating the route each returned exactly that.
     *
     * So the content type, not the status, is what separates a missing endpoint from a real answer.
     * Without this check the HTML reached `response.json()` and surfaced as
     * `SyntaxError: Unexpected token '<'` — a parser complaint that says nothing about the real cause.
     */
    if (response.status === 404 || (response.ok && !isJson)) {
      throw new ForkApiError("unsupported", response.status, `${method} ${path} is not available on this server`)
    }

    if (!response.ok) {
      throw new ForkApiError("http", response.status, `${method} ${path} → ${response.status} ${response.statusText}`)
    }

    // Routed through `unknown` so the `any` from `response.json()` does not leak into callers. The
    // remaining `as T` is unavoidable for a generic fetch wrapper without validating every response
    // shape here; these endpoints are this fork's own and are schema-checked server-side.
    try {
      const data: unknown = await response.json()
      return data as T
    } catch (cause) {
      // Declared JSON but unparseable: a proxy or tunnel rewrote the body. Not "unsupported" — the route
      // answered — so it stays a plain failure rather than being reported as a missing feature.
      throw new ForkApiError("http", response.status, `${method} ${path} returned a malformed JSON body`, { cause })
    }
  }

  return {
    /** JSON Schema for the config file, generated by the server from its own compiled schema. */
    schema: () => call<ForkConfigSchema>("/fork/config/schema"),
    /** Verbatim contents of the server's global config file. */
    read: () => call<ForkConfigFile>("/fork/config/raw"),
    /** Dry run: same parse and schema decode a save performs, writing nothing. */
    validate: (content: string) =>
      call<ForkConfigValidation>("/fork/config/validate", { method: "POST", body: { content } }),
    /** Whole-file replace. Rejected without writing if the content would not load. */
    write: (content: string) => call<ForkConfigWriteResult>("/fork/config/raw", { method: "PUT", body: { content } }),
    /** Aggregated token and cost usage. See {@link UsageParams}. */
    usage: (params: UsageParams = {}) => call<UsageResult>(`/fork/usage${usageQuery(params)}`),
  }
}

function usageQuery(params: UsageParams): string {
  const search = new URLSearchParams()
  const set = (key: string, value: number | string | undefined) => {
    if (value !== undefined) search.set(key, String(value))
  }
  set("from", params.from)
  set("to", params.to)
  set("bucketMs", params.bucketMs)
  set("originMs", params.originMs)
  // Comma-separated rather than repeated: dimension names cannot contain a comma, and the server
  // validates the list and echoes back what it applied.
  if (params.groupBy?.length) search.set("groupBy", params.groupBy.join(","))
  set("sessionID", params.sessionID)
  if (params.includeChildren) search.set("includeChildren", "true")
  set("projectID", params.projectID)
  set("providerID", params.providerID)
  set("modelID", params.modelID)
  set("agent", params.agent)
  set("variant", params.variant)
  const query = search.toString()
  return query === "" ? "" : `?${query}`
}

export type ForkApi = ReturnType<typeof createForkApi>

/** Flattened schema entry for the reference panel. */
export type ConfigFieldDoc = {
  key: string
  type: string
  description?: string
}

function resolveRef(schema: ForkConfigSchema, ref: string): JsonSchemaNode | undefined {
  const match = /^#\/\$defs\/(.+)$/.exec(ref)
  if (!match) return undefined
  return schema.$defs?.[decodeURIComponent(match[1])]
}

/** Human-readable type label. Nullable unions collapse to the non-null member plus a `?` marker. */
function typeLabel(node: JsonSchemaNode | undefined, schema: ForkConfigSchema, depth = 0): string {
  if (!node || depth > 4) return "any"
  if (node.$ref) {
    const name = node.$ref.split("/").pop()
    const resolved = resolveRef(schema, node.$ref)
    // Prefer a structural label for wrappers; keep the definition name when it is meaningful.
    if (resolved?.enum) return resolved.enum.map((value) => JSON.stringify(value)).join(" | ")
    return name ? decodeURIComponent(name) : "object"
  }
  if (node.enum) return node.enum.map((value) => JSON.stringify(value)).join(" | ")
  if (node.const !== undefined) return JSON.stringify(node.const)

  const branches = node.anyOf ?? node.oneOf
  if (branches?.length) {
    const labels = branches
      .filter((branch) => !(branch.type === "null"))
      .map((branch) => typeLabel(branch, schema, depth + 1))
    const nullable = branches.some((branch) => branch.type === "null")
    const joined = [...new Set(labels)].join(" | ") || "any"
    return nullable ? `${joined} | null` : joined
  }

  if (node.type === "array") return `${typeLabel(node.items, schema, depth + 1)}[]`
  if (node.type === "object" || node.properties) {
    if (node.additionalProperties && typeof node.additionalProperties === "object") {
      return `record<string, ${typeLabel(node.additionalProperties, schema, depth + 1)}>`
    }
    return "object"
  }
  if (Array.isArray(node.type)) return node.type.join(" | ")
  return node.type ?? "any"
}

/**
 * Top-level config keys with type and description, for the reference panel.
 *
 * The root of the generated document is only a `$ref`, so the real object has to be resolved out of
 * `$defs` first — reading `schema.properties` directly finds nothing.
 */
export function configFieldDocs(schema: ForkConfigSchema | undefined): ConfigFieldDoc[] {
  if (!schema) return []
  const root = schema.$ref ? resolveRef(schema, schema.$ref) : (schema as JsonSchemaNode)
  const properties = root?.properties
  if (!properties) return []
  return Object.entries(properties)
    .filter(([key]) => key !== "$schema")
    .map(([key, node]) => ({
      key,
      type: typeLabel(node, schema),
      description: typeof node.description === "string" ? node.description : undefined,
    }))
    .sort((a, b) => a.key.localeCompare(b.key))
}
