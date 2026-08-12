/**
 * FORK-ONLY FILE — not present upstream, so it never conflicts on rebase.
 *
 * Handler for ../groups/fork-usage.ts. See that file for why the aggregation lives on the server and
 * why the time bucket is a duration rather than a calendar unit.
 */
import { Database } from "@opencode-ai/core/database/database"
import { sql, type SQL } from "drizzle-orm"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { ForkUsageApi, UsageDimensions, UsageQuery, type UsageDimension } from "../groups/fork-usage"

/**
 * Upper bound on returned rows. Reached only by pathological requests — grouping every dimension at
 * once across all history produces 56 rows on a real 1026-message database — but a caller can ask for
 * minute buckets over a year, so the result is capped and the cap is reported rather than hidden.
 */
const ROW_CAP = 20_000

/**
 * A row as the driver hands it back. Values are typed `unknown` rather than narrowed here on purpose:
 * these are dynamically typed SQLite values, a grouped column is absent whenever its dimension was not
 * selected, and every value can be NULL. Declaring them narrower would move the coercion below from
 * real work into a cast the compiler already believes.
 */
type AggregateRow = {
  bucket?: unknown
  session_id?: unknown
  parent_session_id?: unknown
  session_title?: unknown
  project_id?: unknown
  project_worktree?: unknown
  provider_id?: unknown
  model_id?: unknown
  agent?: unknown
  variant?: unknown
  requests?: unknown
  cost?: unknown
  t_input?: unknown
  t_output?: unknown
  t_reasoning?: unknown
  t_cache_write?: unknown
  t_cache_read?: unknown
  thinking_ms?: unknown
}

const isDimension = (value: string): value is UsageDimension => (UsageDimensions as readonly string[]).includes(value)

/** `undefined` means an unknown dimension was named, which the caller turns into a 400. */
function parseDimensions(raw: string | undefined): UsageDimension[] | undefined {
  if (raw === undefined || raw.trim() === "") return []
  const out: UsageDimension[] = []
  for (const part of raw.split(",").map((piece) => piece.trim())) {
    if (part === "") continue
    if (!isDimension(part)) return undefined
    if (!out.includes(part)) out.push(part)
  }
  return out
}

/**
 * Both message tables, normalized to one shape.
 *
 * Two tables because two session systems coexist: v1 writes `message`, and durable v2 sessions write
 * `session_message`. Neither is authoritative on its own — on a real installation `session_message` is
 * empty and all 1026 messages are in `message`, but a fresh install can be the other way round, and
 * upstream will eventually flip. Reading both is correct in every case and needs no flag detection; a
 * session lives in exactly one of them, so `UNION ALL` cannot double-count.
 *
 * The shapes differ in three ways that would each silently yield nulls if crossed:
 * `role` is inside the JSON in v1 but a real column in v2; the model is flat (`$.modelID`,
 * `$.providerID`) in v1 and nested in v2; and v2's `Model.Ref` names the model `id`, not `modelID`.
 *
 * `time_created` is a column on both, so it is read from there rather than from the JSON — that is also
 * what v2's standalone `time_created` index covers. v1's only time index leads with `session_id`, so an
 * unfiltered range there is a scan; measured at 9ms across 1105 rows.
 *
 * Usage is read per message, not from the `step-finish` parts that `applyUsage` maintains the session
 * totals from. Both reconcile exactly ($204.0577 three ways on real data: session columns, message sum,
 * part sum) and only messages carry the model, agent and variant.
 */
function normalizedMessages(from: number | undefined, to: number | undefined) {
  const bounds = (column: SQL) => {
    const parts: SQL[] = []
    if (from !== undefined) parts.push(sql`${column} >= ${from}`)
    if (to !== undefined) parts.push(sql`${column} < ${to}`)
    return parts
  }

  const v1 = sql.join([sql`json_extract(m.data, '$.role') = 'assistant'`, ...bounds(sql`m.time_created`)], sql` AND `)
  const v2 = sql.join([sql`sm.type = 'assistant'`, ...bounds(sql`sm.time_created`)], sql` AND `)

  return sql`
    SELECT
      m.session_id AS session_id,
      m.time_created AS ts,
      json_extract(m.data, '$.providerID') AS provider_id,
      json_extract(m.data, '$.modelID') AS model_id,
      json_extract(m.data, '$.agent') AS agent,
      json_extract(m.data, '$.variant') AS variant,
      COALESCE(think.ms, 0) AS think_ms,
      COALESCE(json_extract(m.data, '$.cost'), 0) AS cost,
      COALESCE(json_extract(m.data, '$.tokens.input'), 0) AS t_input,
      COALESCE(json_extract(m.data, '$.tokens.output'), 0) AS t_output,
      COALESCE(json_extract(m.data, '$.tokens.reasoning'), 0) AS t_reasoning,
      COALESCE(json_extract(m.data, '$.tokens.cache.read'), 0) AS t_cache_read,
      COALESCE(json_extract(m.data, '$.tokens.cache.write'), 0) AS t_cache_write
    FROM message m
    LEFT JOIN (
      -- Pre-aggregated rather than joined row-by-row: a direct join to \`part\` would multiply every
      -- message by its reasoning blocks and inflate every token sum with it.
      SELECT
        message_id,
        SUM(json_extract(data, '$.time.end') - json_extract(data, '$.time.start')) AS ms
      FROM part
      WHERE json_extract(data, '$.type') = 'reasoning' AND json_extract(data, '$.time.start') IS NOT NULL
      GROUP BY message_id
    ) think ON think.message_id = m.id
    WHERE ${v1}
    UNION ALL
    SELECT
      sm.session_id,
      sm.time_created,
      json_extract(sm.data, '$.model.providerID'),
      json_extract(sm.data, '$.model.id'),
      json_extract(sm.data, '$.agent'),
      json_extract(sm.data, '$.model.variant'),
      -- v2 keeps reasoning inline in \`content\` and names the bounds \`created\`/\`completed\`, where v1
      -- uses separate \`part\` rows named \`start\`/\`end\`. Reading only the v1 shape would silently report
      -- zero thinking the day upstream flips over.
      COALESCE(
        (
          SELECT SUM(json_extract(c.value, '$.time.completed') - json_extract(c.value, '$.time.created'))
          FROM json_each(sm.data, '$.content') c
          WHERE json_extract(c.value, '$.type') = 'reasoning'
        ),
        0
      ),
      COALESCE(json_extract(sm.data, '$.cost'), 0),
      COALESCE(json_extract(sm.data, '$.tokens.input'), 0),
      COALESCE(json_extract(sm.data, '$.tokens.output'), 0),
      COALESCE(json_extract(sm.data, '$.tokens.reasoning'), 0),
      COALESCE(json_extract(sm.data, '$.tokens.cache.read'), 0),
      COALESCE(json_extract(sm.data, '$.tokens.cache.write'), 0)
    FROM session_message sm
    WHERE ${v2}
  `
}

/** SUM over an empty group is NULL, and COUNT is an integer; both arrive as dynamically typed values. */
const number = (value: unknown) => (value === null || value === undefined ? 0 : Number(value))

/**
 * A dimension value, or `undefined` when it was NULL or is not a scalar SQLite can label a group with.
 *
 * `undefined` is how a NULL group reaches the response: the field is then omitted, which for a *grouped*
 * dimension means "the stored value was null" — `variant` on messages predating reasoning tiers, for
 * instance. Not ambiguous with a dimension the caller never grouped by, since `groupBy` is echoed back.
 */
const label = (value: unknown) => {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "bigint") return String(value)
  return undefined
}

export const forkUsageHandlers = HttpApiBuilder.group(ForkUsageApi, "forkUsage", (handlers) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const usage = Effect.fn("ForkUsageHttpApi.usage")(function* (ctx: { query: typeof UsageQuery.Type }) {
      const params = ctx.query
      const dimensions = parseDimensions(params.groupBy)
      if (!dimensions) return yield* new HttpApiError.BadRequest({})

      const originMs = params.originMs ?? 0
      const bucketMs = params.bucketMs
      const grouped = new Set(dimensions)

      // Time is only a dimension if a width came with it; `groupBy=time` alone has no bucket to group
      // into. Echoed `groupBy` reflects what was actually applied, not what was asked.
      const applied = dimensions.filter((dimension) => dimension !== "time" || bucketMs !== undefined)

      // FLOOR rather than SQLite's `/`, which truncates toward zero: for a range beginning before the
      // origin that would fold the buckets on either side of it into one.
      const bucket =
        grouped.has("time") && bucketMs !== undefined
          ? sql`CAST(FLOOR((u.ts - ${originMs}) * 1.0 / ${bucketMs}) AS INTEGER) * ${bucketMs} + ${originMs}`
          : undefined

      const selected: SQL[] = []
      const groups: SQL[] = []
      const dimension = (select: SQL, group: SQL) => {
        selected.push(select)
        groups.push(group)
      }

      if (bucket) dimension(sql`${bucket} AS bucket`, bucket)
      if (grouped.has("session")) {
        dimension(sql`u.session_id AS session_id`, sql`u.session_id`)
        dimension(sql`s.parent_id AS parent_session_id`, sql`s.parent_id`)
        // Sent for the same reason as the project worktree: only the *active* server's sessions are in the
        // app's sync store, so any other server's rows would be a column of ids. Sub-agent sessions are
        // titled too — "审查 Responses backend (@explore subagent)" — which is what makes a parent/child
        // view readable at all.
        dimension(sql`s.title AS session_title`, sql`s.title`)
      }
      if (grouped.has("project")) {
        dimension(sql`s.project_id AS project_id`, sql`s.project_id`)
        // Functionally dependent on project_id, but still grouped: SQLite would accept a bare column here
        // and other engines would not, and the cost is nil.
        dimension(sql`p.worktree AS project_worktree`, sql`p.worktree`)
      }
      if (grouped.has("model")) {
        dimension(sql`u.provider_id AS provider_id`, sql`u.provider_id`)
        dimension(sql`u.model_id AS model_id`, sql`u.model_id`)
      }
      if (grouped.has("agent")) dimension(sql`u.agent AS agent`, sql`u.agent`)
      if (grouped.has("variant")) dimension(sql`u.variant AS variant`, sql`u.variant`)

      const filters: SQL[] = []
      if (params.sessionID !== undefined) {
        filters.push(
          params.includeChildren === "true"
            ? // Depth is 1 — a child session cannot itself have children — so one OR covers the whole
              // subtree. This needs a recursive CTE if upstream ever nests deeper.
              sql`(u.session_id = ${params.sessionID} OR s.parent_id = ${params.sessionID})`
            : sql`u.session_id = ${params.sessionID}`,
        )
      }
      if (params.projectID !== undefined) filters.push(sql`s.project_id = ${params.projectID}`)
      if (params.providerID !== undefined) filters.push(sql`u.provider_id = ${params.providerID}`)
      if (params.modelID !== undefined) filters.push(sql`u.model_id = ${params.modelID}`)
      if (params.agent !== undefined) filters.push(sql`u.agent = ${params.agent}`)
      if (params.variant !== undefined) filters.push(sql`u.variant = ${params.variant}`)

      // Joined unconditionally. `session.id` is the primary key, so a LEFT JOIN can neither duplicate a
      // message nor drop one whose session is missing — which keeps orphaned rows counted in totals
      // even though the FK says they cannot exist.
      const query = sql`
        WITH u AS (${normalizedMessages(params.from, params.to)})
        SELECT
          ${selected.length ? sql`${sql.join(selected, sql`, `)},` : sql``}
          COUNT(*) AS requests,
          SUM(u.cost) AS cost,
          SUM(u.t_input) AS t_input,
          SUM(u.t_output) AS t_output,
          SUM(u.t_reasoning) AS t_reasoning,
          SUM(u.t_cache_read) AS t_cache_read,
          SUM(u.t_cache_write) AS t_cache_write,
          SUM(u.think_ms) AS thinking_ms
        FROM u
        LEFT JOIN session s ON s.id = u.session_id
        LEFT JOIN project p ON p.id = s.project_id
        ${filters.length ? sql`WHERE ${sql.join(filters, sql` AND `)}` : sql``}
        ${groups.length ? sql`GROUP BY ${sql.join(groups, sql`, `)}` : sql``}
        ORDER BY ${bucket ? sql`bucket ASC, ` : sql``}SUM(u.cost) DESC
        LIMIT ${ROW_CAP + 1}
      `

      const raw = yield* db.all<AggregateRow>(query).pipe(Effect.orDie)
      const truncated = raw.length > ROW_CAP

      return {
        rows: raw.slice(0, ROW_CAP).map((row) => {
          const bucket = row.bucket === null || row.bucket === undefined ? undefined : number(row.bucket)
          const sessionID = label(row.session_id)
          const parentSessionID = label(row.parent_session_id)
          const sessionTitle = label(row.session_title)
          const projectID = label(row.project_id)
          const projectWorktree = label(row.project_worktree)
          const providerID = label(row.provider_id)
          const modelID = label(row.model_id)
          const agent = label(row.agent)
          const variant = label(row.variant)
          return {
            ...(bucket === undefined ? {} : { bucket }),
            ...(sessionID === undefined ? {} : { sessionID }),
            ...(parentSessionID === undefined ? {} : { parentSessionID }),
            ...(sessionTitle === undefined ? {} : { sessionTitle }),
            ...(projectID === undefined ? {} : { projectID }),
            ...(projectWorktree === undefined ? {} : { projectWorktree }),
            ...(providerID === undefined ? {} : { providerID }),
            ...(modelID === undefined ? {} : { modelID }),
            ...(agent === undefined ? {} : { agent }),
            ...(variant === undefined ? {} : { variant }),
            requests: number(row.requests),
            cost: number(row.cost),
            thinkingMs: number(row.thinking_ms),
            tokens: {
              input: number(row.t_input),
              output: number(row.t_output),
              reasoning: number(row.t_reasoning),
              cache: {
                read: number(row.t_cache_read),
                write: number(row.t_cache_write),
              },
            },
          }
        }),
        groupBy: applied,
        ...(bucketMs === undefined ? {} : { bucketMs }),
        originMs,
        truncated,
      }
    })

    return handlers.handle("usage", usage)
  }),
)
