import { afterEach, describe, expect, test } from "bun:test"
import { Runtime } from "../src/runtime.js"

afterEach(() => Runtime.reset())

describe("Runtime.serial", () => {
  test("runs work for one session in order and keeps going after a failure", async () => {
    const order: string[] = []
    const first = Runtime.serial("s", async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      order.push("first")
    })
    const failed = Runtime.serial("s", async () => {
      order.push("second")
      throw new Error("boom")
    })
    const third = Runtime.serial("s", async () => {
      order.push("third")
    })
    await first
    await expect(failed).rejects.toThrow("boom")
    await third
    expect(order).toEqual(["first", "second", "third"])
  })

  test("different sessions do not wait on each other", async () => {
    const order: string[] = []
    const slow = Runtime.serial("a", async () => {
      await new Promise((resolve) => setTimeout(resolve, 30))
      order.push("a")
    })
    await Runtime.serial("b", async () => {
      order.push("b")
    })
    await slow
    expect(order).toEqual(["b", "a"])
  })
})

describe("Runtime.configured", () => {
  const base = { enabled: true, credentialSource: "auto", apiKey: "", configPath: "" } as Runtime.Config
  test("inert without credentials or a config file", () => {
    expect(Runtime.configured(base)).toBe(false)
  })
  test("active with ovcli credentials, an api key, or a config file", () => {
    expect(Runtime.configured({ ...base, credentialSource: "ovcli" })).toBe(true)
    expect(Runtime.configured({ ...base, apiKey: "k" })).toBe(true)
    expect(Runtime.configured({ ...base, configPath: "/x/openviking-config.json" })).toBe(true)
  })
  test("disabled in config wins", () => {
    expect(Runtime.configured({ ...base, credentialSource: "ovcli", enabled: false })).toBe(false)
  })
})
