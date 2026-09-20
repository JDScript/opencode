export * as SessionOutputBudget from "./output-budget.js"

import { mergeHttpOptions, type LanguageModel } from "@opencode/ai"
import { Predicate } from "effect"

/**
 * FORK-ONLY FILE — not present upstream, so it never conflicts on rebase.
 *
 * The host sets a default output limit on every primary and compaction request (`outputLimit` in
 * model-request.ts). Request options merge above the model's own defaults, so that default would silently
 * override a limit the user configured on the model or its route; and a raw body overlay such as
 * `max_output_tokens` is serialized after the canonical field, so the two would both be sent. Either kind
 * of configured limit makes the host leave the field alone.
 */

/** A limit set through the model's or its route's canonical generation defaults. */
export const explicit = (model: LanguageModel) =>
  model.defaults?.generation?.maxTokens ?? model.route.defaults.generation?.maxTokens

/** A limit set as a raw body overlay under the protocol's own field name. */
export const configured = (model: LanguageModel) => {
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

/** True when the user already decided the output limit, by either route. */
export const decided = (model: LanguageModel) => explicit(model) !== undefined || configured(model) !== undefined
