import { describe, expect } from "bun:test"
import { LanguageModel, LLMClient, Message } from "@opencode/ai"
import { AnthropicMessages, BedrockConverse, OpenAIChat, OpenAIResponses } from "@opencode/ai/protocols"
import { AmazonBedrockMantle } from "@opencode/ai/providers"
import { Auth, RequestExecutor } from "@opencode/ai/route"
import { compileRequest } from "@opencode/ai/route/client"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/core/model"
import { ModelResolver } from "@opencode/core/model-resolver"
import { Provider } from "@opencode/core/provider"
import { Location } from "@opencode/core/location"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { SessionModelRequest } from "@opencode/core/session/model-request"
import { SessionModelTransport } from "@opencode/core/session/model-transport"
import { SessionOutputBudget } from "@opencode/core/session/output-budget"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { Money } from "@opencode/schema/money"
import { Session } from "@opencode/schema/session"
import { DateTime, Effect, Layer, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { testEffect } from "./lib/effect"
import { PluginTestLayer } from "./plugin/fixture"

const it = testEffect(
  Layer.merge(
    PluginTestLayer,
    Layer.succeed(
      SessionModelTransport.Service,
      SessionModelTransport.Service.of({
        bind: () => ({ execute: () => Effect.die("unused") }),
        close: () => Effect.void,
        closeAll: Effect.void,
      }),
    ),
  ),
)
const session = Session.Info.make({
  id: Session.ID.make("ses_output_budget"),
  parentID: Session.ID.make("ses_parent"),
  projectID: Project.ID.global,
  cost: Money.USD.zero,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
  location: Location.Ref.make({ directory: AbsolutePath.make("/project") }),
})
const resolved = (model: LanguageModel, output = 128_000, context = 1_050_000) =>
  SessionRunnerModel.resolved(model, {
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    cost: [],
    limit: { context, output },
  })
const input = (model: SessionRunnerModel.Resolved): SessionModelRequest.Input => ({
  session,
  agent: Agent.ID.make("build"),
  model,
  system: [],
  messages: [Message.user("Hello")],
})
const mantle = AmazonBedrockMantle.configure({ apiKey: "test-key" }).responses("global.openai.gpt-6-astra").route
const routes: ReadonlyArray<LanguageModel["route"]> = [
  mantle,
  OpenAIChat.route,
  AnthropicMessages.route,
  BedrockConverse.route,
]

describe("Session output budget", () => {
  for (const route of routes) {
    it.effect(`passes catalog budgets through session requests to ${route.protocol}`, () =>
      Effect.gen(function* () {
        const hooks = yield* PluginHooks.Service
        yield* hooks.register("session", "context", (event) =>
          Effect.sync(() => {
            event.options.reasoningEffort = "max"
          }),
        )
        const requests = yield* SessionModelRequest.Service.pipe(Effect.provide(SessionModelRequest.layer))
        const model = route
          .with({ auth: Auth.none, endpoint: { baseURL: "https://example.test" } })
          .model({ id: "global.openai.gpt-6-astra" })
        for (const kind of ["primary", "compaction", "generate", "title"] as const) {
          for (const output of [128_000, 8_192]) {
            const prepared = yield* requests[kind](input(resolved(model, output)))
            expect(prepared.request.generation?.maxTokens).toBe(output)
            const compiled = yield* compileRequest(prepared.request)
            expect(compiled.body).toMatchObject(
              route === mantle
                ? { max_output_tokens: output }
                : route === OpenAIChat.route
                  ? { max_completion_tokens: output }
                  : route === BedrockConverse.route
                    ? { inferenceConfig: { maxTokens: output } }
                    : { max_tokens: output },
            )
            if (kind === "primary") expect(prepared.request.providerOptions?.reasoningEffort).toBe("max")
          }
        }
        const overlaid = resolved(
          LanguageModel.update(model, {
            defaults: {
              http: {
                body:
                  route === mantle
                    ? { max_output_tokens: 64_000 }
                    : route === OpenAIChat.route
                      ? { max_completion_tokens: 64_000 }
                      : route === BedrockConverse.route
                        ? { inferenceConfig: { maxTokens: 64_000 } }
                        : { max_tokens: 64_000 },
              },
            },
          }),
        )
        const prepared = yield* requests.primary(input(overlaid))
        expect(prepared.request.generation?.maxTokens).toBeUndefined()
        expect(SessionOutputBudget.effective(overlaid)).toBe(64_000)
      }),
    )
  }

  it.effect("preserves canonical route, model and hook budget precedence", () =>
    Effect.gen(function* () {
      const hooks = yield* PluginHooks.Service
      const requests = yield* SessionModelRequest.Service.pipe(Effect.provide(SessionModelRequest.layer))
      const route = OpenAIResponses.route.with({ generation: { maxTokens: 48_000 } })
      const model = route.model({ id: "gpt-6-astra" })
      const selected = LanguageModel.update(model, { defaults: { generation: { maxTokens: 64_000 } } })
      expect((yield* requests.primary(input(resolved(model)))).request.generation?.maxTokens).toBe(48_000)
      expect((yield* requests.primary(input(resolved(selected)))).request.generation?.maxTokens).toBe(64_000)
      yield* hooks.register("session", "context", (event) =>
        Effect.sync(() => {
          event.options.maxTokens = 96_000
          event.options.reasoningEffort = "high"
        }),
      )
      const prepared = yield* requests.primary(input(resolved(selected)))
      expect(prepared.request.generation?.maxTokens).toBe(96_000)
      expect(SessionOutputBudget.effective(resolved(selected))).toBe(64_000)
    }),
  )

  it.effect("keeps body overlays above canonical budgets in the serialized request and reservation", () =>
    Effect.gen(function* () {
      const requests = yield* SessionModelRequest.Service.pipe(Effect.provide(SessionModelRequest.layer))
      const providerID = Provider.ID.make("test")
      const providers = yield* Provider.Service
      const models = yield* Model.Service
      yield* providers.transform((editor) => {
        editor.update(providerID, (provider) => {
          provider.activation = "enabled"
          provider.package = "@opencode/ai/providers/openai/responses"
          provider.settings = { apiKey: "test-key", baseURL: "https://example.test", reasoningEffort: "max" }
          provider.body = { max_output_tokens: 48_000 }
        })
        editor.models.update(providerID, Model.ID.make("gpt-6-astra"), (model) => {
          model.body = { max_output_tokens: 64_000 }
          model.variants = [{ id: Model.VariantID.make("max"), body: { max_output_tokens: 96_000 } }]
        })
      })
      const catalog = yield* models.get(providerID, Model.ID.make("gpt-6-astra"))
      if (!catalog) throw new Error("Expected configured model")
      const bodies: unknown[] = []
      const http = HttpClient.make((request) =>
        Effect.gen(function* () {
          const web = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie)
          bodies.push(yield* Effect.promise(() => web.json()))
          return HttpClientResponse.fromWeb(
            request,
            new Response(
              request.url.endsWith("/chat/completions")
                ? 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
                : 'data: {"type":"response.completed","response":{"id":"resp_test"}}\n\n',
              { headers: { "content-type": "text/event-stream" } },
            ),
          )
        }),
      )
      const client = LLMClient.layer.pipe(
        Layer.provide(RequestExecutor.layer.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, http)))),
        Layer.fresh,
      )
      for (const variant of [undefined, Model.VariantID.make("max")]) {
        const model = yield* ModelResolver.resolveModel(catalog, variant)
        const selected = resolved(model)
        const prepared = yield* requests.primary(input(selected))
        expect(prepared.request.generation?.maxTokens).toBeUndefined()
        expect(SessionOutputBudget.effective(selected)).toBe(variant ? 96_000 : 64_000)
        yield* LLMClient.stream(prepared.request).pipe(Stream.runDrain, Effect.provide(client))
      }
      expect(bodies).toMatchObject([{ max_output_tokens: 64_000 }, { max_output_tokens: 96_000 }])
      for (const field of ["max_tokens", "max_completion_tokens"] as const) {
        const model = OpenAIChat.route
          .with({
            auth: Auth.none,
            endpoint: { baseURL: "https://example.test" },
            http: { body: { [field]: 64_000 } },
          })
          .model({ id: "gpt-6-astra" })
        const selected = resolved(model)
        const prepared = yield* requests.primary(input(selected))
        expect(prepared.request.generation?.maxTokens).toBeUndefined()
        expect(SessionOutputBudget.effective(selected)).toBe(64_000)
        yield* LLMClient.stream(prepared.request).pipe(Stream.runDrain, Effect.provide(client))
        expect(bodies.at(-1)).toHaveProperty(field, 64_000)
        expect(bodies.at(-1)).not.toHaveProperty(field === "max_tokens" ? "max_completion_tokens" : "max_tokens")

        const explicit = resolved(LanguageModel.update(model, { defaults: { generation: { maxTokens: 48_000 } } }))
        expect((yield* requests.primary(input(explicit))).request.generation?.maxTokens).toBe(48_000)
      }
    }),
  )

  it.effect("preserves unknown limits and the whole-context catalog fallback", () =>
    Effect.gen(function* () {
      const requests = yield* SessionModelRequest.Service.pipe(Effect.provide(SessionModelRequest.layer))
      const model = OpenAIChat.route.model({ id: "test" })
      const unknown = yield* requests.primary(input(resolved(model, 0, 0)))
      expect(unknown.request.generation).toBeUndefined()
      const selected = resolved(model, 262_144, 262_144)
      const fallback = yield* requests.primary(input(selected))
      expect(fallback.request.generation?.maxTokens).toBe(32_000)
      expect(SessionOutputBudget.effective(selected)).toBe(32_000)
      const explicit = resolved(
        LanguageModel.update(model, { defaults: { generation: { maxTokens: 64_000 } } }),
        262_144,
        262_144,
      )
      expect((yield* requests.primary(input(explicit))).request.generation?.maxTokens).toBe(64_000)
      const raw = resolved(
        LanguageModel.update(model, { defaults: { http: { body: { max_completion_tokens: 96_000 } } } }),
        262_144,
        262_144,
      )
      const overridden = yield* requests.primary(input(raw))
      expect(overridden.request.generation?.maxTokens).toBeUndefined()
      expect(SessionOutputBudget.effective(raw)).toBe(96_000)
    }),
  )
})
