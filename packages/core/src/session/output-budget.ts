export * as SessionOutputBudget from "./output-budget.js"

import { mergeHttpOptions, type LanguageModel } from "@opencode/ai"
import { Predicate } from "effect"
import type { SessionRunnerModel } from "./runner/model.js"

export const defaults = (resolved: SessionRunnerModel.Resolved) => {
  const model = resolved.model
  const limit = resolved.limit
  const explicit = model.defaults?.generation?.maxTokens ?? model.route.defaults.generation?.maxTokens
  if (explicit !== undefined) return explicit
  // A raw limit may use a different spelling than the protocol's canonical field.
  // Leave it alone rather than adding a competing catalog-derived limit.
  if (configured(model) !== undefined || limit.output <= 0) return undefined
  // Preserve the existing reservation for catalogs that advertise the whole context as output.
  return limit.context > 0 && limit.output >= limit.context ? Math.min(limit.output, 32_000) : limit.output
}

/** Raw body overlays are applied after canonical generation options by the transport. */
export const effective = (resolved: SessionRunnerModel.Resolved) => configured(resolved.model) ?? defaults(resolved)

const configured = (model: LanguageModel) => {
  const body = mergeHttpOptions(model.route.defaults.http, model.defaults?.http)?.body
  const protocol = model.route.protocol
  const paths =
    protocol === "bedrock-converse"
      ? [["inferenceConfig", "maxTokens"]]
      : protocol === "gemini"
        ? [["generationConfig", "maxOutputTokens"]]
        : protocol.endsWith("responses")
          ? [["max_output_tokens"]]
          : protocol.endsWith("chat")
            ? [["max_completion_tokens"], ["max_tokens"]]
            : protocol.endsWith("messages")
              ? [["max_tokens"]]
              : []
  for (const path of paths) {
    let value: unknown = body
    for (const key of path) {
      value = typeof value === "object" && Predicate.hasProperty(value, key) ? value[key] : undefined
    }
    if (typeof value === "number") return value
  }
}
