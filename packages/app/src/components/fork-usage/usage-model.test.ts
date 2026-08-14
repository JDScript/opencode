/** FORK-ONLY FILE — not present upstream, so it never conflicts on rebase. */
import { describe, expect, test } from "bun:test"
import type { UsageRow } from "@/utils/fork-api"
import {
  RANGES,
  alignBuckets,
  buildSessionTree,
  cacheHitRate,
  contextTokens,
  formatCost,
  formatCount,
  readoutTable,
  resolveRange,
  shapeSeries,
  totals,
  visibleNodes,
} from "./usage-model"

const DAY = 86_400_000
const HOUR = 3_600_000

const row = (input: Partial<UsageRow> & { cost?: number }): UsageRow => ({
  requests: input.requests ?? 1,
  cost: input.cost ?? 0,
  thinkingMs: input.thinkingMs ?? 0,
  tokens: input.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  ...input,
})

const preset = (id: string) => RANGES.find((entry) => entry.id === id)!

describe("resolveRange", () => {
  const now = new Date("2026-08-10T13:45:00").getTime()

  test("hour-bucketed presets roll back from now", () => {
    const range = resolveRange(preset("5h"), now)
    expect(range.bucketMs).toBe(HOUR)
    expect(now - range.from!).toBe(5 * HOUR)
  })

  test("day-bucketed presets cover whole local days, so the oldest column is not cut off", () => {
    const range = resolveRange(preset("7d"), now)
    expect(range.bucketMs).toBe(DAY)
    // Seven columns counting today, each starting at a local midnight.
    expect((range.originMs - range.from!) / DAY).toBe(6)
    expect(new Date(range.from!).getHours()).toBe(0)
  })

  test("all-time sends no lower bound", () => {
    expect(resolveRange(preset("all"), now).from).toBeUndefined()
  })

  test("hour buckets align to the local day, not to epoch zero", () => {
    // Epoch-aligned hours land on the half hour in +05:30 zones; a local-midnight origin never does.
    for (const id of ["5h", "1d", "7d", "30d", "all"]) {
      const range = resolveRange(preset(id), now)
      expect(new Date(range.originMs).getHours()).toBe(0)
      expect(new Date(range.originMs).getMinutes()).toBe(0)
    }
  })

  test("a shifted day boundary moves the origin, not the span", () => {
    const plain = resolveRange(preset("7d"), now)
    const shifted = resolveRange(preset("7d"), now, 4)
    expect(new Date(shifted.originMs).getHours()).toBe(4)
    expect(shifted.originMs - plain.originMs).toBe(4 * HOUR)
    expect((shifted.originMs - shifted.from!) / DAY).toBe(6)
  })
})

describe("totals", () => {
  test("sums every field", () => {
    const result = totals([
      row({ requests: 2, cost: 1.5, tokens: { input: 10, output: 20, reasoning: 3, cache: { read: 40, write: 5 } } }),
      row({ requests: 3, cost: 0.25, tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 4, write: 0 } } }),
    ])
    expect(result.requests).toBe(5)
    expect(result.cost).toBe(1.75)
    expect(result.tokens).toEqual({ input: 11, output: 22, reasoning: 3, cache: { read: 44, write: 5 } })
  })

  test("an empty set totals to zero rather than undefined", () => {
    expect(totals([]).cost).toBe(0)
    expect(totals([]).tokens.cache.read).toBe(0)
  })
})

describe("shapeSeries", () => {
  const cost = (entry: UsageRow) => entry.cost

  test("pivots onto a shared sorted bucket axis, filling gaps with zero", () => {
    const shaped = shapeSeries({
      rows: [
        row({ bucket: 200, cost: 2, modelID: "a" }),
        row({ bucket: 100, cost: 1, modelID: "a" }),
        row({ bucket: 200, cost: 5, modelID: "b" }),
      ],
      metric: cost,
      seriesOf: (entry) => ({ key: entry.modelID!, label: entry.modelID! }),
      otherLabel: "other",
      singleLabel: "all",
    })
    expect(shaped.columns).toEqual([100, 200])
    // Ordered by total, so the tallest series is first in the legend and tooltip.
    expect(shaped.series.map((entry) => entry.key)).toEqual(["b", "a"])
    expect(shaped.series.find((entry) => entry.key === "b")!.values).toEqual([0, 5])
    expect(shaped.series.find((entry) => entry.key === "a")!.values).toEqual([1, 2])
  })

  test("folds the tail into one remainder instead of dropping it", () => {
    const rows = Array.from({ length: 10 }, (_, index) =>
      row({ bucket: 0, cost: 10 - index, modelID: `model-${index}` }),
    )
    const shaped = shapeSeries({
      rows,
      metric: cost,
      seriesOf: (entry) => ({ key: entry.modelID!, label: entry.modelID! }),
      maxSeries: 3,
      otherLabel: "other",
      singleLabel: "all",
    })
    expect(shaped.series).toHaveLength(4)
    expect(shaped.truncatedSeries).toBe(7)
    // The chart must still add up to the totals shown beside it.
    const charted = shaped.series.reduce((sum, entry) => sum + entry.values[0], 0)
    expect(charted).toBe(totals(rows).cost)
  })

  test("without a series dimension it produces one line", () => {
    const shaped = shapeSeries({
      rows: [row({ bucket: 0, cost: 1 }), row({ bucket: 1, cost: 2 })],
      metric: cost,
      otherLabel: "other",
      singleLabel: "all",
    })
    expect(shaped.series).toHaveLength(1)
    expect(shaped.series[0].values).toEqual([1, 2])
    expect(shaped.truncatedSeries).toBe(0)
  })

  test("ungrouped rows collapse onto a single column rather than vanishing", () => {
    const shaped = shapeSeries({
      rows: [row({ cost: 1, agent: "build" }), row({ cost: 2, agent: "explore" })],
      metric: cost,
      seriesOf: (entry) => ({ key: entry.agent!, label: entry.agent! }),
      otherLabel: "other",
      singleLabel: "all",
    })
    expect(shaped.columns).toEqual([0])
    expect(shaped.series).toHaveLength(2)
  })
})

describe("shapeSeries ordering", () => {
  const rows = [
    row({ bucket: 0, cost: 100, requests: 2, modelID: "pricey" }),
    row({ bucket: 0, cost: 5, requests: 90, modelID: "cheap" }),
  ]
  const key = (entry: UsageRow) => ({ key: entry.modelID!, label: entry.modelID! })
  const shape = (metric: (entry: UsageRow) => number, order?: string[]) =>
    shapeSeries({ rows, metric, seriesOf: key, order, otherLabel: "other", singleLabel: "all" }).series.map(
      (entry) => entry.key,
    )

  test("ranks by its own metric when no order is given", () => {
    expect(shape((entry) => entry.cost)).toEqual(["pricey", "cheap"])
    expect(shape((entry) => entry.requests)).toEqual(["cheap", "pricey"])
  })

  test("a given order wins, so a segment sits at the same height in both stacked bars", () => {
    // The reason this exists: requests ranked by count and cost ranked by cost put the same model in
    // different positions, and then a segment cannot be traced from one bar to the other.
    const byCost = shape((entry) => entry.cost)
    expect(shape((entry) => entry.requests, byCost)).toEqual(byCost)
  })

  test("keys missing from the order keep their ranked place after the named ones", () => {
    expect(shape((entry) => entry.cost, ["cheap"])).toEqual(["cheap", "pricey"])
  })
})

describe("two stacks over one axis", () => {
  /**
   * The regression this exists for: the chart draws a cost stack and a request stack against the same axis, and
   * the readout under it indexes that axis. The dialog passed `columns` when shaping cost and forgot to when
   * shaping requests, so requests pivoted onto only the buckets that had rows. Every idle day then pulled the
   * request bars one column left of their own label — an empty Tuesday drew Thursday's requests, taller than the
   * bar beside it, while the readout for that column correctly reported nothing at all.
   */
  const days = [0, DAY, 2 * DAY, 3 * DAY]
  const rows = [
    row({ bucket: 0, cost: 8, requests: 30, modelID: "sol" }),
    // DAY is idle — no row at all, which is what the endpoint returns for it.
    row({ bucket: 2 * DAY, cost: 1, requests: 5, modelID: "sol" }),
    row({ bucket: 3 * DAY, cost: 4, requests: 90, modelID: "sol" }),
  ]
  const stack = (metric: (entry: UsageRow) => number, columns?: number[]) =>
    shapeSeries({
      rows,
      metric,
      seriesOf: (entry) => ({ key: entry.modelID!, label: entry.modelID! }),
      columns,
      otherLabel: "other",
      singleLabel: "all",
    })

  test("both stacks land on the axis they are given, gaps included", () => {
    const cost = stack((entry) => entry.cost, days)
    const requests = stack((entry) => entry.requests, days)
    expect(cost.columns).toEqual(days)
    expect(requests.columns).toEqual(days)
    expect(cost.series[0].values).toEqual([8, 0, 1, 4])
    expect(requests.series[0].values).toEqual([30, 0, 5, 90])
  })

  test("the stacks stay the same length, which the chart's tween relies on", () => {
    const cost = stack((entry) => entry.cost, days)
    const requests = stack((entry) => entry.requests, days)
    for (const series of [...cost.series, ...requests.series]) expect(series.values.length).toBe(days.length)
  })

  test("without the axis a stack compacts its gaps away — the shape of the original bug", () => {
    const loose = stack((entry) => entry.requests)
    expect(loose.columns).toEqual([0, 2 * DAY, 3 * DAY])
    // 90 requests sitting at index 2, which on the real axis is the idle day.
    expect(loose.series[0].values).toEqual([30, 5, 90])
  })
})

const treeRows = [
  row({
    sessionID: "root",
    sessionTitle: "Refactor",
    projectID: "p1",
    projectWorktree: "/dev/tavern",
    cost: 100,
    requests: 10,
    agent: "build",
  }),
  row({
    sessionID: "kid-a",
    sessionTitle: "Audit (@explore subagent)",
    parentSessionID: "root",
    projectID: "p1",
    projectWorktree: "/dev/tavern",
    cost: 40,
    requests: 4,
    agent: "explore",
  }),
  row({
    sessionID: "kid-b",
    sessionTitle: "Trace (@explore subagent)",
    parentSessionID: "root",
    projectID: "p1",
    projectWorktree: "/dev/tavern",
    cost: 5,
    requests: 1,
    agent: "explore",
  }),
  row({
    sessionID: "solo",
    sessionTitle: "Small fix",
    projectID: "p2",
    projectWorktree: "/dev/gateway/",
    cost: 7,
    requests: 2,
    agent: "build",
  }),
]

describe("buildSessionTree", () => {
  test("nests children under their parent, under their project", () => {
    const tree = buildSessionTree(treeRows, "none")
    expect(tree.map((node) => [node.kind, node.depth, node.label])).toEqual([
      ["project", 0, "tavern"],
      ["session", 1, "Refactor"],
      ["child", 2, "Audit (@explore subagent)"],
      ["child", 2, "Trace (@explore subagent)"],
      ["project", 0, "gateway"],
      ["session", 1, "Small fix"],
    ])
  })

  test("a project's total is its whole subtree, which is what projects are compared by", () => {
    const tree = buildSessionTree(treeRows, "none")
    const projects = tree.filter((node) => node.kind === "project")
    expect(projects[0].cost).toBe(145)
    expect(projects[0].requests).toBe(15)
    // Ordered by that total, so the project holding the money is first.
    expect(projects.map((node) => node.label)).toEqual(["tavern", "gateway"])
  })

  test("children are ranked by cost, so the expensive sub-agent is not buried", () => {
    const children = buildSessionTree(treeRows, "none").filter((node) => node.kind === "child")
    expect(children.map((node) => node.cost)).toEqual([40, 5])
  })

  test("keeps the dominant agent when one session spans several", () => {
    const tree = buildSessionTree(
      [
        row({ sessionID: "s", sessionTitle: "Mixed", projectID: "p", cost: 2, requests: 1, agent: "explore" }),
        row({ sessionID: "s", sessionTitle: "Mixed", projectID: "p", cost: 9, requests: 3, agent: "build" }),
      ],
      "none",
    )
    const session = tree.find((node) => node.kind === "session")!
    expect(session.agent).toBe("build")
    // And the split rows are summed back together rather than appearing twice.
    expect(session.cost).toBe(11)
    expect(session.requests).toBe(4)
    expect(tree.filter((node) => node.kind === "session")).toHaveLength(1)
  })

  test("a child whose parent is outside the range is promoted, never dropped", () => {
    const tree = buildSessionTree(
      [row({ sessionID: "orphan", sessionTitle: "Orphan", parentSessionID: "gone", projectID: "p", cost: 3 })],
      "none",
    )
    expect(tree.filter((node) => node.kind === "session").map((node) => node.label)).toEqual(["Orphan"])
    expect(tree.find((node) => node.kind === "project")!.cost).toBe(3)
  })

  test("every row names the node that gates it, so the tree can cascade", () => {
    const tree = buildSessionTree(treeRows, "none")
    const project = tree.find((node) => node.kind === "project" && node.label === "tavern")!
    const session = tree.find((node) => node.kind === "session" && node.label === "Refactor")!
    const child = tree.find((node) => node.kind === "child")!

    // Projects are always visible; a session waits on its project, a sub-agent on its session.
    expect(project.parentKey).toBeUndefined()
    expect(session.parentKey).toBe(project.key)
    expect(child.parentKey).toBe(session.key)
  })

  test("only nodes with something under them offer a disclosure", () => {
    const tree = buildSessionTree(treeRows, "none")
    expect(tree.find((node) => node.label === "tavern")!.hasChildren).toBe(true)
    expect(tree.find((node) => node.label === "Refactor")!.hasChildren).toBe(true)
    // A lone session in its own project, and a sub-agent, have nothing to expand.
    expect(tree.find((node) => node.label === "Small fix")!.hasChildren).toBe(false)
    expect(tree.find((node) => node.kind === "child")!.hasChildren).toBe(false)
  })

  test("carries the aggregate row, so a panel can derive any figure from a node", () => {
    const project = buildSessionTree(treeRows, "none").find((node) => node.label === "tavern")!
    expect(project.row.cost).toBe(145)
    expect(project.row.requests).toBe(15)
  })

  test("accounts for every row it is given", () => {
    const tree = buildSessionTree(treeRows, "none")
    const projects = tree.filter((node) => node.kind === "project")
    expect(projects.reduce((sum, node) => sum + node.cost, 0)).toBe(totals(treeRows).cost)
  })

  test("names a project with no worktree rather than leaving it blank", () => {
    const tree = buildSessionTree([row({ sessionID: "s", cost: 1 })], "Outside a repository")
    expect(tree[0].label).toBe("Outside a repository")
  })
})

describe("alignBuckets", () => {
  const at = (iso: string) => new Date(iso).getTime()
  const localMidnight = (ms: number) => {
    const date = new Date(ms)
    return date.getHours() === 0 && date.getMinutes() === 0
  }

  test("folds hours into days on true local boundaries", () => {
    const result = alignBuckets({
      rows: [
        row({ bucket: at("2026-08-10T09:00"), cost: 1 }),
        row({ bucket: at("2026-08-10T22:00"), cost: 2 }),
        row({ bucket: at("2026-08-11T03:00"), cost: 4 }),
      ],
      granularity: "day",
    })
    expect(result.columns).toHaveLength(2)
    expect(result.columns.every(localMidnight)).toBe(true)
    // The two hours of the 10th land on the same column; the 11th on its own.
    const byBucket = new Map<number, number>()
    for (const entry of result.rows) byBucket.set(entry.bucket!, (byBucket.get(entry.bucket!) ?? 0) + entry.cost)
    expect([...byBucket.values()].sort((a, b) => a - b)).toEqual([3, 4])
  })

  test("every day column is a real local midnight, DST transitions included", () => {
    // The bug this exists for: the server's day bucket is a fixed 86400000 stride, so past a transition its
    // keys are 23:00 rather than midnight — a client computing true midnights then looked up keys the server
    // never emitted and those days vanished from the calendar. Folding here makes the boundary exact.
    for (const span of [
      ["2026-03-06T12:00", "2026-03-10T12:00"],
      ["2026-10-30T12:00", "2026-11-03T12:00"],
    ]) {
      const result = alignBuckets({
        rows: [row({ bucket: at(span[0]), cost: 1 }), row({ bucket: at(span[1]), cost: 1 })],
        granularity: "day",
      })
      expect(result.columns.every(localMidnight)).toBe(true)
      // Calendar stepping, so a 23- or 25-hour day still advances exactly one column.
      expect(result.columns).toHaveLength(5)
    }
  })

  test("the axis covers the whole range, including buckets with no rows", () => {
    // 21 calendar days holding 2 active days must draw 21 columns. Collecting the distinct buckets present drew
    // 2 adjacent ones and claimed they were neighbours.
    const result = alignBuckets({
      rows: [row({ bucket: at("2026-07-24T10:00"), cost: 1 }), row({ bucket: at("2026-08-04T10:00"), cost: 1 })],
      granularity: "day",
      from: at("2026-07-21T00:00"),
      to: at("2026-08-10T00:00"),
    })
    expect(result.columns).toHaveLength(21)
    expect(result.columns.every(localMidnight)).toBe(true)
  })

  test("hour granularity keeps the hour and still fills the gaps", () => {
    const result = alignBuckets({
      rows: [row({ bucket: at("2026-08-10T09:00"), cost: 1 })],
      granularity: "hour",
      from: at("2026-08-10T08:00"),
      to: at("2026-08-10T12:00"),
    })
    expect(result.columns).toHaveLength(5)
    expect(result.rows[0].bucket).toBe(at("2026-08-10T09:00"))
  })

  test("no rows and no range produces nothing rather than a stray column", () => {
    expect(alignBuckets({ rows: [], granularity: "day" })).toEqual({ columns: [], rows: [] })
  })
})

describe("readoutTable", () => {
  const series = [
    { key: "sol", label: "gpt-5.6-sol" },
    { key: "opus", label: "claude-opus-5" },
    { key: "luna", label: "gpt-5.6-luna" },
  ]
  const sample = [
    row({ bucket: 100, cost: 10, requests: 5, modelID: "sol" }),
    row({ bucket: 100, cost: 3, requests: 8, modelID: "opus" }),
    row({ bucket: 200, cost: 1, requests: 2, modelID: "sol" }),
    // Used weeks earlier and never again — the row that exposed the bug.
    row({ bucket: 900, cost: 0.5, requests: 4, modelID: "luna" }),
  ]
  const table = (bucket?: number) => readoutTable({ rows: sample, series, keyOf: (entry) => entry.modelID!, bucket })

  test("aggregates the whole range when no bucket is named, and marks nothing idle", () => {
    const result = table()
    expect(result.map((entry) => [entry.label, entry.row.requests, entry.row.cost])).toEqual([
      ["gpt-5.6-sol", 7, 11],
      ["claude-opus-5", 8, 3],
      ["gpt-5.6-luna", 4, 0.5],
    ])
    expect(result.every((entry) => !entry.idle)).toBe(true)
  })

  test("a series absent from the inspected bucket reads zero, not its range total", () => {
    // The bug: hovering a column that used two models still listed the third with the figures it had earned
    // weeks earlier, because a missing entry fell back to the range aggregate.
    const luna = table(100).find((entry) => entry.label === "gpt-5.6-luna")!
    expect(luna.row.requests).toBe(0)
    expect(luna.row.cost).toBe(0)
    expect(luna.idle).toBe(true)
  })

  test("rows stay the range's series in the range's order, whatever the bucket holds", () => {
    for (const bucket of [undefined, 100, 200, 900, 12345]) {
      expect(table(bucket).map((entry) => entry.label)).toEqual(["gpt-5.6-sol", "claude-opus-5", "gpt-5.6-luna"])
    }
  })

  test("an inspected bucket reports only that bucket", () => {
    const sol = table(200).find((entry) => entry.label === "gpt-5.6-sol")!
    expect(sol.row.requests).toBe(2)
    expect(sol.row.cost).toBe(1)
    expect(sol.idle).toBe(false)
  })

  test("a bucket with nothing in it marks every row idle rather than emptying the table", () => {
    const result = table(12345)
    expect(result).toHaveLength(3)
    expect(result.every((entry) => entry.idle)).toBe(true)
  })
})

describe("visibleNodes", () => {
  const tree = buildSessionTree(treeRows, "none")
  const project = tree.find((node) => node.label === "tavern")!
  const session = tree.find((node) => node.label === "Refactor")!
  const labels = (open: string[]) => visibleNodes(tree, (key) => open.includes(key)).map((node) => node.label)

  test("only projects show when nothing is open", () => {
    expect(labels([])).toEqual(["tavern", "gateway"])
  })

  test("opening a project reveals its sessions but not their sub-agents", () => {
    expect(labels([project.key])).toEqual(["tavern", "Refactor", "gateway"])
  })

  test("opening a session reveals its sub-agents", () => {
    expect(labels([project.key, session.key])).toEqual([
      "tavern",
      "Refactor",
      "Audit (@explore subagent)",
      "Trace (@explore subagent)",
      "gateway",
    ])
  })

  test("every parent open shows every node — what the session view starts from", () => {
    // The session view seeds the open set with every node that has children, so this is the state it opens in.
    const parents = tree.filter((node) => node.hasChildren).map((node) => node.key)
    expect(labels(parents)).toEqual(tree.map((node) => node.label))
  })

  test("closing an ancestor hides everything under it, however deep", () => {
    // The bug this exists for: with only the immediate parent checked, the sub-agents stayed on screen after
    // the project closed, because their session was still marked open even though it had vanished.
    expect(labels([session.key])).toEqual(["tavern", "gateway"])
  })
})

describe("derived token figures", () => {
  const sample = row({
    tokens: { input: 181625, output: 739981, reasoning: 0, cache: { read: 175711918, write: 4851389 } },
  })

  test("context folds cache reads in, because input alone understates it a thousandfold", () => {
    expect(contextTokens(sample)).toBe(181625 + 175711918)
  })

  test("cache hit rate is the share of context that was cached", () => {
    expect(Math.round(cacheHitRate(sample) * 1000) / 10).toBe(97.2)
    expect(cacheHitRate(row({}))).toBe(0)
  })
})

describe("formatting", () => {
  test("counts go compact past a thousand", () => {
    expect(formatCount(999, "en-US")).toBe("999")
    expect(formatCount(175711918, "en-US")).toBe("175.7M")
    expect(formatCount(0, "en-US")).toBe("0")
  })

  test("a real cost never displays as zero", () => {
    // The property that matters: anything non-zero must not read as "$0.00", or the chart claims nothing
    // happened in a bucket that did cost something.
    for (const value of [0.0004, 0.001, 0.004]) {
      expect(formatCost(value, "en-US")).not.toBe("$0.00")
    }
    expect(formatCost(0.0004, "en-US")).toBe("$0.0004")
    // At or above a cent, the ordinary two places — the common case stays quiet.
    expect(formatCost(0.078, "en-US")).toBe("$0.08")
    expect(formatCost(204.0577, "en-US")).toBe("$204.06")
    expect(formatCost(0, "en-US")).toBe("$0.00")
  })
})
