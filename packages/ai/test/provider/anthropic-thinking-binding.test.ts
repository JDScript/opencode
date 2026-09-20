import { expect } from "bun:test"
import { Effect } from "effect"
import { HttpClientRequest } from "effect/unstable/http"
import { LLM } from "../../src/index.js"
import { AnthropicMessages } from "../../src/protocols/anthropic-messages.js"
import { compileRequest } from "../../src/route/client.js"
import { it } from "../lib/effect.js"

for (const [id, enabled] of [
  ["claude-fable-5-1", true],
  ["claude-fable-5-10", true],
  ["claude-fable-6", true],
  ["claude-mythos-5-1", true],
  ["claude-fable-5.1", true],
  ["anthropic/claude-fable-5.1", true],
  ["claude-fable-5-1@default", true],
  ["claude-fable-5-1@20260901", true],
  ["claude-sonnet-6", true],
  ["claude-opus-5-20260901", false],
  ["claude-opus-4-8", false],
  ["anthropic/claude-opus-4.8", false],
  ["claude-fable-5@default", false],
  ["claude-next", false],
  ["kimi-k2.5", false],
] as const) {
  it.effect(`thinking-binding defaults for ${id}`, () =>
    Effect.gen(function* () {
      const request = LLM.request({
        model: AnthropicMessages.route.model({ id }),
        prompt: "Hello",
        http: { headers: { "anthropic-beta": "existing-beta" } },
      })
      const compiled = yield* compileRequest(request)
      const prepared = yield* AnthropicMessages.route.prepareTransport(compiled.body, request)
      expect(compiled.body.thinking).toEqual(
        enabled ? { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } } : undefined,
      )
      expect(prepared.request.headers["anthropic-beta"]).toBe(
        enabled
          ? "existing-beta,interleaved-thinking-2025-05-14,thinking-binding-controls-2026-08-01"
          : "existing-beta,interleaved-thinking-2025-05-14",
      )
    }),
  )
}

it.effect("preserves explicit thinking settings and combines required beta headers", () =>
  Effect.gen(function* () {
    for (const thinking of [
      { type: "disabled" },
      { type: "adaptive", block_binding: { prefix_mismatch_behavior: "error" } },
    ] as const) {
      const request = LLM.request({
        model: AnthropicMessages.route.model({ id: "claude-fable-5-1" }),
        prompt: "Hello",
        providerOptions: { thinking, contextManagement: { edits: [{ type: "compact_20260112" }] } },
      })
      const compiled = yield* compileRequest(request)
      const prepared = yield* AnthropicMessages.route.prepareTransport(compiled.body, request)
      expect(compiled.body.thinking).toEqual(thinking)
      expect(prepared.request.headers["anthropic-beta"]).toBe(
        thinking.type === "disabled"
          ? "interleaved-thinking-2025-05-14,compact-2026-01-12"
          : "interleaved-thinking-2025-05-14,compact-2026-01-12,thinking-binding-controls-2026-08-01",
      )
    }
  }),
)

for (const [id, capability, thinking, binding] of [
  ["claude-sonnet-4-5", undefined, { type: "enabled", budget_tokens: 1024 }, false],
  ["claude-fable-5", undefined, { type: "adaptive" }, false],
  ["claude-fable-5-1", false, { type: "adaptive" }, false],
  ["claude-fable-5-1", false, undefined, false],
  ["claude-sonnet-4-5", true, { type: "enabled", budget_tokens: 1024 }, true],
  ["custom-deployment", true, undefined, true],
  ["claude-next", undefined, { type: "adaptive" }, false],
] as const) {
  it.effect(`retains native capability behavior for ${id}, override ${capability}, thinking ${thinking?.type}`, () =>
    Effect.gen(function* () {
      const request = LLM.request({
        model: AnthropicMessages.route.model({ id, compatibility: { supportsThinkingBlockBinding: capability } }),
        prompt: "Hello",
        providerOptions: thinking ? { thinking } : undefined,
      })
      const compiled = yield* compileRequest(request)
      const prepared = yield* AnthropicMessages.route.prepareTransport(compiled.body, request)
      const web = yield* HttpClientRequest.toWeb(prepared.request)
      const body: Record<string, unknown> = yield* Effect.promise(() => web.json())
      expect(body.thinking).toEqual(
        binding
          ? { ...(thinking ?? { type: "adaptive" }), block_binding: { prefix_mismatch_behavior: "drop_block" } }
          : thinking,
      )
      expect(prepared.request.headers["anthropic-beta"].includes("thinking-binding-controls-2026-08-01")).toBe(binding)
    }),
  )
}
