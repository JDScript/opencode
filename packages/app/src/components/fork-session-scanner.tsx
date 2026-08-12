/**
 * FORK-ONLY FILE — not present upstream, so it never conflicts on rebase.
 *
 * The TUI's prompt scanner, shown in the web UI while a session is working.
 *
 * All the animation maths lives in ./fork-session-scanner-frames — see that file for why it is a port
 * of the TUI's algorithm rather than a CSS approximation. This component only steps through the
 * precomputed table.
 *
 * Colour comes from `currentColor`, so callers set it with a token. (The TUI tints it with the active
 * agent's colour; that is not plumbed through here.)
 */
import { createSignal, For, onCleanup, onMount, type ComponentProps } from "solid-js"
import { FRAME_MS, SCANNER_FRAMES, TOTAL_FRAMES } from "./fork-session-scanner-frames"
import "./fork-session-scanner.css"

export function ForkSessionScanner(props: {
  class?: string
  classList?: ComponentProps<"span">["classList"]
  /** Accessible description of what the animation means. */
  label?: string
}) {
  const [frame, setFrame] = createSignal(0)

  onMount(() => {
    // Mirrors the TUI's animations_enabled fallback: hold a single frame instead of animating.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
    const timer = window.setInterval(() => setFrame((current) => (current + 1) % TOTAL_FRAMES), FRAME_MS)
    onCleanup(() => window.clearInterval(timer))
  })

  return (
    <span
      data-component="fork-session-scanner"
      classList={{ ...props.classList, [props.class ?? ""]: !!props.class }}
      role="status"
      aria-label={props.label}
    >
      <span data-slot="fork-session-scanner-cells" aria-hidden="true">
        <For each={SCANNER_FRAMES[frame()]}>
          {(cell) => <span style={{ opacity: String(cell.opacity) }}>{cell.char}</span>}
        </For>
      </span>
    </span>
  )
}
