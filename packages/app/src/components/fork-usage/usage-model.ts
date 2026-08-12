/**
 * FORK-ONLY FILE — not present upstream, so it never conflicts on rebase.
 *
 * Range presets, series shaping and number formatting for the usage dashboard — the parts with real logic,
 * kept out of the component so they can be tested.
 */
import { localDayOrigin, type UsageDimension, type UsageRow, type UsageTokens } from "@/utils/fork-api"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export type RangeID = "5h" | "1d" | "7d" | "30d" | "all"

/**
 * `align` decides where the window starts, and the two cases genuinely differ.
 *
 * An hour-bucketed range is a rolling window ending now: "the last five hours" means exactly that, and a
 * partial first column is the honest rendering of it. A day-bucketed range instead covers whole local
 * days, because a chart with one column per day should not have its oldest column cut off at whatever
 * time of day it happens to be.
 */
export type RangePreset = {
  id: RangeID
  spanMs?: number
  bucketMs: number
  align: "rolling" | "day"
}

export const RANGES: RangePreset[] = [
  { id: "5h", spanMs: 5 * HOUR, bucketMs: HOUR, align: "rolling" },
  { id: "1d", spanMs: DAY, bucketMs: HOUR, align: "rolling" },
  { id: "7d", spanMs: 7 * DAY, bucketMs: DAY, align: "day" },
  { id: "30d", spanMs: 30 * DAY, bucketMs: DAY, align: "day" },
  { id: "all", bucketMs: DAY, align: "day" },
]

export type ResolvedRange = {
  from?: number
  bucketMs: number
  originMs: number
}

/**
 * Turns a preset into endpoint parameters.
 *
 * `originMs` is the local day boundary for *every* preset, hour buckets included. Aligning hour buckets to
 * local midnight rather than to epoch 0 costs nothing where the offset is a whole number of hours, and is
 * the difference between correct and half-past labels in the zones where it is not (+05:30, +05:45).
 */
export function resolveRange(preset: RangePreset, now: number, dayStartHour = 0): ResolvedRange {
  const originMs = localDayOrigin(now, dayStartHour)
  if (preset.spanMs === undefined) return { bucketMs: preset.bucketMs, originMs }
  if (preset.align === "day") {
    const days = Math.round(preset.spanMs / DAY)
    return { from: originMs - (days - 1) * DAY, bucketMs: preset.bucketMs, originMs }
  }
  return { from: now - preset.spanMs, bucketMs: preset.bucketMs, originMs }
}

const tokens = (row: UsageRow): UsageTokens => row.tokens

/**
 * Everything the model actually read to answer, cache included.
 *
 * Reported as one figure because the split is not a fact about the work: on real data cache reads came to
 * 175,711,918 against 181,625 fresh input tokens, a thousand to one. "Input tokens" alone therefore
 * understates the context by three orders of magnitude and reads as though almost nothing was sent.
 */
export const contextTokens = (row: UsageRow) => tokens(row).input + tokens(row).cache.read

/** Everything that moved, in and out — what "tokens" means when a row is annotated with one figure. */
export const allTokens = (row: UsageRow) => contextTokens(row) + row.tokens.output

/**
 * Share of the context that came from cache.
 *
 * The useful reading is a health check rather than a comparison — it sat at 95–98% across both main models,
 * so a *drop* is the signal: it means the prefix stopped matching and full context is being re-billed.
 */
export const cacheHitRate = (row: UsageRow) => {
  const total = tokens(row).input + tokens(row).cache.read + tokens(row).cache.write
  return total === 0 ? 0 : tokens(row).cache.read / total
}

/**
 * Sums every row into one total, for the stat cards.
 *
 * Summing client-side rather than issuing a second ungrouped request: the grouped rows already partition
 * the same window, so their sum is the total by construction and cannot disagree with the chart above it.
 */
export function totals(rows: readonly UsageRow[]): UsageRow {
  return rows.reduce<UsageRow>(
    (accumulator, row) => ({
      requests: accumulator.requests + row.requests,
      cost: accumulator.cost + row.cost,
      thinkingMs: accumulator.thinkingMs + row.thinkingMs,
      tokens: {
        input: accumulator.tokens.input + row.tokens.input,
        output: accumulator.tokens.output + row.tokens.output,
        reasoning: accumulator.tokens.reasoning + row.tokens.reasoning,
        cache: {
          read: accumulator.tokens.cache.read + row.tokens.cache.read,
          write: accumulator.tokens.cache.write + row.tokens.cache.write,
        },
      },
    }),
    {
      requests: 0,
      cost: 0,
      thinkingMs: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  )
}

export type TreeNode = {
  key: string
  label: string
  depth: 0 | 1 | 2
  kind: "project" | "session" | "child"
  /** The row this node aggregates, so any figure can be derived from it without a second pass. */
  row: UsageRow
  cost: number
  requests: number
  agent?: string
  /** The node that has to be open for this one to show. Undefined on projects, which are always visible. */
  parentKey?: string
  /** Whether anything is nested under it, and therefore whether it gets a disclosure control. */
  hasChildren: boolean
}

/**
 * Project → root session → sub-agent, from rows grouped by `[session, project, agent]`.
 *
 * This replaces the "include sub-sessions" switch the first version shipped. That switch existed only
 * because sub-agent rows were unlabelled, so the choice on offer was between two equally unreadable
 * totals. Sub-agent sessions do have titles — "审查 Responses backend (@explore subagent)" — and once the
 * endpoint sends them the relationship is worth drawing rather than collapsing: on real data one root and
 * its twelve sub-agents accounted for $174 of $204, which a flat list cannot show.
 *
 * Nesting stops at depth 2 because it stops there in the data — no sub-agent spawns another. A child whose
 * parent is missing from the rows (filtered out by the range) is promoted to the top rather than dropped,
 * so the tree always accounts for every row it was given.
 */
export function buildSessionTree(rows: readonly UsageRow[], unnamedProject: string): TreeNode[] {
  type Entry = { row: UsageRow; agents: Map<string, number> }
  const sessions = new Map<string, Entry>()

  for (const row of rows) {
    if (row.sessionID === undefined) continue
    const existing = sessions.get(row.sessionID)
    const agent = row.agent
    if (!existing) {
      sessions.set(row.sessionID, {
        row,
        agents: new Map(agent === undefined ? [] : [[agent, row.cost]]),
      })
      continue
    }
    // Same session split across agents: sum it back together and remember which agent dominated.
    existing.row = { ...existing.row, ...totals([existing.row, row]) }
    if (agent !== undefined) existing.agents.set(agent, (existing.agents.get(agent) ?? 0) + row.cost)
  }

  const dominantAgent = (agents: Map<string, number>) => [...agents.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]

  const byProject = new Map<string, { label: string; nodes: TreeNode[]; rows: UsageRow[] }>()
  const childrenOf = new Map<string, string[]>()
  for (const [id, entry] of sessions) {
    const parent = entry.row.parentSessionID
    if (parent !== undefined && sessions.has(parent)) {
      childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), id])
    }
  }

  const node = (id: string, entry: Entry, depth: 1 | 2, parentKey: string, hasChildren: boolean): TreeNode => ({
    key: id,
    label: entry.row.sessionTitle ?? id.slice(-6),
    depth,
    kind: depth === 1 ? "session" : "child",
    row: entry.row,
    cost: entry.row.cost,
    requests: entry.row.requests,
    agent: dominantAgent(entry.agents),
    parentKey,
    hasChildren,
  })

  for (const [id, entry] of sessions) {
    const parent = entry.row.parentSessionID
    if (parent !== undefined && sessions.has(parent)) continue

    const projectKey = entry.row.projectID ?? "__none"
    let group = byProject.get(projectKey)
    if (!group) {
      const worktree = entry.row.projectWorktree
      group = {
        label: worktree ? worktree.replace(/\/+$/, "").split("/").pop() || worktree : unnamedProject,
        nodes: [],
        rows: [],
      }
      byProject.set(projectKey, group)
    }

    const childIDs = childrenOf.get(id) ?? []
    const children = childIDs
      .map((childID) => node(childID, sessions.get(childID)!, 2, id, false))
      .sort((a, b) => b.cost - a.cost)

    group.nodes.push(node(id, entry, 1, `project:${projectKey}`, children.length > 0), ...children)
    // The project total counts the whole subtree — that is the number worth comparing projects by.
    group.rows.push(entry.row, ...children.map((child) => child.row))
  }

  return [...byProject.entries()]
    .map(([key, group]) => ({ key, group, total: totals(group.rows) }))
    .sort((a, b) => b.total.cost - a.total.cost)
    .flatMap(({ key, group, total }) => [
      {
        key: `project:${key}`,
        label: group.label,
        depth: 0 as const,
        kind: "project" as const,
        row: total,
        cost: total.cost,
        requests: total.requests,
        hasChildren: group.nodes.length > 0,
      },
      ...group.nodes,
    ])
}

/**
 * The nodes to draw, given which ones are open.
 *
 * Every ancestor must be open, not just the immediate parent. Checking one level was a real bug: open a
 * project, open a session inside it, then close the project — the sub-agents stayed on screen, because their
 * parent session was still marked open even though it had itself disappeared. Walking the chain makes closing
 * anything hide everything beneath it, at any depth.
 */
export function visibleNodes(nodes: readonly TreeNode[], isOpen: (key: string) => boolean): TreeNode[] {
  const parents = new Map(nodes.map((node) => [node.key, node.parentKey]))
  return nodes.filter((node) => {
    let ancestor = node.parentKey
    while (ancestor !== undefined) {
      if (!isOpen(ancestor)) return false
      ancestor = parents.get(ancestor)
    }
    return true
  })
}

/**
 * Re-keys hourly rows onto the display granularity and returns the full column axis.
 *
 * Two bugs live here if this is skipped.
 *
 * The server's day buckets are a fixed `origin + k*86400000`, because it deliberately holds no timezone
 * knowledge. That stride is not a local day across a DST transition, so a client that computes a cell's key as
 * a *true* local midnight looks up a key the server never emitted: past a transition every day's spend
 * disappears from the calendar, and a bar labelled from the raw bucket reads as the day before. Asking the
 * server for hours — an hour is an hour in every zone — and folding them here with the browser's own rules
 * makes the boundaries exact. Only non-empty buckets come back, so the extra rows cost little: a real history
 * of 1026 messages spans 24 active hours.
 *
 * And the axis has to be generated rather than collected from the rows. Taking the distinct buckets present
 * means a range with gaps draws only the days that had traffic, evenly spaced — 21 calendar days rendered as 7
 * adjacent columns, which claims Jul 24 and Aug 4 are neighbours. The calendar below it draws the empty days,
 * so the two views of one dataset disagreed.
 */
export function alignBuckets(input: {
  rows: readonly UsageRow[]
  granularity: "hour" | "day"
  from?: number
  to?: number
  dayStartHour?: number
}): { columns: number[]; rows: UsageRow[] } {
  const day = input.granularity === "day"
  const key = (ts: number) => (day ? localDayOrigin(ts, input.dayStartHour ?? 0) : Math.floor(ts / HOUR) * HOUR)

  const stamps = input.rows.map((row) => row.bucket ?? 0)
  const first = input.from ?? (stamps.length > 0 ? Math.min(...stamps) : undefined)
  const last = input.to ?? (stamps.length > 0 ? Math.max(...stamps) : undefined)
  if (first === undefined || last === undefined) return { columns: [], rows: [] }

  const columns: number[] = []
  // Calendar stepping for days, so a 23- or 25-hour day still advances exactly one column.
  for (let cursor = key(first); cursor <= key(last) && columns.length < 2000; ) {
    columns.push(cursor)
    if (!day) {
      cursor += HOUR
      continue
    }
    const next = new Date(cursor)
    next.setDate(next.getDate() + 1)
    cursor = next.getTime()
  }

  return { columns, rows: input.rows.map((row) => ({ ...row, bucket: key(row.bucket ?? 0) })) }
}

export type ReadoutEntry = {
  key: string
  label: string
  order: number
  /** The aggregate for this series, over the whole range or over one bucket. */
  row: UsageRow
  /** True when a bucket is being inspected and this series did nothing in it. */
  idle: boolean
}

/**
 * One row per series in the range, aggregated either across the range or within a single bucket.
 *
 * The rows come from the range and not from the bucket, so inspecting a column never reflows the table — the
 * models used in a range do not change as the pointer crosses it. What a bucket *can* change is whether a
 * series appears in it at all, and that is where an earlier version went wrong: a series missing from the
 * hovered bucket fell back to its range total, so hovering a day that used two models still listed the other
 * two with figures they had earned weeks before. Absent from a bucket is zero in that bucket.
 */
export function readoutTable(input: {
  rows: readonly UsageRow[]
  series: ReadonlyArray<{ key: string; label: string }>
  keyOf: (row: UsageRow) => string
  /** Restrict to one bucket. Undefined aggregates the whole range and nothing is marked idle. */
  bucket?: number
}): ReadoutEntry[] {
  const grouped = new Map<string, UsageRow[]>()
  for (const row of input.rows) {
    if (input.bucket !== undefined && row.bucket !== input.bucket) continue
    const key = input.keyOf(row)
    grouped.set(key, [...(grouped.get(key) ?? []), row])
  }
  return input.series.map((series, order) => {
    const row = totals(grouped.get(series.key) ?? [])
    return {
      key: series.key,
      label: series.label,
      order,
      row,
      idle: input.bucket !== undefined && row.requests === 0 && row.cost === 0,
    }
  })
}

export type SeriesKey = { key: string; label: string }

export type ShapedSeries = {
  columns: number[]
  series: Array<{ key: string; label: string; values: number[] }>
  truncatedSeries: number
}

/**
 * Pivots flat aggregate rows into one value array per series, aligned on a shared bucket axis.
 *
 * Series beyond `maxSeries` are folded into one remainder rather than dropped: forty sessions would
 * otherwise be forty indistinguishable lines, and silently showing only the top six would make the chart
 * disagree with the totals above it. `truncatedSeries` reports how many were folded.
 */
export function shapeSeries(input: {
  rows: readonly UsageRow[]
  metric: (row: UsageRow) => number
  seriesOf?: (row: UsageRow) => SeriesKey
  maxSeries?: number
  /**
   * Series order to follow instead of ranking by this metric's own totals.
   *
   * Needed when two measures are stacked side by side: requests ranked by request count and cost ranked by
   * cost would put the same model at different heights in the two bars, so a segment could not be traced
   * across — which is the whole reason for showing them together. Keys absent from the list keep their
   * ranked order after the ones named.
   */
  order?: readonly string[]
  /**
   * The bucket axis to pivot onto.
   *
   * Supplied rather than collected from the rows: taking the distinct buckets present drops the empty ones, so
   * a range with gaps renders as evenly spaced columns that misstate how far apart they are. See `alignBuckets`.
   */
  columns?: readonly number[]
  otherLabel: string
  singleLabel: string
}): ShapedSeries {
  const maxSeries = input.maxSeries ?? 6
  const columns = input.columns
    ? [...input.columns]
    : [...new Set(input.rows.map((row) => row.bucket ?? 0))].sort((a, b) => a - b)
  const columnIndex = new Map(columns.map((bucket, index) => [bucket, index]))

  const groups = new Map<string, { label: string; total: number; values: number[] }>()
  for (const row of input.rows) {
    const identity = input.seriesOf?.(row) ?? { key: "__all", label: input.singleLabel }
    let group = groups.get(identity.key)
    if (!group) {
      group = { label: identity.label, total: 0, values: columns.map(() => 0) }
      groups.set(identity.key, group)
    }
    const value = input.metric(row)
    group.total += value
    const position = columnIndex.get(row.bucket ?? 0)
    // A row outside the supplied axis still counts toward the series total, so the chart and the figures beside
    // it cannot disagree, but it has no column to occupy.
    if (position !== undefined) group.values[position] += value
  }

  const ranked = [...groups.entries()].sort((a, b) => b[1].total - a[1].total)
  if (input.order) {
    const position = new Map(input.order.map((key, index) => [key, index]))
    ranked.sort(
      (a, b) => (position.get(a[0]) ?? Number.MAX_SAFE_INTEGER) - (position.get(b[0]) ?? Number.MAX_SAFE_INTEGER),
    )
  }
  const kept = ranked.slice(0, maxSeries)
  const folded = ranked.slice(maxSeries)

  const series = kept.map(([key, group]) => ({ key, label: group.label, values: group.values }))
  if (folded.length > 0) {
    series.push({
      key: "__other",
      label: input.otherLabel,
      values: columns.map((_, index) => folded.reduce((sum, [, group]) => sum + group.values[index], 0)),
    })
  }

  return { columns, series, truncatedSeries: folded.length }
}

/** The dimension whose value labels a series, or undefined when the chart is a single line. */
export function seriesDimension(groupBy: readonly UsageDimension[]): UsageDimension | undefined {
  return groupBy.find((dimension) => dimension !== "time")
}

const compact = new Map<string, Intl.NumberFormat>()

/**
 * Compact counts (1.2K, 263M) because token figures span five orders of magnitude — cache reads reached
 * 175,711,918 against 181,625 input tokens in the same history, and full digits make an axis unreadable.
 */
export function formatCount(value: number, locale: string): string {
  if (!Number.isFinite(value)) return "0"
  if (Math.abs(value) < 1000) return String(Math.round(value))
  let formatter = compact.get(locale)
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 })
    compact.set(locale, formatter)
  }
  return formatter.format(value)
}

/**
 * Currency, with extra places only where two would round a real value to `$0.00`.
 *
 * Fine buckets do land below half a cent — an hour of cheap model use, or a whole quiet day — and showing
 * those as zero would claim nothing happened. Everything at or above a cent keeps the usual two places,
 * so the common case is not made noisy to serve the rare one.
 */
export function formatCost(value: number, locale: string): string {
  // Guarded like formatCount is: a non-finite value would render as "$NaN".
  if (!Number.isFinite(value)) return formatCost(0, locale)
  const digits = value !== 0 && Math.abs(value) < 0.01 ? 4 : 2
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: digits,
  }).format(value)
}

/** Axis and tooltip labels for a bucket, chosen by bucket width rather than by preset. */
export function bucketLabels(bucket: number, bucketMs: number, locale: string): { label: string; short: string } {
  const date = new Date(bucket)
  if (bucketMs < DAY) {
    return {
      label: date.toLocaleString(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }),
      short: date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }),
    }
  }
  return {
    label: date.toLocaleDateString(locale, { weekday: "short", year: "numeric", month: "short", day: "numeric" }),
    short: date.toLocaleDateString(locale, { month: "short", day: "numeric" }),
  }
}
