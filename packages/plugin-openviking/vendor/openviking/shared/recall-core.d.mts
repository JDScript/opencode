import type { Fetcher } from "../utils.mjs"

export interface RecallOptions {
  actorPeerId?: string | null
  legacyPeerId?: string
  sessionId?: string
  log?: (stage: string, data?: unknown) => void
}

export function buildRecallBlock(
  fetchJSON: Fetcher,
  cfg: object,
  query: string,
  options?: RecallOptions,
): Promise<string | null>
