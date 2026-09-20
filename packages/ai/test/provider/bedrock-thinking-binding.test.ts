import { EventStreamCodec } from "@smithy/eventstream-codec"
import { fromUtf8, toUtf8 } from "@smithy/util-utf8"
import { AwsV4Signer } from "aws4fetch"
import { expect } from "bun:test"
import { Effect } from "effect"
import { LanguageModel, LLM, LLMRequest, Message, ToolDefinition } from "../../src/index.js"
import { AmazonBedrock } from "../../src/providers.js"
import { LLMClient } from "../../src/route.js"
import { it } from "../lib/effect.js"
import { dynamicResponse } from "../lib/http.js"

const beta = "thinking-binding-controls-2026-08-01"
const credentials = { region: "us-east-1", accessKeyId: "test-access", secretAccessKey: "test-secret" }
const provider = AmazonBedrock.configure({
  auth: "sigv4",
  credentials,
  baseURL: "https://bedrock-runtime.test",
})
const finished = new EventStreamCodec(toUtf8, fromUtf8).encode({
  headers: {
    ":message-type": { type: "string", value: "event" },
    ":event-type": { type: "string", value: "messageStop" },
    ":content-type": { type: "string", value: "application/json" },
  },
  body: new TextEncoder().encode(JSON.stringify({ stopReason: "end_turn" })),
})

const request = (id = "us.anthropic.claude-fable-5-1") =>
  LLM.request({
    model: provider.model(id),
    system: "System B: summarize the conversation.",
    cache: "none",
    messages: [
      Message.user("Find the sum."),
      Message.assistant([
        {
          type: "reasoning",
          text: "I should add.",
          providerMetadata: { bedrock: { signature: "system-A-signature" } },
        },
        { type: "tool-call", id: "call_1", name: "add", input: { left: 1, right: 2 } },
      ]),
      Message.tool({ id: "call_1", name: "add", result: "3", resultType: "text" }),
      Message.user("Summarize."),
    ],
    tools: [ToolDefinition.make({ name: "add", description: "Add numbers", inputSchema: { type: "object" } })],
  })

// Exercise the real compiler, overlay merge and signer, with an in-memory HTTP response.
const wire = (request: LLMRequest, check: (body: Record<string, unknown>) => void) =>
  LLMClient.generate(request).pipe(
    Effect.provide(
      dynamicResponse((input) =>
        Effect.gen(function* () {
          check(JSON.parse(input.text))
          const signed = yield* Effect.promise(() =>
            new AwsV4Signer({
              ...credentials,
              service: "bedrock",
              method: "POST",
              url: input.request.url,
              datetime: input.request.headers["x-amz-date"],
              // The HTTP client appends tracing headers after signing.
              headers: Object.entries(input.request.headers).filter(([name]) =>
                input.request.headers.authorization
                  .match(/SignedHeaders=([^,]+)/)![1]
                  .split(";")
                  .includes(name),
              ),
              body: input.text,
            }).sign(),
          )
          expect(input.request.headers.authorization).toBe(signed.headers.get("authorization"))
          return input.respond(finished.slice().buffer, {
            headers: { "content-type": "application/vnd.amazon.eventstream" },
          })
        }),
      ),
    ),
  )

it.effect("protects signed Fable reasoning replay under a changed system before signing", () =>
  wire(request(), (body) => {
    expect(body.additionalModelRequestFields).toEqual({
      thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } },
      anthropic_beta: [beta],
    })
    expect(body.system).toEqual([{ text: "System B: summarize the conversation." }])
    expect(body.messages).toEqual([
      { role: "user", content: [{ text: "Find the sum." }] },
      {
        role: "assistant",
        content: [
          { reasoningContent: { reasoningText: { text: "I should add.", signature: "system-A-signature" } } },
          { toolUse: { toolUseId: "call_1", name: "add", input: { left: 1, right: 2 } } },
        ],
      },
      {
        role: "user",
        content: [
          { toolResult: { toolUseId: "call_1", content: [{ text: "3" }], status: "success" } },
          { text: "Summarize." },
        ],
      },
    ])
    expect(body.toolConfig).toEqual({
      tools: [{ toolSpec: { name: "add", description: "Add numbers", inputSchema: { json: { type: "object" } } } }],
    })
  }),
)

for (const id of [
  "anthropic.claude-fable-5-1",
  "global.anthropic.claude-fable-5-1",
  "us.anthropic.claude-fable-5.1",
  "us.anthropic.claude-fable-5-10",
  "us.anthropic.claude-fable-6",
  "us.anthropic.claude-sonnet-6",
]) {
  it.effect(`adds binding defaults for ${id}`, () =>
    wire(request(id), (body) => {
      expect(body.additionalModelRequestFields).toMatchObject({
        thinking: { block_binding: { prefix_mismatch_behavior: "drop_block" } },
        anthropic_beta: [beta],
      })
    }),
  )
}

it.effect("merges configured and per-request overlays before adding binding defaults", () => {
  const model = AmazonBedrock.configure({
    auth: "sigv4",
    credentials,
    baseURL: "https://bedrock-runtime.test",
    http: { body: { additionalModelRequestFields: { anthropic_beta: ["existing-beta"], custom: "kept" } } },
  }).model("us.anthropic.claude-fable-5-1")
  return wire(
    LLMRequest.update(request(), {
      model,
      generation: { topK: 9 },
      http: {
        body: {
          serviceTier: { type: "default" },
          additionalModelRequestFields: {
            thinking: { type: "adaptive", display: "summarized" },
            output_config: { effort: "high" },
          },
        },
      },
    }),
    (body) => {
      expect(body.additionalModelRequestFields).toEqual({
        top_k: 9,
        custom: "kept",
        anthropic_beta: ["existing-beta", beta],
        thinking: {
          type: "adaptive",
          display: "summarized",
          block_binding: { prefix_mismatch_behavior: "drop_block" },
        },
        output_config: { effort: "high" },
      })
      expect(body.serviceTier).toEqual({ type: "default" })
    },
  )
})

for (const policy of ["error", "drop_block", "future-policy"]) {
  it.effect(`preserves explicit binding policy ${policy} and deduplicates beta`, () =>
    wire(
      LLMRequest.update(request(), {
        http: {
          body: {
            additionalModelRequestFields: {
              thinking: { type: "enabled", budget_tokens: 2048, block_binding: { prefix_mismatch_behavior: policy } },
              anthropic_beta: ["existing-beta", beta],
            },
          },
        },
      }),
      (body) => {
        expect(body.additionalModelRequestFields).toEqual({
          thinking: { type: "enabled", budget_tokens: 2048, block_binding: { prefix_mismatch_behavior: policy } },
          anthropic_beta: ["existing-beta", beta],
        })
      },
    ),
  )
}

it.effect("leaves disabled thinking and existing fields unchanged", () => {
  const additionalModelRequestFields = { thinking: { type: "disabled" }, anthropic_beta: ["existing-beta"] }
  return wire(LLMRequest.update(request(), { http: { body: { additionalModelRequestFields } } }), (body) => {
    expect(body.additionalModelRequestFields).toEqual(additionalModelRequestFields)
  })
})

it.effect("preserves an explicitly configured binding object without adding a second policy field", () => {
  const thinking = { type: "adaptive", block_binding: { mismatch_behavior: "error" } }
  return wire(
    LLMRequest.update(request(), { http: { body: { additionalModelRequestFields: { thinking } } } }),
    (body) => {
      expect(body.additionalModelRequestFields).toEqual({ thinking, anthropic_beta: [beta] })
    },
  )
})

for (const id of [
  "us.anthropic.claude-fable-5",
  "us.anthropic.claude-opus-4-8",
  "us.anthropic.claude-next",
  "amazon.nova-2-lite-v1:0",
  "global.openai.gpt-6-astra",
]) {
  it.effect(`does not enable thinking implicitly for ${id}`, () =>
    wire(request(id), (body) => {
      expect(body.additionalModelRequestFields).toBeUndefined()
    }),
  )
}

for (const id of [
  "us.anthropic.claude-fable-5-1",
  "us.anthropic.claude-fable-5-10",
  "us.anthropic.claude-fable-6",
  "us.anthropic.claude-sonnet-6",
]) {
  for (const thinking of [{ type: "adaptive" }, { type: "enabled", budget_tokens: 2048 }]) {
    it.effect(`adds binding to active ${thinking.type} thinking for ${id}`, () =>
      wire(
        LLMRequest.update(request(id), { http: { body: { additionalModelRequestFields: { thinking } } } }),
        (body) => {
          expect(body.additionalModelRequestFields).toEqual({
            thinking: { ...thinking, block_binding: { prefix_mismatch_behavior: "drop_block" } },
            anthropic_beta: [beta],
          })
        },
      ),
    )
  }
}

it.effect("adds binding to the supported Fable 5 adaptive mode", () => {
  const thinking = { type: "adaptive", display: "summarized" }
  return wire(
    LLMRequest.update(request("us.anthropic.claude-fable-5"), {
      http: { body: { additionalModelRequestFields: { thinking } } },
    }),
    (body) => {
      expect(body.additionalModelRequestFields).toEqual({
        thinking: { ...thinking, block_binding: { prefix_mismatch_behavior: "drop_block" } },
        anthropic_beta: [beta],
      })
    },
  )
})

for (const id of [
  "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
  "us.anthropic.claude-3-7-sonnet-20250219-v1:0",
  "us.anthropic.claude-opus-4",
  "us.anthropic.claude-haiku-4-5",
  "us.anthropic.claude-fable-5",
  "us.anthropic.claude-next",
]) {
  it.effect(`leaves unconfirmed manual binding support unchanged for ${id}`, () => {
    const additionalModelRequestFields = { thinking: { type: "enabled", budget_tokens: 1024 } }
    return wire(LLMRequest.update(request(id), { http: { body: { additionalModelRequestFields } } }), (body) => {
      expect(body.additionalModelRequestFields).toEqual(additionalModelRequestFields)
    })
  })
}

it.effect("honors explicit capability opt-in without changing manual thinking mode", () => {
  const input = request("us.anthropic.claude-sonnet-4-5-20250929-v1:0")
  const thinking = { type: "enabled", budget_tokens: 1024 }
  return wire(
    LLMRequest.update(input, {
      model: LanguageModel.update(input.model, { compatibility: { supportsThinkingBlockBinding: true } }),
      http: { body: { additionalModelRequestFields: { thinking } } },
    }),
    (body) => {
      expect(body.additionalModelRequestFields).toEqual({
        thinking: { ...thinking, block_binding: { prefix_mismatch_behavior: "drop_block" } },
        anthropic_beta: [beta],
      })
    },
  )
})

for (const thinking of [undefined, { type: "adaptive" }, { type: "enabled", budget_tokens: 2048 }]) {
  it.effect(`honors binding opt-out with ${thinking?.type ?? "implicit"} thinking`, () => {
    const input = request()
    return wire(
      LLMRequest.update(input, {
        model: LanguageModel.update(input.model, { compatibility: { supportsThinkingBlockBinding: false } }),
        http: { body: { additionalModelRequestFields: { ...(thinking ? { thinking } : {}) } } },
      }),
      (body) => {
        expect(body.additionalModelRequestFields).toEqual(thinking ? { thinking } : {})
      },
    )
  })
}

it.effect("honors explicit binding capability for an unversioned deployment", () => {
  const input = request("us.anthropic.custom-deployment")
  return wire(
    LLMRequest.update(input, {
      model: LanguageModel.update(input.model, { compatibility: { supportsThinkingBlockBinding: true } }),
    }),
    (body) => {
      expect(body.additionalModelRequestFields).toEqual({
        thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } },
        anthropic_beta: [beta],
      })
    },
  )
})

it.effect("does not add Anthropic controls to non-Anthropic active thinking", () => {
  const additionalModelRequestFields = { thinking: { type: "enabled" }, custom: "kept" }
  return wire(
    LLMRequest.update(request("amazon.nova-2-lite-v1:0"), {
      http: { body: { additionalModelRequestFields } },
    }),
    (body) => {
      expect(body.additionalModelRequestFields).toEqual(additionalModelRequestFields)
    },
  )
})
