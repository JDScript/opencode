// FORK: Keep the tool-result image allowlist in sync with upstream dev c10134729.
import type { BedrockConverseBody } from "../bedrock-converse.js"
import { ProviderShared } from "../shared.js"
import type { BedrockMedia } from "./bedrock-media.js"

const supportsToolImages = (modelID: string) => {
  const id = modelID.toLowerCase()
  return ["anthropic.", "nova", "llama4", "llama-4"].some((name) => id.includes(name))
}

export const collector = (modelID: string) => {
  const nested = supportsToolImages(modelID)
  const images: BedrockMedia.ImageBlock[] = []
  return {
    lower(
      media: ReadonlyArray<BedrockMedia.ImageBlock | BedrockMedia.DocumentBlock | { text: string }>,
      filename?: string,
    ) {
      return media.map((block) => {
        if (nested || !("image" in block)) return block
        images.push(block)
        return {
          text: `Image${filename === undefined ? "" : ` ${ProviderShared.encodeJson(filename)}`} attached as a separate content block below.`,
        }
      })
    },
    flush(messages: Array<BedrockConverseBody["messages"][number]>) {
      if (images.length === 0) return
      const previous = messages.at(-1)
      if (previous?.role !== "user") return
      // Defer until the merged user message is complete: every toolResult must precede the images.
      // Appending here also preserves Converse's alternating user/assistant roles.
      messages[messages.length - 1] = { role: "user", content: [...previous.content, ...images.splice(0)] }
    },
  }
}

export type Collector = ReturnType<typeof collector>
export * as BedrockToolImages from "./bedrock-tool-images.js"
