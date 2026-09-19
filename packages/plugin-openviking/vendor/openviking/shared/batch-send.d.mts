import type { Fetcher, Response } from "../utils.mjs"

export interface SendResult {
  sent: number
  queued: number
  failed: number
  enqueueFailed: number
  lastError?: Response
}

export function sendSessionMessages(
  fetchJSON: Fetcher,
  sessionId: string,
  payloads: unknown[],
  opts?: { enqueueOnRetryable?: boolean },
): Promise<SendResult>
