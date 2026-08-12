/**
 * FORK-ONLY FILE — not present upstream, so it never conflicts on rebase.
 *
 * The usage dashboard: global when opened without a session, scoped to one when opened with it.
 *
 * Four blocks, each answering one question, none of them configurable: how much and how often (the summary
 * and the chart), where it went (projects and models), and when (the calendar, with the session tree folded
 * underneath it). Earlier versions offered selectors for metric and group-by, which handed the reader the job
 * of finding the interesting view — but those views are knowable in advance, because the data has a consistent
 * shape. Spend is extremely concentrated, volume is almost entirely cache, and the surprise is always in the
 * gap between request count and cost.
 *
 * Nothing upstream answers this. The context circle in the prompt row is a point-in-time gauge read off the
 * last assistant message, and the Context tab beside it details that one message. Neither is cumulative and
 * neither crosses sessions.
 */
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { SegmentedControlV2, SegmentedControlItemV2 } from "@opencode-ai/ui/v2/segmented-control-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { createMemo, createResource, createSignal, For, Show, type JSX } from "solid-js"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { ServerConnection, serverName, useServer } from "@/context/server"
import { useServerSDK } from "@/context/server-sdk"
import {
  createForkApi,
  isForkUnsupported,
  localDayOrigin,
  type UsageDimension,
  type UsageParams,
  type UsageRow,
} from "@/utils/fork-api"
import { UsageBarChart, UsageHeatmap, type ChartColumn, type Series } from "./charts"
import { UsageBars, UsageReadout, UsageTree, type BarRow } from "./panels"
import {
  RANGES,
  alignBuckets,
  bucketLabels,
  buildSessionTree,
  cacheHitRate,
  contextTokens,
  readoutTable,
  formatCost,
  formatCount,
  resolveRange,
  shapeSeries,
  totals,
  type RangeID,
} from "./usage-model"
import "./dialog-usage.css"

const HOUR = 3_600_000
const DAY = 24 * HOUR

export function DialogUsage(props: { sessionID?: string }): JSX.Element {
  const language = useLanguage()
  const platform = usePlatform()
  const servers = useServer()
  const serverSdk = useServerSDK()

  const [serverKey, setServerKey] = createSignal<ServerConnection.Key>()
  // 5h by default: the question this answers most often is what the run in progress is costing.
  const [range, setRange] = createSignal<RangeID>("5h")
  const [sessionsOpen, setSessionsOpen] = createSignal(false)
  /** Which chart column is being inspected. Held here because the readout below the chart is this page's.  */
  const [inspected, setInspected] = createSignal<number>()

  const locale = () => language.intl()

  /** The session view is pinned to the server owning the session; only the global view can be pointed elsewhere. */
  const connection = createMemo(() => {
    if (props.sessionID) return serverSdk().server
    const key = serverKey()
    if (key === undefined) return serverSdk().server
    return servers.list.find((entry) => ServerConnection.key(entry) === key) ?? serverSdk().server
  })

  const api = createMemo(() => createForkApi({ server: connection().http, fetch: platform.fetch }))

  /**
   * A session scope always includes its children.
   *
   * Not a choice: sub-agents hold about a third of all spend, so a session's cost without them is not the cost
   * of that session's work. The tree shows which child cost what, which is what an include/exclude switch was
   * reaching for when it was there.
   */
  const scope = createMemo(() => (props.sessionID ? { sessionID: props.sessionID, includeChildren: true } : {}))

  const preset = createMemo(() => RANGES.find((entry) => entry.id === range()) ?? RANGES[0])

  /**
   * What to ask the server for: always hourly.
   *
   * The display granularity is applied here instead, because the server's day bucket is a fixed 86400000 stride
   * — correct by design, since it holds no timezone knowledge — and that stride is not a local day across a DST
   * transition. Folding hours here with the browser's own calendar makes every boundary exact. See
   * `alignBuckets`.
   */
  const displayWindow = createMemo(() => {
    const resolved = resolveRange(preset(), Date.now())
    return { ...resolved, bucketMs: HOUR, ...scope() }
  })

  const granularity = () => (preset().bucketMs >= DAY ? ("day" as const) : ("hour" as const))

  const load = (query: () => UsageParams | undefined) =>
    createResource(
      () => {
        const params = query()
        return params === undefined ? undefined : { client: api(), params }
      },
      ({ client, params }) => client.usage(params),
    )

  /**
   * The resource's value, or nothing when it failed.
   *
   * `resource.latest` **re-throws** once the resource has settled into an error — `latest`'s getter checks
   * `error()` and throws it. Read bare, a failing request therefore escapes to the nearest error boundary,
   * which here is the app root: the whole application would be replaced by the error page over a server that
   * simply has no `/fork/*` routes, which is a normal thing to point this at. `error` itself is safe to read.
   *
   * The same trap, with the same fix, is in fork-config.tsx — and it was written there first, which is why
   * this reads as an oversight rather than as something unknown.
   */
  const settled = <T,>(resource: { error: unknown; latest: T | undefined }) =>
    resource.error === undefined ? resource.latest : undefined

  /** Drives the summary, the chart and the model ranking — one request, three readings that cannot disagree. */
  const [usage] = load(() => ({ ...displayWindow(), groupBy: ["time", "model"] as UsageDimension[] }))

  /** Drives the tree and, summed per project, the project ranking. */
  const [structure] = load(() => ({ ...displayWindow(), groupBy: ["session", "project", "agent"] as UsageDimension[] }))

  /**
   * The session view drops three blocks rather than showing degenerate versions of them.
   *
   * One session belongs to one project, so a project ranking is a single bar and the tree's project level is a
   * heading over everything; and a calendar cannot say anything useful about a few hours. What is left — the
   * summary, the hourly chart, the models, and the sub-agent tree — is the whole of what a session view is for,
   * so the tree starts fully open instead of folded away. It still folds: the controls are the same ones the
   * global view has.
   */
  const scoped = () => props.sessionID !== undefined

  /**
   * The whole history at day resolution, whatever the range selector says — and only in the global view.
   *
   * A year calendar for one session is a year of blank squares around a few hours of work: a session does not
   * span days. Left unfetched rather than fetched and hidden.
   */
  const [heatmap] = load(() =>
    props.sessionID
      ? undefined
      : { groupBy: ["time"] as UsageDimension[], bucketMs: HOUR, originMs: localDayOrigin(Date.now()) },
  )

  /** Hourly rows folded onto the display granularity, with the axis covering the whole range. */
  const aligned = createMemo(() =>
    alignBuckets({
      rows: settled(usage)?.rows ?? [],
      granularity: granularity(),
      from: displayWindow().from,
      to: Date.now(),
    }),
  )
  const rows = createMemo<UsageRow[]>(() => aligned().rows)
  const summary = createMemo(() => totals(rows()))

  const failure = createMemo(() => {
    if (usage.error === undefined || settled(usage) !== undefined) return undefined
    return isForkUnsupported(usage.error) ? "unsupported" : "error"
  })

  const count = (value: number) => formatCount(value, locale())
  const cost = (value: number) => formatCost(value, locale())
  const requestsNote = (value: number) => language.t("fork.usage.requests.n", { count: count(value) })

  /**
   * The four figures that explain a cost, in the order they are usually reasoned about.
   *
   * Input counts cached tokens, because that is what was sent — the provider bills them at a different rate,
   * not as a different thing — and the cache share next to it says how much of it was cheap. Reporting fresh
   * input alone would have read as 181K against a real 176M.
   */
  const facts = (row: UsageRow) => [
    { label: language.t("fork.usage.short.requests"), value: count(row.requests) },
    { label: language.t("fork.usage.short.input"), value: count(contextTokens(row)) },
    { label: language.t("fork.usage.short.output"), value: count(row.tokens.output) },
    { label: language.t("fork.usage.short.cached"), value: `${(cacheHitRate(row) * 100).toFixed(0)}%` },
  ]

  /**
   * Cost stacked by model, sharing the chart's ordering with the ranking below it.
   *
   * Segments are capped at six with the tail folded into one remainder, so a long provider list cannot turn a
   * bar into a stack of hairlines — and the fold is summed rather than dropped, so the chart still adds up to
   * the summary above it.
   */
  const shaped = createMemo(() =>
    shapeSeries({
      rows: rows(),
      metric: (row) => row.cost,
      seriesOf: (row) => ({
        key: `${row.providerID ?? ""}/${row.modelID ?? ""}`,
        label: row.modelID ?? language.t("fork.usage.value.unset"),
      }),
      columns: aligned().columns,
      otherLabel: language.t("fork.usage.chart.other"),
      singleLabel: language.t("fork.usage.chart.all"),
    }),
  )

  /** Requests split by the same models as the cost stack, in the same order, so segments line up across bars. */
  const requestSeries = createMemo<Series[]>(
    () =>
      shapeSeries({
        rows: rows(),
        metric: (row) => row.requests,
        seriesOf: (row) => ({
          key: `${row.providerID ?? ""}/${row.modelID ?? ""}`,
          label: row.modelID ?? language.t("fork.usage.value.unset"),
        }),
        order: shaped().series.map((entry) => entry.key),
        otherLabel: language.t("fork.usage.chart.other"),
        singleLabel: language.t("fork.usage.chart.all"),
      }).series,
  )

  const seriesKey = (row: UsageRow) => `${row.providerID ?? ""}/${row.modelID ?? ""}`

  /** The figures under the chart: one row per model in the range, for the whole range or one column of it. */
  const readout = createMemo(() =>
    readoutTable({
      rows: rows(),
      series: shaped().series,
      keyOf: seriesKey,
      bucket: inspected() === undefined ? undefined : shaped().columns[inspected()!],
    }),
  )

  /**
   * The measures the readout carries, in the order a cost is reasoned about: how often, how much, and then the
   * token split that explains it.
   */
  const readoutColumns = createMemo(() => [
    { label: language.t("fork.usage.short.requests"), of: (row: UsageRow) => count(row.requests) },
    { label: language.t("fork.usage.short.cost"), of: (row: UsageRow) => cost(row.cost) },
    { label: language.t("fork.usage.short.input"), of: (row: UsageRow) => count(contextTokens(row)) },
    { label: language.t("fork.usage.short.output"), of: (row: UsageRow) => count(row.tokens.output) },
    {
      label: language.t("fork.usage.short.cached"),
      of: (row: UsageRow) => (row.requests === 0 ? "—" : `${(cacheHitRate(row) * 100).toFixed(0)}%`),
    },
  ])

  const columns = createMemo<ChartColumn[]>(() =>
    shaped().columns.map((bucket) => bucketLabels(bucket, preset().bucketMs, locale())),
  )

  const tree = createMemo(() => buildSessionTree(settled(structure)?.rows ?? [], language.t("fork.usage.project.none")))

  /** Project totals come from the tree, so the ranking and the tree can never tell different stories. */
  const projects = createMemo<BarRow[]>(() =>
    tree()
      .filter((node) => node.kind === "project")
      .map((node) => ({
        key: node.key,
        label: node.label,
        value: node.cost,
        facts: facts(node.row),
      })),
  )

  const models = createMemo<BarRow[]>(() => {
    const unset = language.t("fork.usage.value.unset")
    const grouped = new Map<string, { label: string; row: UsageRow }>()
    for (const row of rows()) {
      const key = `${row.providerID ?? ""}/${row.modelID ?? ""}`
      const existing = grouped.get(key)
      const label = row.modelID ?? unset
      grouped.set(key, existing ? { label, row: { ...existing.row, ...totals([existing.row, row]) } } : { label, row })
    }
    return [...grouped.entries()]
      .map(([key, entry]) => ({
        key,
        label: entry.label,
        value: entry.row.cost,
        facts: facts(entry.row),
      }))
      .sort((a, b) => b.value - a.value)
  })

  const heatmapDays = createMemo(() => {
    const folded = alignBuckets({ rows: settled(heatmap)?.rows ?? [], granularity: "day" })
    const byDay = new Map<number, number>()
    for (const row of folded.rows) byDay.set(row.bucket!, (byDay.get(row.bucket!) ?? 0) + row.cost)
    return [...byDay.entries()].map(([day, value]) => ({ day, value }))
  })

  /** Weekday initials from Intl rather than seven more translation keys. 2026-08-09 is a Sunday: row 0. */
  const weekdays = createMemo(() => {
    const formatter = new Intl.DateTimeFormat(locale(), { weekday: "narrow" })
    return Array.from({ length: 7 }, (_, index) => formatter.format(new Date(2026, 7, 9 + index)))
  })

  const sessionCount = () => tree().filter((node) => node.kind !== "project").length
  const waiting = (loading: boolean) => language.t(loading ? "fork.usage.loading" : "fork.usage.chart.empty")

  return (
    <Dialog
      size="x-large"
      class="fork-usage-dialog"
      title={language.t(props.sessionID ? "fork.usage.session.title" : "fork.usage.title")}
      action={
        <div data-slot="fork-usage-header-actions">
          <Show when={!props.sessionID && servers.list.length > 1}>
            <SelectV2
              appearance="inline"
              options={servers.list}
              current={connection()}
              placement="bottom-end"
              gutter={6}
              aria-label={language.t("fork.usage.server")}
              value={(entry) => ServerConnection.key(entry)}
              label={(entry) => serverName(entry)}
              onSelect={(entry) => entry && setServerKey(ServerConnection.key(entry))}
            />
          </Show>
          <SegmentedControlV2
            value={range()}
            // Resolved through the preset table rather than asserted: the control hands back a bare string.
            onChange={(next) => {
              const found = RANGES.find((entry) => entry.id === next)
              if (!found) return
              setRange(found.id)
              // The inspected index belongs to the old axis. Left alone with the pointer still over the plot it
              // survives the switch and captions the readout with a column that no longer exists.
              setInspected(undefined)
            }}
            aria-label={language.t("fork.usage.range.label")}
          >
            <For each={RANGES}>
              {(preset) => (
                <SegmentedControlItemV2 value={preset.id}>
                  {language.t(`fork.usage.range.${preset.id}`)}
                </SegmentedControlItemV2>
              )}
            </For>
          </SegmentedControlV2>
        </div>
      }
    >
      <div data-component="fork-usage">
        <Show
          when={failure() === undefined}
          fallback={
            <div
              data-slot={failure() === "unsupported" ? "fork-usage-notice" : "fork-usage-error"}
              role={failure() === "unsupported" ? "status" : "alert"}
            >
              {failure() === "unsupported"
                ? language.t("fork.usage.error.unsupported", { server: serverName(connection()) })
                : language.t("fork.usage.error.load")}
            </div>
          }
        >
          {/*
            One figure with rank and four without, rather than five boxes of equal weight. Money is the reason
            anyone opens this, and the rest are the context that explains it — a flat grid said they mattered
            equally and gave the eye nowhere to land.
          */}
          <header data-slot="fork-usage-summary">
            <div data-slot="fork-usage-summary-lead">
              <span data-slot="fork-usage-summary-figure">{cost(summary().cost)}</span>
              <span data-slot="fork-usage-summary-caption">{language.t("fork.usage.metric.cost")}</span>
            </div>
            <dl data-slot="fork-usage-summary-rest">
              <For
                each={[
                  { id: "requests", value: count(summary().requests) },
                  {
                    id: "input",
                    value: count(contextTokens(summary())),
                    // The cache share belongs to input, not beside it: it is the part of *this* number that
                    // was cheap, and standing alone it looked like a fifth unrelated statistic.
                    note: language.t("fork.usage.cached.pct", {
                      pct: (cacheHitRate(summary()) * 100).toFixed(0),
                    }),
                  },
                  { id: "output", value: count(summary().tokens.output) },
                ]}
              >
                {(item) => (
                  <div data-slot="fork-usage-summary-item">
                    <dt>{language.t(`fork.usage.metric.${item.id}`)}</dt>
                    <dd>
                      {item.value}
                      <Show when={item.note}>
                        <span data-slot="fork-usage-summary-note">{item.note}</span>
                      </Show>
                    </dd>
                  </div>
                )}
              </For>
            </dl>
          </header>

          <section data-slot="fork-usage-section">
            <header data-slot="fork-usage-section-head">
              <h3 data-slot="fork-usage-heading">{language.t("fork.usage.chart.title")}</h3>
              <p data-slot="fork-usage-hint">{language.t("fork.usage.chart.hint")}</p>
            </header>
            <UsageBarChart
              columns={columns()}
              requests={requestSeries()}
              cost={shaped().series}
              formatCost={cost}
              formatCount={count}
              onHover={setInspected}
              emptyLabel={waiting(usage.loading)}
              label={language.t("fork.usage.chart.label")}
            />
            <UsageReadout
              caption={
                inspected() === undefined
                  ? language.t(`fork.usage.range.whole.${range()}`)
                  : (columns()[inspected()!]?.label ?? "")
              }
              total={summary()}
              rows={readout()}
              columns={readoutColumns()}
            />
            <Show when={settled(usage)?.truncated}>
              <p data-slot="fork-usage-warning" role="status">
                {language.t("fork.usage.truncated")}
              </p>
            </Show>
          </section>

          <div data-slot="fork-usage-columns" data-single={scoped() ? "" : undefined}>
            <Show when={!scoped()}>
              <section data-slot="fork-usage-section">
                <header data-slot="fork-usage-section-head">
                  <h3 data-slot="fork-usage-heading">{language.t("fork.usage.projects.title")}</h3>
                </header>
                <UsageBars rows={projects()} formatValue={cost} emptyLabel={waiting(structure.loading)} />
              </section>
            </Show>

            <section data-slot="fork-usage-section">
              <header data-slot="fork-usage-section-head">
                <h3 data-slot="fork-usage-heading">{language.t("fork.usage.models.title")}</h3>
              </header>
              <UsageBars rows={models()} formatValue={cost} emptyLabel={waiting(usage.loading)} />
            </section>
          </div>

          {/*
            In the global view the calendar and the tree are the same question at two resolutions — which day,
            then which run — so they share a section. Scoped to a session there is no calendar, and the tree is
            the subject rather than the detail.
          */}
          <section data-slot="fork-usage-section">
            <header data-slot="fork-usage-section-head">
              <h3 data-slot="fork-usage-heading">
                {language.t(scoped() ? "fork.usage.sessions.title" : "fork.usage.heatmap.title")}
              </h3>
              <p data-slot="fork-usage-hint">
                {language.t(scoped() ? "fork.usage.sessions.hint" : "fork.usage.heatmap.hint")}
              </p>
            </header>

            <Show when={!scoped()}>
              <UsageHeatmap
                days={heatmapDays()}
                formatValue={cost}
                formatDay={(day) =>
                  new Date(day).toLocaleDateString(locale(), { year: "numeric", month: "short", day: "numeric" })
                }
                weekdayLabels={weekdays()}
                // Its own copy, because the calendar is all-history: "nothing in this range" would be wrong.
                emptyLabel={language.t(heatmap.loading ? "fork.usage.loading" : "fork.usage.heatmap.empty")}
                label={language.t("fork.usage.heatmap.label")}
              />
              <hr data-slot="fork-usage-rule" />
              <button
                type="button"
                data-slot="fork-usage-disclosure"
                aria-expanded={sessionsOpen()}
                onClick={() => setSessionsOpen(!sessionsOpen())}
              >
                {/* Wrapped because `Icon` sets its own `data-slot` after spreading props, so one passed in is
                    silently overwritten and the rotation below would never match. */}
                <span data-slot="fork-usage-disclosure-caret">
                  <Icon name="chevron-down" size="small" />
                </span>
                {language.t("fork.usage.sessions.title")}
                <span data-slot="fork-usage-disclosure-count">
                  {language.t("fork.usage.sessions.count", { count: String(sessionCount()) })}
                </span>
              </button>
            </Show>

            <Show when={scoped() || sessionsOpen()}>
              <UsageTree
                nodes={tree()}
                formatValue={cost}
                formatRequests={requestsNote}
                defaultOpen={scoped()}
                emptyLabel={waiting(structure.loading)}
              />
            </Show>
          </section>
        </Show>
      </div>
    </Dialog>
  )
}
