import type { Config } from "./config.mjs"

export type Level = "DEBUG" | "INFO" | "WARN" | "ERROR"

export interface Response {
  ok: boolean
  status: number
  result?: any
  error?: { message?: string; code?: string } | string
  traceId?: string
}

export interface FetchOptions {
  timeoutMs?: number
  actorPeerId?: string | null
}

export type Fetcher = (endpoint: string, init?: RequestInit, options?: FetchOptions) => Promise<Response>

export function initLogger(dataDir: string): void
export function log(level: Level, tool: string, message: string, data?: unknown): void
export function safeStringify(value: unknown): unknown
export function normalizeEndpoint(endpoint: string): string
export function effectivePeerId(config: Config): string | null
export function fetchJSON(
  config: Config,
  endpoint: string,
  init?: RequestInit,
  options?: FetchOptions,
): Promise<Response>
