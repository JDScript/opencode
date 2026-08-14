/**
 * FORK-ONLY FILE — not present upstream, so it never conflicts on rebase.
 *
 * A live tokens-per-second readout for the prompt footer, next to the working indicator.
 *
 * Fed from the sync store rather than from the SSE stream. Subscribing to `message.part.delta` would match
 * the TUI plugin's source exactly, but there is no public event hook in this app — it would mean cutting a
 * seam into `server-sdk.tsx` and `server-session.ts`, two upstream files, to watch data the store already
 * holds. Text arriving in the store *is* the delta arriving, so the growth of the turn's text and reasoning
 * parts is the same signal one reactive step later.
 *
 * The arithmetic is in ./fork-tps-math, along with why the token counts are estimates.
 */
import { createEffect, createMemo, createSignal, on, onCleanup, Show } from "solid-js"
import { useSync } from "@/context/sync"
import { formatTps, measureGrowth, tokensPerSecond, type TpsSample } from "./fork-tps-math"
import "./fork-tps.css"

export function ForkTps(props: {
  /** Undefined on the new-session page, where there is no turn to measure. */
  sessionID: string | undefined
  /** Whether the session is generating. Idle sessions render nothing rather than a permanent dash. */
  working: boolean
  label: string
  /** Native tooltip; says that the figure is estimated. */
  title?: string
}) {
  const sync = useSync()
  /** Held outside the reactive graph: a growing log that only ever needs to say "something changed". */
  let samples: TpsSample[] = []
  let seen = new Map<string, number>()
  const [version, setVersion] = createSignal(0)
  const [tick, setTick] = createSignal(0)

  const reset = () => {
    samples = []
    seen = new Map()
    setVersion((value) => value + 1)
  }

  /**
   * The generated prose of the turn in flight — text and reasoning both, since a provider is producing
   * tokens either way and a meter that ignored reasoning would read as a stall through a long think.
   */
  const generating = createMemo(() => {
    const sessionID = props.sessionID
    if (sessionID === undefined || !props.working) return []
    const messages = sync().data.message[sessionID] ?? []
    const last = messages[messages.length - 1]
    if (last?.role !== "assistant") return []
    const parts = sync().data.part[last.id] ?? []
    return parts.filter((part) => part.type === "text" || part.type === "reasoning")
  })

  createEffect(() => {
    // Reads every part's text, so any append re-runs this.
    const { tokens, seen: next } = measureGrowth(generating(), seen)
    seen = next
    if (tokens === 0) return
    samples.push({ tokens, at: Date.now() })
    setVersion((value) => value + 1)
  })

  /** A heartbeat, so a burst that stops being fed decays to a dash instead of freezing on its last rate. */
  createEffect(() => {
    if (!props.working) {
      reset()
      return
    }
    const timer = window.setInterval(() => setTick((value) => value + 1), 1000)
    onCleanup(() => window.clearInterval(timer))
  })

  createEffect(on(() => props.sessionID, reset, { defer: true }))

  const rate = createMemo(() => {
    version()
    tick()
    // Read directly rather than from `tick`, which is a coarse 1s pulse: a sample landing between pulses
    // would otherwise be divided by a window that had not caught up, and a negative tail at that.
    return tokensPerSecond(samples, Date.now())
  })

  return (
    <Show when={props.working}>
      <span data-component="fork-tps" title={props.title}>
        <span data-slot="fork-tps-label">{props.label}</span>
        <span data-slot="fork-tps-value">{formatTps(rate())}</span>
      </span>
    </Show>
  )
}
