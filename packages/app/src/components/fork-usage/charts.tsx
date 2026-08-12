/**
 * FORK-ONLY FILE — not present upstream, so it never conflicts on rebase.
 *
 * The dashboard's two SVG views: the requests-and-cost bar chart, and the calendar heatmap.
 *
 * Every colour is a `var(--...)` token, never a literal and never read through `getComputedStyle`. That is
 * the reason these are SVG: the app ships 37 themes in light and dark, and `theme/context.tsx` previews a
 * theme live while the pointer moves down the list. A token in a `fill` attribute re-resolves for all of that
 * with no JavaScript; a canvas chart would re-read its palette and redraw on three separate reactive sources.
 */
import { createMemo, createSignal, For, Show, type JSX } from "solid-js"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { createTween, pairedTicks } from "./chart-math"
import "./charts.css"

/**
 * Model segments as one hue at descending strength, not as separate hues.
 *
 * The first version used `--syntax-info` / `success` / `warning` / `property`, which paints a rainbow across
 * what is really one measure split into parts — blue and green segments read as unrelated categories rather
 * than as shares of the same money. A single-hue ramp says "one quantity, divided", and it also survives all
 * 37 themes: it needs one token instead of four that no theme guarantees are distinguishable from each other.
 */
const SEGMENT_STRENGTH = [1, 0.72, 0.5, 0.34, 0.22, 0.14] as const

export const segmentOpacity = (index: number) => SEGMENT_STRENGTH[Math.min(index, SEGMENT_STRENGTH.length - 1)]

export type ChartColumn = {
  /** Full label, for the tooltip. */
  label: string
  /** Abbreviated label for the axis; only some are drawn, depending on width. */
  short: string
}

export type Series = {
  key: string
  label: string
  /** One value per column. */
  values: number[]
}

const PADDING = { top: 10, right: 54, bottom: 22, left: 48 }

/** Measured so the SVG can use a 1-unit-per-pixel viewBox; scaling a fixed one distorts text and strokes. */
function createWidth(initial = 640) {
  const [element, setElement] = createSignal<HTMLElement>()
  const [width, setWidth] = createSignal(initial)
  createResizeObserver(element, ({ width: measured }) => {
    if (measured > 0) setWidth(measured)
  })
  return { setElement, width }
}

/**
 * Requests and cost per period, side by side on two scales.
 *
 * Two bars per period rather than one, because the interesting thing is when they disagree: 376 requests
 * costing $141 next to 644 costing $62 is the whole story of which model is worth running, and no single
 * series shows it. The two scales are the price of that comparison — their bar *heights* are not comparable
 * to each other, only each series against itself across time — so both axes are labelled, on opposite sides,
 * sharing one grid.
 *
 * Both bars are split by the same models on the same ramp, so a segment can be traced across from one to the
 * other: the model that is a thin slice of the request bar and a thick slice of the cost bar is the expensive
 * one, and that reading is the point of showing the two together.
 */
export function UsageBarChart(props: {
  columns: ChartColumn[]
  requests: Series[]
  cost: Series[]
  formatCost: (value: number) => string
  formatCount: (value: number) => string
  /**
   * Which column the pointer is over, or undefined on leaving.
   *
   * The chart reports the hover rather than describing it. What a reader wants to see about a column — cost and
   * requests per model, and the token split behind them — is more than the chart's own geometry knows, and the
   * caller already holds the rows it would take. So the chart owns the bars, the axes and hit detection, and
   * nothing else.
   */
  onHover?: (index: number | undefined) => void
  height?: number
  emptyLabel: string
  label: string
}): JSX.Element {
  const { setElement, width } = createWidth()
  const [hovered, setHovered] = createSignal<number>()
  const height = () => props.height ?? 190

  const plot = createMemo(() => ({
    left: PADDING.left,
    top: PADDING.top,
    width: Math.max(1, width() - PADDING.left - PADDING.right),
    height: Math.max(1, height() - PADDING.top - PADDING.bottom),
  }))

  const stackTotals = (series: Series[]) =>
    props.columns.map((_, index) => series.reduce((sum, segment) => sum + (segment.values[index] ?? 0), 0))
  const requestTotals = createMemo(() => stackTotals(props.requests))
  const costTotals = createMemo(() => stackTotals(props.cost))

  const ticks = createMemo(() => pairedTicks(Math.max(0, ...requestTotals()), Math.max(0, ...costTotals()), 4))
  const ceiling = (side: "left" | "right") => {
    const all = ticks()[side]
    return (all?.[all.length - 1] ?? 0) || 1
  }

  /** Flattened into one tween so every segment of every bar in a column grows together. */
  const flat = createMemo(() => [
    ...props.requests.flatMap((entry) => entry.values),
    ...props.cost.flatMap((entry) => entry.values),
  ])
  const eased = createTween(flat)
  const unflatten = (series: Series[], offset: number) => {
    const values = eased()
    const span = props.columns.length
    return series.map((segment, index) => ({
      ...segment,
      values: values.slice(offset + index * span, offset + (index + 1) * span),
    }))
  }
  const easedRequests = createMemo(() => unflatten(props.requests, 0))
  const easedCost = createMemo(() => unflatten(props.cost, props.requests.length * props.columns.length))

  const slot = () => plot().width / Math.max(1, props.columns.length)
  /** Two bars in 62% of the slot, so adjacent periods stay visually separate. */
  const barWidth = () => Math.max(2, (slot() * 0.62) / 2)
  const slotCenter = (index: number) => plot().left + slot() * (index + 0.5)
  const y = (value: number, side: "left" | "right") =>
    plot().top + plot().height - (value / ceiling(side)) * plot().height

  const axisLabels = createMemo(() => {
    const columns = props.columns.length
    if (columns === 0) return []
    const stride = Math.max(1, Math.ceil(columns / Math.max(2, Math.floor(plot().width / 58))))
    return props.columns
      .map((column, index) => ({ column, index }))
      .filter(({ index }) => index % stride === 0 || index === columns - 1)
  })

  const pick = (event: PointerEvent & { currentTarget: SVGRectElement }) => {
    const box = event.currentTarget.getBoundingClientRect()
    if (props.columns.length === 0) return
    const ratio = (event.clientX - box.left) / Math.max(1, box.width)
    const index = Math.min(props.columns.length - 1, Math.max(0, Math.floor(ratio * props.columns.length)))
    if (index === hovered()) return
    setHovered(index)
    props.onHover?.(index)
  }

  const leave = () => {
    setHovered(undefined)
    props.onHover?.(undefined)
  }

  const empty = createMemo(
    () =>
      props.columns.length === 0 ||
      (requestTotals().every((value) => value === 0) && costTotals().every((value) => value === 0)),
  )

  return (
    <div data-component="fork-usage-chart" ref={(element) => setElement(element)}>
      <Show
        when={!empty()}
        fallback={
          <div data-slot="fork-usage-chart-empty" role="status" style={{ height: `${height()}px` }}>
            {props.emptyLabel}
          </div>
        }
      >
        {/* The plot owns the fixed height; the readout below it is in normal flow. Giving the whole component
            the height made the readout overflow its box and collide with whatever followed. */}
        <div data-slot="fork-usage-plot" style={{ height: `${height()}px` }}>
          <svg
            width={width()}
            height={height()}
            viewBox={`0 0 ${width()} ${height()}`}
            role="img"
            aria-label={props.label}
          >
            <g aria-hidden="true">
              <For each={ticks().left}>
                {(tick, index) => (
                  <>
                    <line
                      data-slot="fork-usage-gridline"
                      x1={plot().left}
                      x2={plot().left + plot().width}
                      y1={y(tick, "left")}
                      y2={y(tick, "left")}
                    />
                    <text data-slot="fork-usage-axis-y" x={plot().left - 8} y={y(tick, "left")}>
                      {props.formatCount(tick)}
                    </text>
                    {/* Only when the cost axis has a scale at all. A range whose every model was free has
                        none, and labelling it anyway repeated one `$0.00` per gridline, stacked on the
                        baseline. */}
                    {/* Guarded on the array, not on the value: the first tick is 0, and a falsy `when` would
                        drop the right axis's baseline label while keeping every one above it. */}
                    <Show when={ticks().right}>
                      {(costTicks) => (
                        <text
                          data-slot="fork-usage-axis-y2"
                          x={plot().left + plot().width + 8}
                          y={y(costTicks()[index()] ?? 0, "right")}
                        >
                          {props.formatCost(costTicks()[index()] ?? 0)}
                        </text>
                      )}
                    </Show>
                  </>
                )}
              </For>

              <For each={axisLabels()}>
                {({ column, index }) => (
                  <text data-slot="fork-usage-axis-x" x={slotCenter(index)} y={height() - 6}>
                    {column.short}
                  </text>
                )}
              </For>

              <For each={props.columns}>
                {(_, index) => {
                  const stack = (series: Array<{ values: number[] }>, order: number, side: "left" | "right") => {
                    const below = series.slice(0, order).reduce((sum, other) => sum + (other.values[index()] ?? 0), 0)
                    const top = y(below + (series[order].values[index()] ?? 0), side)
                    return { top, height: Math.max(0, y(below, side) - top) }
                  }
                  return (
                    <g data-hovered={hovered() === index() ? "" : undefined}>
                      <For each={easedRequests()}>
                        {(_segment, order) => {
                          const box = () => stack(easedRequests(), order(), "left")
                          return (
                            <rect
                              data-slot="fork-usage-bar-requests"
                              style={{ opacity: String(segmentOpacity(order())) }}
                              x={slotCenter(index()) - barWidth() - 1}
                              y={box().top}
                              width={barWidth()}
                              height={box().height}
                            />
                          )
                        }}
                      </For>
                      {/* Stacked from the bottom, largest segment first, so the ramp reads strong to faint upward. */}
                      <For each={easedCost()}>
                        {(_segment, order) => {
                          const box = () => stack(easedCost(), order(), "right")
                          return (
                            <rect
                              data-slot="fork-usage-bar-cost"
                              style={{ opacity: String(segmentOpacity(order())) }}
                              x={slotCenter(index()) + 1}
                              y={box().top}
                              width={barWidth()}
                              height={box().height}
                            />
                          )
                        }}
                      </For>
                    </g>
                  )
                }}
              </For>
            </g>

            <rect
              data-slot="fork-usage-hit"
              x={plot().left}
              y={plot().top}
              width={plot().width}
              height={plot().height}
              onPointerMove={pick}
              onPointerLeave={leave}
            />
          </svg>
        </div>
      </Show>
    </div>
  )
}

export type HeatmapDay = {
  /** Epoch ms of the local day boundary, from `localDayOrigin`. */
  day: number
  value: number
}

const HEATMAP_LEVELS = 4

/**
 * Thresholds from the quantiles of the active days, not from a fraction of the maximum.
 *
 * Real usage is extremely uneven — one day held 75% of a whole history's spend — so linear thresholds paint
 * that day dark and every other active day indistinguishably pale. Quantiles keep the quiet days legible,
 * which is what a calendar is for.
 */
function heatmapThresholds(values: number[]): number[] {
  const active = values.filter((value) => value > 0).sort((a, b) => a - b)
  if (active.length === 0) return []
  return Array.from({ length: HEATMAP_LEVELS - 1 }, (_, index) => {
    const position = ((index + 1) / HEATMAP_LEVELS) * (active.length - 1)
    return active[Math.round(position)]
  })
}

const CELL_GAP = 3
const MIN_CELL = 10
/** A year of columns, the most a calendar of days is ever asked to show. */
const MAX_WEEKS = 53

export function UsageHeatmap(props: {
  days: HeatmapDay[]
  formatValue: (value: number) => string
  formatDay: (day: number) => string
  weekdayLabels: string[]
  emptyLabel: string
  label: string
}): JSX.Element {
  const [hovered, setHovered] = createSignal<HeatmapDay>()
  const { setElement, width } = createWidth(560)

  const byDay = createMemo(() => new Map(props.days.map((entry) => [entry.day, entry.value])))
  const thresholds = createMemo(() => heatmapThresholds(props.days.map((entry) => entry.value)))

  const level = (value: number) => {
    if (value <= 0) return 0
    let result = 1
    for (const cut of thresholds()) if (value > cut) result++
    return Math.min(HEATMAP_LEVELS, result)
  }

  /**
   * Columns and cell size both come from the measured width, so the grid fills the card.
   *
   * Sizing it to the data's own span was the previous attempt and it was worse: nineteen days of history gave
   * twelve columns of fifteen pixels, which used 200 of 678 available and left 70% of the card blank. Empty
   * *columns* are fine — a quiet fortnight should look quiet — but empty *space* reads as a layout fault.
   *
   * So: as many weeks as fit at a legible size, up to a year, then the cell size divided out exactly so the
   * last column lands on the right edge. A narrow card shows fewer weeks rather than scrolling.
   */
  const available = () => Math.max(120, width() - 22)
  const weekCount = createMemo(() =>
    Math.min(MAX_WEEKS, Math.max(8, Math.floor((available() + CELL_GAP) / (MIN_CELL + CELL_GAP)))),
  )
  const cell = createMemo(() =>
    Math.max(MIN_CELL, Math.floor((available() - (weekCount() - 1) * CELL_GAP) / weekCount())),
  )

  /**
   * Weeks ending on the week that holds the newest day, each column a real Sunday-to-Saturday week.
   *
   * Built forward from a Sunday rather than backward from the newest day. Counting back and chunking by seven
   * only lines up with the weekday labels when the newest day happens to *be* a Saturday — on the other six
   * days every square sat in the wrong labelled row, and the trailing partial week pushed an extra column past
   * the measured width into a scroll container whose bar is hidden.
   *
   * `setDate` throughout, so a 23- or 25-hour day still advances exactly one cell.
   */
  const columns = createMemo(() => {
    const days = props.days
    if (days.length === 0) return []
    const newest = new Date(Math.max(...days.map((entry) => entry.day)))

    // The Saturday closing the newest day's week, then back to the Sunday that opens the first column.
    const end = new Date(newest)
    end.setDate(end.getDate() + (6 - end.getDay()))
    const start = new Date(end)
    start.setDate(start.getDate() - (weekCount() * 7 - 1))

    const weeks: Array<Array<{ day: number; value: number; inRange: boolean }>> = []
    const cursor = new Date(start)
    for (let week = 0; week < weekCount(); week++) {
      const column: Array<{ day: number; value: number; inRange: boolean }> = []
      for (let weekday = 0; weekday < 7; weekday++) {
        const day = cursor.getTime()
        const value = byDay().get(day)
        // Days after the newest one are drawn as gaps, not as zeros: nothing has happened in them yet.
        column.push({ day, value: value ?? 0, inRange: day <= newest.getTime() })
        cursor.setDate(cursor.getDate() + 1)
      }
      weeks.push(column)
    }
    return weeks
  })

  return (
    <div
      data-component="fork-usage-heatmap"
      ref={(element) => setElement(element)}
      style={{ "--fork-usage-cell": `${cell()}px`, "--fork-usage-cell-gap": `${CELL_GAP}px` }}
    >
      <Show
        when={props.days.length > 0}
        fallback={
          <div data-slot="fork-usage-chart-empty" role="status">
            {props.emptyLabel}
          </div>
        }
      >
        <div data-slot="fork-usage-heatmap-body" role="img" aria-label={props.label}>
          <div data-slot="fork-usage-heatmap-weekdays" aria-hidden="true">
            <For each={props.weekdayLabels}>{(weekday) => <span>{weekday}</span>}</For>
          </div>
          <div data-slot="fork-usage-heatmap-grid" onPointerLeave={() => setHovered(undefined)}>
            <For each={columns()}>
              {(week) => (
                <div data-slot="fork-usage-heatmap-week">
                  <For each={week}>
                    {(square) => (
                      <button
                        type="button"
                        data-slot="fork-usage-heatmap-cell"
                        data-level={square.inRange ? level(square.value) : "out"}
                        aria-label={`${props.formatDay(square.day)}: ${props.formatValue(square.value)}`}
                        onPointerEnter={() => setHovered(square)}
                        onFocus={() => setHovered(square)}
                      />
                    )}
                  </For>
                </div>
              )}
            </For>
          </div>
        </div>
        <div data-slot="fork-usage-heatmap-footer">
          <div data-slot="fork-usage-heatmap-readout" role="status">
            <Show when={hovered()} fallback={<span data-slot="fork-usage-muted">—</span>}>
              {(current) => (
                <>
                  <span data-slot="fork-usage-muted">{props.formatDay(current().day)}</span>
                  <span>{props.formatValue(current().value)}</span>
                </>
              )}
            </Show>
          </div>
          <div data-slot="fork-usage-heatmap-legend" aria-hidden="true">
            <For each={[0, 1, 2, 3, 4]}>{(step) => <span data-slot="fork-usage-heatmap-cell" data-level={step} />}</For>
          </div>
        </div>
      </Show>
    </div>
  )
}
