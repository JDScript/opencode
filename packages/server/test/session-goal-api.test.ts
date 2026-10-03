import { expect } from "bun:test"
import { Session } from "@opencode/schema/session"
import { Effect, Schema } from "effect"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

const SessionResponse = Schema.Struct({ data: Schema.toEncoded(Session.Info) })
const GoalResponse = Schema.Struct({ data: Schema.NullOr(Session.Goal) })

it.live("serves goal lifecycle and rejects invalid edits without changing state", () =>
  Effect.gen(function* () {
    const tmp = yield* tmpdirScoped("opencode-session-goal-api-")
    const handler = yield* ServerFetch.make({
      app: { version: "test" },
      database: { path: ":memory:" },
      fs: { filewatcher: false },
      models: { fetch: false },
      config: { directory: tmp.path, project: false, content: "{}" },
    })
    const request = (path: string, method = "GET", body?: unknown, valid = true) =>
      Effect.promise(async () => {
        const response = await handler(
          new Request(`http://opencode.local${path}`, {
            method,
            headers: body === undefined ? undefined : { "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
          }),
        )
        const text = await response.text()
        expect(response.status, `${method} ${path}: ${text}`).toBeGreaterThanOrEqual(valid ? 200 : 400)
        expect(response.status, `${method} ${path}: ${text}`).toBeLessThan(valid ? 300 : 500)
        const json: unknown = text ? JSON.parse(text) : undefined
        return json
      })
    const created = Schema.decodeUnknownSync(SessionResponse)(yield* request("/api/session", "POST", {}))
    const path = `/api/session/${created.data.id}`
    const goal = () =>
      request(`${path}/goal`).pipe(Effect.map(Schema.decodeUnknownSync(GoalResponse)), Effect.map((value) => value.data))
    const session = () =>
      request(path).pipe(Effect.map(Schema.decodeUnknownSync(SessionResponse)), Effect.map((value) => value.data))

    expect(created.data.goal).toBeUndefined()
    expect(yield* goal()).toBeNull()
    yield* request(`${path}/goal`, "PUT", { text: "Implement the objective" })
    const set = yield* goal()
    expect(set).toMatchObject({
      text: "Implement the objective",
      status: "active",
      autoContinue: false,
      maxContinuations: 10,
      continuationsUsed: 0,
    })
    if (!set) return yield* Effect.die("PUT did not create a goal")
    expect((yield* session()).goal).toEqual(set)
    expect(set.id.length).toBeGreaterThan(0)

    yield* request(`${path}/goal`, "PATCH", { text: "Edited objective", autoContinue: true })
    const edited = yield* goal()
    expect(edited).toMatchObject({
      id: set.id,
      text: "Edited objective",
      status: "active",
      autoContinue: true,
      maxContinuations: set.maxContinuations,
      continuationsUsed: set.continuationsUsed,
    })
    if (!edited) return yield* Effect.die("PATCH removed the goal")
    expect(edited.revision).toBeGreaterThan(set.revision)
    yield* request(`${path}/goal/pause`, "POST")
    expect(yield* goal()).toMatchObject({ id: set.id, status: "paused", continuationsUsed: 0 })
    yield* request(`${path}/goal/resume`, "POST")
    const resumed = yield* goal()
    expect(resumed).toMatchObject({ id: set.id, status: "active", continuationsUsed: 0 })
    if (!resumed) return yield* Effect.die("Resume removed the goal")
    expect((yield* session()).goal).toEqual(resumed)

    for (const input of [
      { text: "" },
      { text: "   " },
      { text: 42 },
      { maxContinuations: 0 },
      { maxContinuations: 101 },
    ]) {
      yield* request(`${path}/goal`, "PATCH", input, false)
      expect(yield* goal()).toEqual(resumed)
      expect((yield* session()).goal).toEqual(resumed)
    }

    yield* request(`${path}/goal`, "DELETE")
    expect(yield* goal()).toBeNull()
    expect((yield* session()).goal).toBeUndefined()
  }).pipe(Effect.scoped),
)
