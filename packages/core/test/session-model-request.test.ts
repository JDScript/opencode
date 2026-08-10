import { describe, expect, test } from "bun:test"
import { Message, ToolResultPart } from "@opencode-ai/ai"
import { boundImages, composeHttpMiddleware, unsupportedParts } from "@opencode-ai/core/session/model-request"
import type { SessionHttpMiddleware } from "@opencode-ai/plugin/effect/session"
import { Effect } from "effect"
import { HttpClientRequest, HttpClientResponse } from "effect/unstable/http"

const capabilities = (input: string[]) => ({ tools: true, input, output: ["text"] })

describe("SessionModelRequest.unsupportedParts", () => {
  test("replaces unsupported user media with a visible error", () => {
    const messages = unsupportedParts(
      [
        Message.user([
          Message.text("Describe this image"),
          { type: "media", mediaType: "image/png", data: "aGVsbG8=", filename: "logo.png" },
        ]),
      ],
      capabilities(["text"]),
    )

    expect(messages[0]?.content).toEqual([
      Message.text("Describe this image"),
      Message.text('ERROR: Cannot read "logo.png" (this model does not support image input). Inform the user.'),
    ])
  })

  test("replaces unsupported media nested in tool results", () => {
    const messages = unsupportedParts(
      [
        Message.tool(
          ToolResultPart.make({
            id: "call_1",
            name: "read",
            result: {
              type: "content",
              value: [
                { type: "text", text: "Image read successfully" },
                { type: "file", uri: "data:image/png;base64,aGVsbG8=", mime: "image/png", name: "logo.png" },
              ],
            },
          }),
        ),
      ],
      capabilities(["text"]),
    )

    expect(messages[0]?.content[0]).toMatchObject({
      type: "tool-result",
      result: {
        type: "content",
        value: [
          { type: "text", text: "Image read successfully" },
          {
            type: "text",
            text: 'ERROR: Cannot read "logo.png" (this model does not support image input). Inform the user.',
          },
        ],
      },
    })
  })

  test("preserves supported media", () => {
    const message = Message.user({ type: "media", mediaType: "image/png", data: "aGVsbG8=" })
    expect(unsupportedParts([message], capabilities(["text", "image"]))[0]?.content).toEqual(message.content)
  })
})

describe("SessionModelRequest.boundImages", () => {
  test("preserves images below the trigger", () => {
    const messages = [Message.user({ type: "media", mediaType: "image/png", data: "aGVsbG8=" })]
    expect(boundImages(messages)).toBe(messages)
  })

  test("replaces oldest images until the retained payload reaches the target", () => {
    const image = "a".repeat(9 * 1024 * 1024)
    const messages = [
      Message.user({ type: "media", mediaType: "image/png", data: image, filename: "first.png" }),
      Message.user({ type: "media", mediaType: "image/png", data: image, filename: "second.png" }),
      Message.user({ type: "media", mediaType: "image/png", data: image, filename: "third.png" }),
    ]
    const result = boundImages(messages)

    expect(result[0]?.content[0]).toMatchObject({ type: "text" })
    expect(result[1]?.content[0]).toMatchObject({ type: "text" })
    expect(result[2]?.content[0]).toMatchObject({ type: "media", filename: "third.png" })
  })

  test("replaces images nested in tool results", () => {
    const image = "a".repeat(13 * 1024 * 1024)
    const result = boundImages([
      Message.tool(
        ToolResultPart.make({
          id: "call_1",
          name: "read",
          result: {
            type: "content",
            value: [
              { type: "file", uri: `data:image/png;base64,${image}`, mime: "image/png", name: "first.png" },
              { type: "file", uri: `data:image/png;base64,${image}`, mime: "image/png", name: "second.png" },
            ],
          },
        }),
      ),
    ])

    expect(result[0]?.content[0]).toMatchObject({
      type: "tool-result",
      result: {
        type: "content",
        value: [{ type: "text" }, { type: "file", name: "second.png" }],
      },
    })
  })
})

describe("SessionModelRequest.composeHttpMiddleware", () => {
  test("keeps WebSocket eligibility when no middleware is registered", () => {
    expect(composeHttpMiddleware([])).toBeUndefined()
  })

  test("forces HTTP when middleware is registered", () => {
    expect(composeHttpMiddleware([(request, next) => next(request)])).toBeFunction()
  })

  test("preserves middleware nesting order", async () => {
    const order: string[] = []
    const middleware =
      (name: string): SessionHttpMiddleware =>
      (request, next) =>
        Effect.sync(() => order.push(`${name}:before`)).pipe(
          Effect.andThen(next(request)),
          Effect.tap(() => Effect.sync(() => order.push(`${name}:after`))),
        )
    const composed = composeHttpMiddleware([middleware("first"), middleware("second")])
    if (!composed) throw new Error("Expected HTTP middleware")
    const request = HttpClientRequest.post("https://provider.test/responses").pipe(
      HttpClientRequest.bodyText("payload", "text/plain"),
    )
    const response = await Effect.runPromise(
      composed(request, (sent) =>
        Effect.sync(() => {
          order.push("send")
          return HttpClientResponse.fromWeb(sent, new Response("response"))
        }),
      ),
    )

    expect(order).toEqual(["second:before", "first:before", "send", "first:after", "second:after"])
    expect(await Effect.runPromise(response.text)).toBe("response")
  })

  test("preserves a synthetic replacement response", async () => {
    let sent = false
    const composed = composeHttpMiddleware([() => Effect.succeed(new Response("synthetic", { status: 202 }))])
    if (!composed) throw new Error("Expected HTTP middleware")
    const request = HttpClientRequest.post("https://provider.test/responses")
    const response = await Effect.runPromise(
      composed(request, (input) =>
        Effect.sync(() => {
          sent = true
          return HttpClientResponse.fromWeb(input, new Response("network"))
        }),
      ),
    )

    expect(sent).toBe(false)
    expect(response.status).toBe(202)
    expect(response.request.url).toBe(request.url)
    expect(await Effect.runPromise(response.text)).toBe("synthetic")
  })
})
