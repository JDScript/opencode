import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { PluginSuperseded } from "@opencode/core/plugin/superseded"

// FORK: configured packages replaced by a built-in plugin are dropped before loading.
describe("PluginSuperseded", () => {
  test("strips version and tag suffixes but keeps scopes", () => {
    expect(PluginSuperseded.packageName("@openviking/opencode-plugin")).toBe("@openviking/opencode-plugin")
    expect(PluginSuperseded.packageName("@openviking/opencode-plugin@latest")).toBe("@openviking/opencode-plugin")
    expect(PluginSuperseded.packageName("@openviking/opencode-plugin@2026.9.10")).toBe("@openviking/opencode-plugin")
    expect(PluginSuperseded.packageName("some-plugin@1.0.0")).toBe("some-plugin")
    expect(PluginSuperseded.packageName("/abs/local/dir")).toBe("/abs/local/dir")
  })

  test("drops superseded add operations and keeps everything else", async () => {
    const operations = [
      { type: "add" as const, target: "@openviking/opencode-plugin@latest", options: {} },
      { type: "add" as const, target: "other-plugin", options: {} },
      { type: "remove" as const, target: "@openviking/opencode-plugin" },
    ]
    const kept = await Effect.runPromise(PluginSuperseded.filter(operations))
    expect(kept).toEqual([operations[1], operations[2]])
  })
})
