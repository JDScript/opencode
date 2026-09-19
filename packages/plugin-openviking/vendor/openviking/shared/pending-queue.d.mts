import type { Fetcher } from "../utils.mjs"

export function enqueue(
  type: string,
  sessionId: string,
  payload: unknown,
  options?: { createdAt?: number },
): Promise<{ ok: boolean }>
export function replayPending(
  fetchJSON: Fetcher,
  log: (stage: string, data?: unknown) => void,
  options?: { consumeRetries?: boolean },
): Promise<unknown>
