import { describe, expect, test } from "bun:test"
import { applyGoalCommand, goalConfirmation, parseGoalCommand, parseGoalLimit } from "../src/util/goal"

describe("native goal commands", () => {
  test("empty input inspects; objectives preserve their text", () => {
    expect(parseGoalCommand()).toEqual({ action: "inspect" })
    expect(parseGoalCommand("  ")).toEqual({ action: "inspect" })
    expect(parseGoalCommand("  Fix the flaky test  ")).toEqual({ action: "set", text: "Fix the flaky test" })
    expect(parseGoalCommand("set pause the deploy\nand diagnose")).toEqual({
      action: "set",
      text: "pause the deploy\nand diagnose",
    })
    expect(parseGoalCommand("update finish migration")).toEqual({ action: "update", text: "finish migration" })
  })

  test("control arguments are validated instead of becoming chat prompts", () => {
    for (const action of ["pause", "resume", "clear"] as const) {
      expect(parseGoalCommand(action)).toEqual({ action })
      expect(() => parseGoalCommand(`${action} extra`)).toThrow("takes no arguments")
    }
    expect(parseGoalCommand("auto on")).toEqual({ action: "auto", autoContinue: true })
    expect(parseGoalCommand("auto off")).toEqual({ action: "auto", autoContinue: false })
    for (const input of ["set", "update", "auto", "auto yes", "limit", "limit 101", "limit 3.5"]) {
      expect(() => parseGoalCommand(input)).toThrow()
    }
  })

  test("continuation limits use the server's bounded integer range", () => {
    expect(parseGoalCommand("limit 10")).toEqual({ action: "limit", maxContinuations: 10 })
    expect(parseGoalLimit(" 1 ")).toBe(1)
    expect(parseGoalLimit("100")).toBe(100)
    for (const input of ["0", "-1", "101", "1e1", "2.0", "Infinity", "10 extra"]) {
      expect(() => parseGoalLimit(input)).toThrow()
    }
  })

  test("feedback describes the action and limits no-start guidance to relevant changes", () => {
    expect(goalConfirmation({ action: "pause" })).toBe("Goal paused.")
    expect(goalConfirmation({ action: "clear" })).toBe("Goal cleared.")
    expect(goalConfirmation({ action: "auto", autoContinue: false })).toBe("Automatic continuation disabled.")
    expect(goalConfirmation({ action: "limit", maxContinuations: 5 })).toBe(
      "Continuation limit set to 5; usage preserved.",
    )
    for (const command of [
      { action: "set", text: "finish" },
      { action: "update", text: "finish carefully" },
      { action: "resume" },
      { action: "auto", autoContinue: true },
    ] as const) {
      expect(goalConfirmation(command)).toContain("does not start execution")
    }
  })

  test("controls dispatch native CRUD without prompts and edits preserve the budget", async () => {
    const calls: { method: string; input: object }[] = []
    const record = (method: string) => async (input: object) => {
      calls.push({ method, input })
    }
    const api = {
      setGoal: record("set"),
      updateGoal: record("update"),
      pauseGoal: record("pause"),
      resumeGoal: record("resume"),
      clearGoal: record("clear"),
    }
    for (const input of ["set finish", "update finish carefully", "auto on", "limit 4", "pause", "resume", "clear"]) {
      const command = parseGoalCommand(input)
      if (command.action === "inspect") throw new Error("Expected mutation")
      await applyGoalCommand(api, "session-1", command)
    }
    expect(calls).toEqual([
      { method: "set", input: { sessionID: "session-1", text: "finish", autoContinue: false } },
      { method: "update", input: { sessionID: "session-1", text: "finish carefully" } },
      { method: "update", input: { sessionID: "session-1", autoContinue: true } },
      { method: "update", input: { sessionID: "session-1", maxContinuations: 4 } },
      { method: "pause", input: { sessionID: "session-1" } },
      { method: "resume", input: { sessionID: "session-1" } },
      { method: "clear", input: { sessionID: "session-1" } },
    ])
  })
})
