/**
 * FORK-ONLY FILE — not present upstream, so it never conflicts on rebase.
 *
 * Geometry and easing for the usage charts, kept apart from the components so it can be tested.
 *
 * Hand-rolled rather than pulled from a library because the two requirements the charts have — follow all
 * 37 themes including live preview, and animate — are both free in SVG + CSS and both cost work in a
 * canvas library: `stroke="var(--syntax-info)"` re-resolves on a theme switch with no JavaScript at all,
 * while a canvas chart has to read every colour through `getComputedStyle` and redraw on three separate
 * reactive sources. The one library already resolved in the lockfile (chart.js, via the Zen console) is
 * canvas, and cannot draw a calendar heatmap at all without a further plugin.
 */
import { createSignal, createEffect, on, onCleanup, untrack, type Accessor } from "solid-js"

/**
 * Axis ticks from 0 up to **at or above** `max`, on a 1/2/5×10ⁿ step.
 *
 * The last tick covering `max` is the point: it is the top gridline, so a tick set that stops short of the
 * data leaves the line drawn outside the plot area.
 *
 * The step rounds the rough interval to the *nearest* nice number rather than up (Heckbert's thresholds
 * 1.5/3/7). Rounding up is coarser than it looks — a 0–100 axis asked for four intervals would land on a
 * step of 50 and produce three gridlines.
 *
 * Values are re-rounded through `toPrecision` because a fractional step carries visible float noise:
 * three steps of 0.1 otherwise labels a tick `0.30000000000000004`.
 */
export function niceTicks(max: number, count = 4): number[] {
  if (!Number.isFinite(max) || max <= 0) return [0]
  const rough = max / Math.max(1, count)
  const magnitude = 10 ** Math.floor(Math.log10(rough))
  const normalized = rough / magnitude
  const step = (normalized <= 1.5 ? 1 : normalized <= 3 ? 2 : normalized <= 7 ? 5 : 10) * magnitude
  // Subnormal maxima underflow `magnitude` to zero, and a zero step makes `last` Infinity and the loop below
  // endless. Unreachable from a cost or a request count, but the guard is one line and the test name promises it.
  if (!(step > 0)) return [0]
  const last = Math.ceil(max / step)
  const ticks: number[] = []
  for (let index = 0; index <= last; index++) {
    ticks.push(Number((index * step).toPrecision(12)))
  }
  return ticks
}

/**
 * Two axes that share one set of gridlines.
 *
 * Requests and dollars need separate scales, but drawing each one's own gridlines would put two grids over
 * the same plot. Each axis keeps its own nice step and both are extended to the same number of intervals, so
 * one grid serves both and every label still lands on a round number. Extending the shorter axis raises its
 * ceiling a little, which only ever leaves more headroom above the tallest bar.
 */
export function pairedTicks(left: number, right: number, count = 4): { left: number[]; right: number[] | undefined } {
  const first = niceTicks(left, count)
  const second = niceTicks(right, count)
  const intervals = Math.max(first.length, second.length) - 1
  const extend = (ticks: number[]) => {
    const step = ticks[1] ?? 0
    // Nothing to scale: a side whose maximum is zero has no step to extend, and stretching it anyway produced a
    // one-element array against a seven-element one — the caller then drew the same `$0.00` seven times, stacked
    // on the baseline. `undefined` says "this axis has no scale", which the caller can render as no axis.
    if (step <= 0) return undefined
    return Array.from({ length: intervals + 1 }, (_, index) => Number((index * step).toPrecision(12)))
  }
  return { left: extend(first) ?? [0], right: extend(second) }
}

/**
 * Eases an array of values toward its target, so a redraw morphs rather than jumps.
 *
 * In JavaScript rather than `transition: d` on the path for two reasons: Firefox does not animate the `d`
 * property at all, and even where it does the transition is silently skipped whenever the number of path
 * commands changes — which is exactly what a range switch does. Follows the same reduced-motion rule as
 * fork-session-scanner: hold the final state instead of animating toward it.
 */
export function createTween(target: Accessor<number[]>, durationMs = 320): Accessor<number[]> {
  const [current, setCurrent] = createSignal(target())
  let frame: number | undefined

  const cancel = () => {
    if (frame !== undefined) cancelAnimationFrame(frame)
    frame = undefined
  }

  createEffect(
    on(target, (next) => {
      // untrack: reading the tween's own output as the animation's starting point must not make this
      // effect depend on it, or every frame would retrigger the effect that produced it.
      const from = untrack(current)
      const media = typeof window === "undefined" ? undefined : window.matchMedia?.("(prefers-reduced-motion: reduce)")
      const reduced = media?.matches ?? false

      cancel()
      // Different lengths have no point-to-point correspondence to interpolate along. Snap; the next
      // change animates normally.
      if (reduced || from.length !== next.length) {
        setCurrent([...next])
        return
      }

      const start = performance.now()
      const step = (now: number) => {
        const progress = Math.min(1, (now - start) / durationMs)
        const eased = 1 - (1 - progress) ** 3
        if (progress < 1) {
          setCurrent(from.map((value, index) => value + (next[index] - value) * eased))
          frame = requestAnimationFrame(step)
          return
        }
        frame = undefined
        setCurrent([...next])
      }
      frame = requestAnimationFrame(step)
    }),
  )

  onCleanup(cancel)
  return current
}
