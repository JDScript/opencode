export function deriveHarnessSessionId(prefix: string, sessionId: string, suffix?: string): string
export function isBypassed(
  cfg: { bypassSession?: boolean; bypassSessionPatterns?: string[] },
  input?: { sessionId?: string; cwd?: string },
): boolean
