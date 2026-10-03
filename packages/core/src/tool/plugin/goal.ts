export * as GoalTool from "./goal.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import { ToolFailure } from "@opencode/ai"
import { Effect, Schema } from "effect"
import { SessionGoal } from "../../session/goal.js"
import { SessionSchema } from "../../session/schema.js"
import { Permission } from "../../permission.js"

export const Plugin = {
  id: "opencode.tool.goal",
  effect: Effect.fn("GoalTool.Plugin")(function* (ctx: Context) {
    const goals = yield* SessionGoal.make()
    const permission = yield* Permission.Service
    yield* ctx.tool.transform((editor) => {
      editor.add({
        name: "goal_read",
        options: { codemode: false },
        description: "Read the current session goal and its identity/revision. This does not change it or start work.",
        // Empty Effect structs also accept arrays, which providers reject as function parameters.
        input: { type: "object", properties: {}, additionalProperties: false },
        output: Schema.Struct({ goal: Schema.NullOr(SessionSchema.Goal) }),
        execute: (_, context) =>
          permission
            .assert({
              action: "goal_read",
              resources: ["*"],
              sessionID: context.sessionID,
              agent: context.agent,
              source: { type: "tool", messageID: context.messageID, id: context.id },
            })
            .pipe(
              Effect.andThen(goals.get(context.sessionID)),
              Effect.map((goal) => ({
                output: { goal: goal ?? null },
                content: [{ type: "text" as const, text: JSON.stringify(goal ?? null) }],
                metadata: {},
              })),
              Effect.mapError((error) => new ToolFailure({ message: "Unable to read session goal", error })),
            ),
      })
      editor.add({
        name: "goal_report",
        options: { codemode: false },
        description:
          "Mark the active goal completed only with evidence, or blocked when user input is needed. Requires its current id and revision. Cannot edit objectives, resume, clear, or enable automation.",
        input: SessionGoal.Report,
        output: Schema.Struct({ goal: Schema.NullOr(SessionSchema.Goal) }),
        execute: (input, context) =>
          permission
            .assert({
              action: "goal_report",
              resources: ["*"],
              sessionID: context.sessionID,
              agent: context.agent,
              source: { type: "tool", messageID: context.messageID, id: context.id },
            })
            .pipe(
              Effect.andThen(goals.report(context.sessionID, input)),
              Effect.map((goal) => ({
                output: { goal: goal ?? null },
                content: [{ type: "text" as const, text: JSON.stringify(goal ?? null) }],
                metadata: {},
              })),
              Effect.mapError(
                (error) =>
                  new ToolFailure({
                    message: "Goal report rejected (missing, inactive, stale, or permission denied)",
                    error,
                  }),
              ),
            ),
      })
    })
  }),
}
