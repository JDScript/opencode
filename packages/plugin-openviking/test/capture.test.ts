import { describe, expect, test } from "bun:test"
import { Capture } from "../src/capture.js"
import type { Runtime } from "../src/runtime.js"

type Info = Parameters<typeof Capture.body>[0]

const cfg = {
  autoCapture: true,
  captureAssistantTurns: true,
  captureToolMaxChars: 40,
  captureMaxLength: 24000,
  captureMode: "semantic",
} as Runtime.Config

const time = { created: 0 }

describe("Capture.body", () => {
  test("user text becomes a content body with the peer attached", () => {
    const message = { id: "m1", type: "user", text: "Please refactor the session runner to use cursors", time } as Info
    expect(Capture.body(message, cfg, "peer-1")).toEqual({
      role: "user",
      content: "Please refactor the session runner to use cursors",
      peer_id: "peer-1",
    })
  })

  test("acknowledgements and slash commands are not captured", () => {
    expect(Capture.body({ id: "m1", type: "user", text: "ok", time } as Info, cfg, null)).toBeUndefined()
    expect(Capture.body({ id: "m1", type: "user", text: "/compact", time } as Info, cfg, null)).toBeUndefined()
  })

  test("synthetic and bookkeeping messages are skipped", () => {
    expect(
      Capture.body({ id: "m1", type: "synthetic", text: "<openviking-context>…", time } as Info, cfg, null),
    ).toBeUndefined()
    expect(Capture.body({ id: "m2", type: "idle", time } as unknown as Info, cfg, null)).toBeUndefined()
  })

  test("assistant text and tool calls become parts with truncated tool output", () => {
    const message = {
      id: "m3",
      type: "assistant",
      agent: "build",
      model: { providerID: "p", id: "m" },
      time,
      content: [
        { type: "reasoning", text: "thinking" },
        { type: "text", text: "Reading the file first." },
        {
          type: "tool",
          id: "call_1",
          name: "read",
          state: {
            status: "completed",
            input: { path: "a.ts" },
            content: [{ type: "text", text: "x".repeat(200) }],
          },
          time,
        },
        {
          type: "tool",
          id: "call_2",
          name: "shell",
          state: { status: "error", input: { command: "false" }, error: { type: "tool", message: "exit 1" } },
          time,
        },
      ],
    } as unknown as Info
    const body = Capture.body(message, cfg, null)
    expect(body?.role).toBe("assistant")
    const parts = (body && "parts" in body && body.parts) || []
    expect(parts.map((part) => part.type)).toEqual(["text", "tool", "tool"])
    expect(parts[0].text).toBe("Reading the file first.")
    expect(parts[1]).toMatchObject({
      tool_id: "call_1",
      tool_name: "read",
      tool_status: "completed",
      tool_input: { path: "a.ts" },
    })
    expect(String(parts[1].tool_output).length).toBeLessThanOrEqual(40)
    expect(parts[2]).toMatchObject({ tool_id: "call_2", tool_name: "shell", tool_status: "error" })
  })

  test("assistant turns are skipped when disabled", () => {
    const message = {
      id: "m4",
      type: "assistant",
      content: [{ type: "text", text: "hello there friend" }],
      time,
    } as unknown as Info
    expect(Capture.body(message, { ...cfg, captureAssistantTurns: false }, null)).toBeUndefined()
  })
})
