export * as SessionGoal from "./session-goal.js"

import { Schema } from "effect"
import { NonNegativeInt, optional } from "./schema.js"

export const Text = Schema.String.check(Schema.isPattern(/^(?=[\s\S]*\S)[\s\S]{1,4000}$/u))
export const Limit = NonNegativeInt.check(Schema.isBetween({ minimum: 1, maximum: 100 }))
export const Status = Schema.Literals(["active", "paused", "completed", "blocked"])

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: Schema.String,
  revision: NonNegativeInt,
  text: Text,
  status: Status,
  autoContinue: Schema.Boolean,
  maxContinuations: Limit,
  continuationsUsed: NonNegativeInt,
  reason: Schema.String.pipe(optional),
}).annotate({ identifier: "Session.Goal" })

export interface Set extends Schema.Schema.Type<typeof Set> {}
export const Set = Schema.Struct({
  text: Text,
  autoContinue: Schema.Boolean.pipe(optional),
  maxContinuations: Limit.pipe(optional),
}).annotate({ identifier: "Session.Goal.Set" })

export interface Update extends Schema.Schema.Type<typeof Update> {}
export const Update = Schema.Struct({
  text: Text.pipe(optional),
  autoContinue: Schema.Boolean.pipe(optional),
  maxContinuations: Limit.pipe(optional),
}).annotate({ identifier: "Session.Goal.Update" })

export interface Report extends Schema.Schema.Type<typeof Report> {}
export const Report = Schema.Struct({
  id: Schema.String,
  revision: NonNegativeInt,
  status: Schema.Literals(["completed", "blocked"]),
  reason: Schema.String.pipe(optional),
}).annotate({ identifier: "Session.Goal.Report" })
