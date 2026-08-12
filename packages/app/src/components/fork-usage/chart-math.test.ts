/** FORK-ONLY FILE — not present upstream, so it never conflicts on rebase. */
import { describe, expect, test } from "bun:test"
import { niceTicks, pairedTicks } from "./chart-math"

describe("niceTicks", () => {
  test("steps on 1/2/5 x 10^n and always starts at zero", () => {
    expect(niceTicks(100, 4)).toEqual([0, 20, 40, 60, 80, 100])
    expect(niceTicks(9, 4)).toEqual([0, 2, 4, 6, 8, 10])
    expect(niceTicks(1, 4)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1])
  })

  test("the top tick always reaches the maximum, so bars stay inside the plot", () => {
    // 42 is the case that caught the original off-by-one: a step of 10 stopping at 40 put the top
    // gridline below the data and drew the series outside the chart.
    for (const max of [0.3, 7, 42, 153.2922, 175711918]) {
      const ticks = niceTicks(max)
      expect(ticks[0]).toBe(0)
      expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(max)
    }
  })

  test("carries no float noise into labels", () => {
    // A step of 0.1 accumulated with += would produce 0.30000000000000004 here.
    for (const tick of niceTicks(0.5, 5)) expect(String(tick).length).toBeLessThanOrEqual(4)
  })

  test("degenerates safely rather than looping forever", () => {
    expect(niceTicks(0)).toEqual([0])
    expect(niceTicks(-5)).toEqual([0])
    expect(niceTicks(Number.NaN)).toEqual([0])
    expect(niceTicks(Number.POSITIVE_INFINITY)).toEqual([0])
  })
})

describe("pairedTicks", () => {
  test("both axes get the same number of intervals, so one grid serves both", () => {
    const { left, right } = pairedTicks(1183, 28.03, 4)
    expect(right).toBeDefined()
    expect(left.length).toBe(right!.length)
  })

  test("each axis keeps its own round step", () => {
    const { left, right } = pairedTicks(1183, 28.03, 4)
    const step = (ticks: number[]) => ticks[1] - ticks[0]
    // Every tick is a whole multiple of that axis's own step — no interpolated in-between labels.
    for (const ticks of [left, right!]) {
      for (const [index, tick] of ticks.entries()) {
        expect(tick).toBeCloseTo(index * step(ticks), 6)
      }
    }
  })

  test("extending the shorter axis only ever adds headroom", () => {
    // 9 alone wants ticks to 10; paired with a value needing six intervals it must still cover 9.
    const { left, right } = pairedTicks(9, 1_000_000, 4)
    expect(left[left.length - 1]).toBeGreaterThanOrEqual(9)
    expect(right![right!.length - 1]).toBeGreaterThanOrEqual(1_000_000)
  })

  test("a side with no scale returns undefined rather than a lone zero", () => {
    // Reachable: a range in which only free models ran. Returning `[0]` against the other axis's seven ticks made
    // the caller label every gridline "$0.00", all stacked on the baseline.
    expect(pairedTicks(1183, 0, 4).right).toBeUndefined()
    expect(pairedTicks(0, 5, 4).left).toEqual([0])
    expect(pairedTicks(0, 0, 4)).toEqual({ left: [0], right: undefined })
  })
})
