/**
 * FORK-ONLY FILE — not present upstream, so it never conflicts on rebase.
 *
 * Frame table for the TUI's prompt scanner, ported to the web.
 *
 * A faithful port rather than an approximation: the maths mirrors
 * `packages/tui/src/ui/spinner.ts` with the exact options the TUI prompt passes at
 * `packages/tui/src/component/prompt/index.tsx:1322-1344`, and FRAME_MS matches its `interval={40}`.
 * Keeping the algorithm means the two stay recognisably the same animation; a hand-rolled CSS keyframe
 * sweep drifts from it.
 *
 * A bright head sweeps across eight cells, drags a six-step fading trail, pauses at each end, and
 * reverses. Inactive cells breathe: they fade out while the head holds and fade back in while it moves.
 *
 * Kept free of JSX and CSS imports so the table can be printed and eyeballed with plain `bun run`.
 */

// Defaults baked into createFrames(); the TUI prompt overrides only style/inactiveFactor/minAlpha.
const WIDTH = 8
const HOLD_START = 30
const HOLD_END = 9
const TRAIL_STEPS = 6
/** `inactiveFactor: 0.6` — opacity of a cell the head is not near. */
const INACTIVE_OPACITY = 0.6
/** `minAlpha: 0.3` — floor the inactive cells fade to. */
const MIN_FADE = 0.3

/** Matches the TUI's `interval={40}`. */
export const FRAME_MS = 40

const FORWARD_FRAMES = WIDTH
const BACKWARD_FRAMES = WIDTH - 1
export const TOTAL_FRAMES = FORWARD_FRAMES + HOLD_END + BACKWARD_FRAMES + HOLD_START

/** `style: "blocks"` picks these two characters. */
const ACTIVE_CHAR = "■"
const INACTIVE_CHAR = "⬝"

/**
 * deriveTrailColors() alpha falloff: full at the head, a slight bloom behind it, then exponential
 * decay. The bloom's 1.15x brightness is dropped — with currentColor there is no channel to brighten.
 */
const TRAIL_OPACITY = Array.from({ length: TRAIL_STEPS }, (_, index) => {
  if (index === 0) return 1
  if (index === 1) return 0.9
  return Math.pow(0.65, index - 1)
})

type ScannerState = {
  activePosition: number
  isHolding: boolean
  holdProgress: number
  holdTotal: number
  movementProgress: number
  movementTotal: number
  isMovingForward: boolean
}

function scannerState(frame: number): ScannerState {
  if (frame < FORWARD_FRAMES) {
    return {
      activePosition: frame,
      isHolding: false,
      holdProgress: 0,
      holdTotal: 0,
      movementProgress: frame,
      movementTotal: FORWARD_FRAMES,
      isMovingForward: true,
    }
  }
  if (frame < FORWARD_FRAMES + HOLD_END) {
    return {
      activePosition: WIDTH - 1,
      isHolding: true,
      holdProgress: frame - FORWARD_FRAMES,
      holdTotal: HOLD_END,
      movementProgress: 0,
      movementTotal: 0,
      isMovingForward: true,
    }
  }
  if (frame < FORWARD_FRAMES + HOLD_END + BACKWARD_FRAMES) {
    const index = frame - FORWARD_FRAMES - HOLD_END
    return {
      activePosition: WIDTH - 2 - index,
      isHolding: false,
      holdProgress: 0,
      holdTotal: 0,
      movementProgress: index,
      movementTotal: BACKWARD_FRAMES,
      isMovingForward: false,
    }
  }
  return {
    activePosition: 0,
    isHolding: true,
    holdProgress: frame - FORWARD_FRAMES - HOLD_END - BACKWARD_FRAMES,
    holdTotal: HOLD_START,
    movementProgress: 0,
    movementTotal: 0,
    isMovingForward: false,
  }
}

/** Trail index for one cell: 0 at the head, growing behind it, -1 when outside the trail. */
function trailIndex(cell: number, state: ScannerState): number {
  const distance = state.isMovingForward ? state.activePosition - cell : cell - state.activePosition
  if (state.isHolding) return distance + state.holdProgress
  if (distance === 0) return 0
  if (distance > 0 && distance < TRAIL_STEPS) return distance
  return -1
}

/** Global breathing applied to inactive cells only, exactly as createKnightRiderTrail does. */
function fadeFactor(state: ScannerState): number {
  if (state.isHolding && state.holdTotal > 0) {
    const progress = Math.min(state.holdProgress / state.holdTotal, 1)
    return Math.max(MIN_FADE, 1 - progress * (1 - MIN_FADE))
  }
  if (!state.isHolding && state.movementTotal > 0) {
    const progress = Math.min(state.movementProgress / Math.max(1, state.movementTotal - 1), 1)
    return MIN_FADE + progress * (1 - MIN_FADE)
  }
  return 1
}

export type ScannerCell = { char: string; opacity: number }

/** Precomputed once at module load: TOTAL_FRAMES x WIDTH of pure arithmetic. */
export const SCANNER_FRAMES: ScannerCell[][] = Array.from({ length: TOTAL_FRAMES }, (_, frame) => {
  const state = scannerState(frame)
  const fade = fadeFactor(state)
  return Array.from({ length: WIDTH }, (_, cell) => {
    const index = trailIndex(cell, state)
    if (index >= 0 && index < TRAIL_STEPS) return { char: ACTIVE_CHAR, opacity: TRAIL_OPACITY[index] }
    return { char: INACTIVE_CHAR, opacity: INACTIVE_OPACITY * fade }
  })
})
