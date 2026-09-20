import { Schema } from "effect"
import type { LanguageModel } from "../../schema/index.js"
import { JsonObject } from "../shared.js"

export const Thinking = Schema.StructWithRest(
  Schema.Struct({
    type: Schema.String,
    block_binding: Schema.optional(JsonObject),
  }),
  [JsonObject],
)

// Accept gateway namespaces and Vertex suffixes without treating a snapshot date as a minor version.
export const version = (id: string) => {
  const match = /(?:^|[./])claude-(?<family>[a-z]+)-(?<major>\d+)(?:[.-](?<minor>\d{1,2}))?(?:$|[-:@])/.exec(
    id.toLowerCase(),
  )?.groups
  if (!match) return undefined
  return { family: match.family, major: Number(match.major), minor: Number(match.minor ?? 0) }
}

export const supports = (model: LanguageModel) => {
  const override = model.compatibility?.supportsThinkingBlockBinding
  if (override !== undefined) return override
  const parsed = version(model.id)
  return parsed !== undefined && (parsed.major > 5 || (parsed.major === 5 && parsed.minor >= 1))
}

export const bedrockEligible = (model: LanguageModel) => {
  if (model.compatibility?.supportsThinkingBlockBinding !== undefined) return supports(model)
  const parsed = version(model.id)
  return supports(model) || (parsed?.family === "fable" && parsed.major === 5 && parsed.minor === 0)
}

export const bedrockDefault = (model: LanguageModel, thinking: typeof Thinking.Type | undefined) => {
  if (!bedrockEligible(model) || thinking?.type === "disabled") return thinking
  // Bedrock accepted Fable 5 adaptive binding, but rejected Sonnet 4.5 manual binding.
  // Only the shared capability policy permits implicit thinking or other modes.
  if (!supports(model) && thinking?.type !== "adaptive") return thinking
  return {
    ...(thinking ?? { type: "adaptive" }),
    block_binding: thinking?.block_binding ?? { prefix_mismatch_behavior: "drop_block" },
  }
}

export * as AnthropicThinkingBinding from "./anthropic-thinking-binding.js"
