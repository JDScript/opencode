export interface CapturePart {
  type: "text" | "tool"
  text?: string
  tool_id?: string
  tool_name?: string
  tool_status?: string
  tool_input?: Record<string, unknown>
  tool_output?: string
}

export interface CaptureDecision {
  shouldCapture: boolean
  reason?: string
  text: string
}

export function extractTextFromContent(content: unknown, options?: { toolMaxChars?: number }): string
export function extractPartsFromPayload(payload: unknown, options?: { toolMaxChars?: number }): CapturePart[]
export function shouldCaptureText(
  text: string,
  role: string,
  cfg?: object,
  options?: { filters?: boolean },
): CaptureDecision
