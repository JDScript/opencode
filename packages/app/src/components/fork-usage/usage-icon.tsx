/**
 * FORK-ONLY FILE — not present upstream, so it never conflicts on rebase.
 *
 * A bar-chart glyph for the usage entry point.
 *
 * Hand-drawn because the v2 icon set has no chart, graph or statistics icon among its 37 — and
 * `Icon` silently falls back to `plus` for an unknown name (`icon.tsx:190`), so passing one would have
 * produced a plus sign with no error anywhere.
 *
 * Matches what `Icon` renders so the surrounding styles apply unchanged: the same `data-slot="icon-svg"`
 * hook that call sites target for colour, the same 16-unit viewBox, `fill="none"` with `currentColor`
 * strokes, and the same 14px that `size="small"` resolves to.
 */
import type { ComponentProps } from "solid-js"

export function ForkUsageIcon(props: ComponentProps<"svg">) {
  return (
    <svg
      {...props}
      data-slot="icon-svg"
      width={14}
      height={14}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden={props["aria-hidden"] ?? "true"}
    >
      <path
        d="M2.5 2.5V13.5H13.5M5.5 13.5V9.5M8.5 13.5V5.5M11.5 13.5V7.5"
        stroke="currentColor"
        stroke-linecap="square"
        stroke-miterlimit="10"
      />
    </svg>
  )
}
