/**
 * FORK-ONLY FILE — not present upstream, so it never conflicts on rebase.
 *
 * The arithmetic behind the live tokens-per-second readout, kept apart from the component so it can be
 * tested without a store, a clock or a DOM.
 *
 * Ported from the `opencode-tps` TUI plugin (MIT, github.com/williamcr01/opencode-tps), whose README states
 * plainly that the web UI cannot run it — hence this. The window sizes and the format thresholds are its
 * numbers, so a reader who knows the TUI meter sees the same figures here.
 */

export type TpsSample = {
  /** Estimated tokens that arrived in the interval ending at `at`. */
  tokens: number
  at: number
}

/** The plugin's constants. */
const WINDOW_MS = 5_000
/** A gap this long ends the burst: nothing is arriving, so the meter has nothing to report. */
const STALE_MS = 1_500
/** Floors the divisor, so one sample in a 3ms window cannot read as thousands of tokens a second. */
const MIN_DURATION_MS = 250
/** Caps the still-open tail, so a pause does not drag the rate down before it is called stale. */
const MAX_TAIL_MS = 1_000

const encoder = new TextEncoder()

/**
 * UTF-8 bytes over five — the plugin's heuristic, and an estimate rather than a count.
 *
 * A streaming delta carries text, not a token count. The real ones arrive with `step-finish` at the end of
 * a step, far too coarse for a live meter, so there is nothing exact to divide. Five bytes per token is
 * close for English prose and wrong in both directions elsewhere: CJK runs three bytes per character and
 * often a token or two per character, so it reads low there.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(encoder.encode(text).length / 5)
}

/**
 * The samples belonging to the burst still in progress, oldest first.
 *
 * Walked from the newest backwards, stopping at the window edge or at the first gap wide enough to be a
 * different burst. That second cut is what keeps a tool call from being counted as slow generation: the
 * plugin does it by watching tool parts change state, which only catches stalls that a tool causes. Cutting
 * on the gap itself catches every one of them, including a provider that simply went quiet.
 */
export function currentBurst(samples: readonly TpsSample[], now: number): TpsSample[] {
  const cutoff = now - WINDOW_MS
  const burst: TpsSample[] = []
  for (let index = samples.length - 1; index >= 0; index--) {
    const sample = samples[index]
    if (sample.at < cutoff) break
    const newer = burst[0]
    if (newer && newer.at - sample.at > STALE_MS) break
    burst.unshift(sample)
  }
  return burst
}

/**
 * Tokens per second over the current burst, or undefined when there is nothing to report.
 *
 * Undefined — shown as a dash — rather than zero, because zero is a measurement and this is the absence of
 * one: between two turns, or while a tool runs, nothing is being generated at any rate at all.
 */
export function tokensPerSecond(samples: readonly TpsSample[], now: number): number | undefined {
  const burst = currentBurst(samples, now)
  if (burst.length === 0) return undefined

  const last = burst[burst.length - 1]
  if (now - last.at > STALE_MS) return undefined

  const tokens = burst.reduce((sum, sample) => sum + sample.tokens, 0)
  let duration = 0
  for (let index = 1; index < burst.length; index++) duration += burst[index].at - burst[index - 1].at
  duration += Math.min(now - last.at, MAX_TAIL_MS)
  return (tokens / Math.max(duration, MIN_DURATION_MS)) * 1000
}

/** Three significant-ish digits, so the width barely moves as the rate climbs. */
export function formatTps(value: number | undefined, dash = "—"): string {
  if (value === undefined) return dash
  if (value < 10) return value.toFixed(2)
  if (value < 100) return value.toFixed(1)
  return String(Math.round(value))
}

/**
 * Growth witnessed across a turn's prose parts, and the new watermarks to remember.
 *
 * Only growth that was actually observed counts: a part seen for the first time sets its watermark and
 * contributes nothing. Otherwise opening a session onto a half-written reply would charge every character
 * already on screen to the instant the component mounted, and the meter's first reading would be enormous.
 */
export function measureGrowth(
  parts: ReadonlyArray<{ id: string; text?: string }>,
  seen: ReadonlyMap<string, number>,
): { tokens: number; seen: Map<string, number> } {
  const next = new Map(seen)
  let tokens = 0
  for (const part of parts) {
    const text = part.text ?? ""
    const watermark = next.get(part.id)
    if (watermark === undefined) {
      next.set(part.id, text.length)
      continue
    }
    if (text.length <= watermark) continue
    tokens += estimateTokens(text.slice(watermark))
    next.set(part.id, text.length)
  }
  return { tokens, seen: next }
}
