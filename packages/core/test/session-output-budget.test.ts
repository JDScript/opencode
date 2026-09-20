import { describe, expect, test } from "bun:test"
import { LanguageModel } from "@opencode/ai"
import { AnthropicMessages, BedrockConverse, OpenAIChat, OpenAIResponses } from "@opencode/ai/protocols"
import { SessionOutputBudget } from "@opencode/core/session/output-budget"

// FORK: a user-configured output limit keeps the host from adding its own default.
describe("SessionOutputBudget", () => {
  const base = LanguageModel.make({ id: "m", provider: "fake", route: OpenAIChat.route })

  test("an unconfigured model leaves the decision to the host", () => {
    expect(SessionOutputBudget.explicit(base)).toBeUndefined()
    expect(SessionOutputBudget.configured(base)).toBeUndefined()
    expect(SessionOutputBudget.decided(base)).toBe(false)
  })

  test("model defaults win over route defaults", () => {
    const model = LanguageModel.update(base, {
      defaults: { generation: { maxTokens: 64_000 } },
      route: base.route.with({ generation: { maxTokens: 48_000 } }),
    })
    expect(SessionOutputBudget.explicit(model)).toBe(64_000)
    expect(SessionOutputBudget.decided(model)).toBe(true)
  })

  test("a raw body overlay is read under each protocol's field", () => {
    const cases: ReadonlyArray<[LanguageModel["route"], Record<string, unknown>, number]> = [
      [OpenAIChat.route, { max_completion_tokens: 1 }, 1],
      [OpenAIChat.route, { max_tokens: 2 }, 2],
      [OpenAIResponses.route, { max_output_tokens: 3 }, 3],
      [AnthropicMessages.route, { max_tokens: 4 }, 4],
      [BedrockConverse.route, { inferenceConfig: { maxTokens: 5 } }, 5],
    ]
    for (const [route, body, expected] of cases) {
      const model = LanguageModel.make({ id: "m", provider: "fake", route: route.with({ http: { body } }) })
      expect(SessionOutputBudget.configured(model)).toBe(expected)
      expect(SessionOutputBudget.decided(model)).toBe(true)
    }
  })
})
