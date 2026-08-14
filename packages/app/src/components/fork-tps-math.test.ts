/** FORK-ONLY FILE — not present upstream, so it never conflicts on rebase. */
import { describe, expect, test } from "bun:test"
import { currentBurst, estimateTokens, formatTps, measureGrowth, tokensPerSecond } from "./fork-tps-math"

const at = (offset: number) => 1_000_000 + offset

describe("estimateTokens", () => {
  test("counts UTF-8 bytes, not characters", () => {
    // Five ASCII bytes is one token; the same five characters in Chinese are fifteen bytes.
    expect(estimateTokens("hello")).toBe(1)
    expect(estimateTokens("你好世界啊")).toBe(3)
  })

  test("any non-empty text is at least one token", () => {
    expect(estimateTokens("a")).toBe(1)
    expect(estimateTokens("")).toBe(0)
  })
})

describe("currentBurst", () => {
  test("keeps only the last five seconds", () => {
    const samples = [
      { tokens: 100, at: at(0) },
      { tokens: 5, at: at(4_000) },
      { tokens: 5, at: at(4_500) },
    ]
    expect(currentBurst(samples, at(5_500)).map((sample) => sample.tokens)).toEqual([5, 5])
  })

  test("stops at a gap wide enough to be a different burst", () => {
    // The 2s hole is a tool call or a stalled provider; what came before it is not this burst.
    const samples = [
      { tokens: 40, at: at(0) },
      { tokens: 40, at: at(200) },
      { tokens: 3, at: at(2_400) },
      { tokens: 3, at: at(2_600) },
    ]
    expect(currentBurst(samples, at(2_700)).map((sample) => sample.tokens)).toEqual([3, 3])
  })

  test("a gap inside the tolerance keeps the burst whole", () => {
    const samples = [
      { tokens: 3, at: at(0) },
      { tokens: 3, at: at(1_400) },
    ]
    expect(currentBurst(samples, at(1_500))).toHaveLength(2)
  })
})

describe("tokensPerSecond", () => {
  test("tokens over the span they arrived in", () => {
    // 20 tokens across 1000ms of samples, read 0ms after the last one.
    const samples = [
      { tokens: 10, at: at(0) },
      { tokens: 10, at: at(1_000) },
    ]
    expect(tokensPerSecond(samples, at(1_000))).toBeCloseTo(20, 5)
  })

  test("undefined once nothing has arrived for a while, rather than a stale rate", () => {
    const samples = [{ tokens: 50, at: at(0) }]
    expect(tokensPerSecond(samples, at(1_000))).toBeDefined()
    expect(tokensPerSecond(samples, at(1_600))).toBeUndefined()
  })

  test("undefined when there is nothing at all", () => {
    expect(tokensPerSecond([], at(0))).toBeUndefined()
  })

  test("the divisor has a floor, so a burst in a few milliseconds is not thousands a second", () => {
    const samples = [
      { tokens: 20, at: at(0) },
      { tokens: 20, at: at(3) },
    ]
    // Without the 250ms floor this would read as roughly 13,000.
    expect(tokensPerSecond(samples, at(3))).toBeCloseTo(160, 5)
  })

  test("a pause inside the tolerance is capped, so it dips rather than plunging", () => {
    const samples = [{ tokens: 30, at: at(0) }]
    // The open tail counts for at most 1s, so this is 30/s and not 30/1.4 = 21.4.
    expect(tokensPerSecond(samples, at(1_400))).toBeCloseTo(30, 5)
  })
})

describe("formatTps", () => {
  test("narrows the precision as the number grows, so the width barely moves", () => {
    expect(formatTps(9.876)).toBe("9.88")
    expect(formatTps(42.35)).toBe("42.4")
    expect(formatTps(140.6)).toBe("141")
  })

  test("a dash for no measurement, which is not the same as zero", () => {
    expect(formatTps(undefined)).toBe("—")
    expect(formatTps(0)).toBe("0.00")
  })
})

describe("measureGrowth", () => {
  test("a part seen for the first time only sets its watermark", () => {
    // Otherwise opening a session onto a half-written reply bills every character already there to now.
    const first = measureGrowth([{ id: "p1", text: "a".repeat(500) }], new Map())
    expect(first.tokens).toBe(0)
    expect(first.seen.get("p1")).toBe(500)
  })

  test("counts only what was appended after that", () => {
    const seeded = measureGrowth([{ id: "p1", text: "hello" }], new Map()).seen
    const grown = measureGrowth([{ id: "p1", text: "hello" + "x".repeat(20) }], seeded)
    expect(grown.tokens).toBe(4)
    expect(grown.seen.get("p1")).toBe(25)
  })

  test("sums across the turn's parts, so reasoning counts alongside text", () => {
    const seeded = measureGrowth(
      [
        { id: "reason", text: "" },
        { id: "text", text: "" },
      ],
      new Map(),
    ).seen
    const grown = measureGrowth(
      [
        { id: "reason", text: "x".repeat(10) },
        { id: "text", text: "y".repeat(10) },
      ],
      seeded,
    )
    expect(grown.tokens).toBe(4)
  })

  test("a shrinking or rewritten part contributes nothing rather than a negative", () => {
    const seeded = measureGrowth([{ id: "p1", text: "a".repeat(100) }], new Map()).seen
    expect(measureGrowth([{ id: "p1", text: "short" }], seeded).tokens).toBe(0)
  })

  test("leaves the map it was given alone", () => {
    const seen = new Map<string, number>()
    measureGrowth([{ id: "p1", text: "hello" }], seen)
    expect(seen.size).toBe(0)
  })
})
