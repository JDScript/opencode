/**
 * FORK-ONLY FILE — not present upstream, so it never conflicts on rebase.
 *
 * Token and cost aggregation over this server's own message history, for the fork's usage dashboard.
 *
 * Why an endpoint at all, when `Session.Info` already carries `cost` and `tokens` and the web app
 * already loads every session:
 *
 *  - Session totals cannot answer "which model" or "when". `session.model` records only the *last*
 *    model a session used, and the row carries no timestamp for the spend — only the session's created
 *    and updated times. Both dimensions exist only per message.
 *  - The per-message route through the existing API is `session.messages`, which returns
 *    `SessionV1.WithParts`. On a real database that is ~17 MB of tool-output parts to extract ~227 KB
 *    of usage fields — an 86x amplification, times one request per session.
 *
 * The server deliberately holds no timezone knowledge: grouping is `(ts - originMs) / bucketMs`, two
 * plain numbers. The client computes `originMs` (local midnight, or a shifted day boundary) with the
 * browser's own tzdata, which SQLite does not have — `date(ts, 'unixepoch', 'Asia/Shanghai')` returns
 * NULL, so the alternative would be a fixed offset that silently misplaces spend across DST.
 *
 * Registered in ../api.ts and ../server.ts — one line each. See the note at the bottom of
 * ./fork-config.ts for why these are mounted standalone rather than added to `RootHttpApi`.
 */
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { described } from "./metadata"

/**
 * Dimensions the endpoint can group by.
 *
 * `agent` is exposed and `mode` is not: they hold identical values on every message (verified across a
 * 1026-message history — same four values, same distribution), so a second name for one dimension would
 * only invite disagreement. `variant` is the reasoning tier, and is the highest-signal dimension of the
 * six — on real data `medium` cost nearly twice what `xhigh` did across a quarter of the messages.
 *
 * `finish` and the message's `path` are deliberately absent: `finish` is 93% `tool-calls` and carries no
 * spend signal, and `path` tracks `project` closely enough to be noise.
 */
export const UsageDimensions = ["time", "session", "project", "model", "agent", "variant"] as const
export type UsageDimension = (typeof UsageDimensions)[number]

export const UsageQuery = Schema.Struct({
  /** Inclusive lower bound, epoch ms. Absent means unbounded. */
  from: Schema.optional(Schema.NumberFromString.check(Schema.isInt())),
  /** Exclusive upper bound, epoch ms. Absent means unbounded. */
  to: Schema.optional(Schema.NumberFromString.check(Schema.isInt())),
  /**
   * Bucket width in ms — a duration, not a calendar unit. Hour is 3600000, the 5h tick is 18000000, a
   * local day is 86400000 paired with an `originMs` the client derived from its own timezone. Absent
   * means no time grouping even if `time` is listed in `groupBy`.
   */
  bucketMs: Schema.optional(Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThan(0))),
  /** Bucket alignment origin, epoch ms. Defaults to 0, i.e. UTC-aligned buckets. */
  originMs: Schema.optional(Schema.NumberFromString.check(Schema.isInt())),
  /** Comma-separated subset of `UsageDimensions`. Empty or absent returns one grand-total row. */
  groupBy: Schema.optional(Schema.String),
  sessionID: Schema.optional(Schema.String),
  /**
   * Include the filtered session's children. Sub-agent sessions hold a third of all spend on real data,
   * so a session view that omits them understates the true cost of the task that spawned them.
   */
  includeChildren: Schema.optional(Schema.Literals(["true", "false"])),
  projectID: Schema.optional(Schema.String),
  providerID: Schema.optional(Schema.String),
  modelID: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  variant: Schema.optional(Schema.String),
})

const UsageTokens = Schema.Struct({
  input: Schema.Number,
  output: Schema.Number,
  reasoning: Schema.Number,
  cache: Schema.Struct({
    read: Schema.Number,
    write: Schema.Number,
  }),
})

/**
 * One aggregate row. Dimension fields are present only when that dimension was grouped by, so a row's
 * shape mirrors the request rather than carrying nulls for everything unasked.
 */
const UsageRow = Schema.Struct({
  /** Start of the bucket, epoch ms. Present when grouped by `time` with a `bucketMs`. */
  bucket: Schema.optional(Schema.Number),
  sessionID: Schema.optional(Schema.String),
  /**
   * The session's parent, when grouped by `session`. Returned so the client can roll sub-agent spend
   * into the session that spawned it, or leave it flat, without a second request — the endpoint takes no
   * position on which is right.
   */
  parentSessionID: Schema.optional(Schema.String),
  /**
   * The session's title, alongside its id when grouped by session.
   *
   * Same reason as the worktree below: only the *active* server's sessions are in the app's sync store, so
   * without this every other server's rows would be unlabelled ids. Sub-agent sessions carry titles too
   * ("审查 Responses backend (@explore subagent)"), which is what makes a parent/child view legible.
   */
  sessionTitle: Schema.optional(Schema.String),
  projectID: Schema.optional(Schema.String),
  /**
   * The project's worktree path, alongside its id when grouped by project.
   *
   * Sent because the client cannot resolve it: the dashboard can point at any configured server, and only
   * the *active* server's projects are in the app's sync store. Without this, a project breakdown for any
   * other server would be a column of 40-character hashes.
   */
  projectWorktree: Schema.optional(Schema.String),
  providerID: Schema.optional(Schema.String),
  modelID: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  variant: Schema.optional(Schema.String),
  /** Assistant messages, which is exactly the LLM round-trip count: every message has one step. */
  requests: Schema.Number,
  cost: Schema.Number,
  /**
   * Time spent producing reasoning, summed from the reasoning blocks' own start and end.
   *
   * An absolute duration and deliberately not a share of wall-clock time: a parent message's span contains
   * its sub-agents' messages, so summed wall clock double-counts — on real data one model's tool time alone
   * came to 117% of it. An absolute total needs no denominator and cannot mislead.
   *
   * Zero where the provider does not stream reasoning with timing. The two providers instrument this in
   * opposite ways — Anthropic reports timed reasoning blocks but zero reasoning *tokens*, OpenAI the
   * reverse — so this and `tokens.reasoning` are not comparable across providers and neither is a
   * substitute for the other.
   */
  thinkingMs: Schema.Number,
  tokens: UsageTokens,
})

const UsageResult = Schema.Struct({
  rows: Schema.Array(UsageRow),
  /** Echoed back, so a client can tell what it actually got rather than what it thought it asked for. */
  groupBy: Schema.Array(Schema.Literals(UsageDimensions)),
  bucketMs: Schema.optional(Schema.Number),
  originMs: Schema.Number,
  /** True when the row cap was hit and the result is incomplete. Never truncates silently. */
  truncated: Schema.Boolean,
})

export const ForkUsagePaths = {
  usage: "/fork/usage",
} as const

export const ForkUsageApi = HttpApi.make("fork-usage").add(
  HttpApiGroup.make("forkUsage")
    .add(
      HttpApiEndpoint.get("usage", ForkUsagePaths.usage, {
        query: UsageQuery,
        success: described(UsageResult, "Aggregated usage rows"),
        error: [HttpApiError.BadRequest],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "fork.usage",
          summary: "Aggregate token and cost usage",
          description:
            "Groups this server's assistant messages by any subset of time, session, project, model, agent and variant, returning request counts, cost and all five token classes per group. Time bucketing takes a plain duration and alignment origin rather than a calendar unit, so the caller's timezone stays on the caller's side.",
        }),
      ),
    )
    // Auth is mandatory: this reports what has been spent and, grouped by project, where. Declared on
    // the group rather than inherited from RootHttpApi because the API is mounted standalone.
    .middleware(Authorization)
    .annotateMerge(
      OpenApi.annotations({
        title: "fork-usage",
        description: "Fork-only token and cost aggregation.",
      }),
    ),
)
