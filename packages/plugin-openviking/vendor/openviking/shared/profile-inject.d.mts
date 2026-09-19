import type { Fetcher } from "../utils.mjs"

export function buildProfileBlock(
  fetchJSON: Fetcher,
  totalBudgetTokens: number,
  actorPeerId?: string | null,
): Promise<{ block?: string } | null>
