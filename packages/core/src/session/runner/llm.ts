export * as SessionRunnerLLM from "./llm.js"

import { Message } from "@opencode/ai"
import { Event } from "@opencode/schema/event"
import { and, desc, eq, sql } from "drizzle-orm"
import { Cause, Effect, Exit, FiberMap, Layer } from "effect"
import { Database } from "../../database/database.js"
import { Bus } from "../../bus.js"
import { LocationLifecycle } from "../../location-lifecycle.js"
import { InstructionState } from "../instruction-state.js"
import { SessionCompaction } from "../compaction.js"
import { SessionContext } from "../context.js"
import { SessionEvent } from "../event.js"
import { SessionInbox } from "../inbox.js"
import { SessionHistory } from "../history.js"
import { SessionProviderContext } from "../provider-context.js"
import { SessionModelRequest } from "../model-request.js"
import { SessionModelTransport } from "../model-transport.js"
import { SessionMessage } from "../message.js"
import { SessionSchema } from "../schema.js"
import { SessionStore } from "../store.js"
import { SessionGoal } from "../goal.js"
import { SessionMessageTable } from "../sql.js"
import { SessionTitle } from "../title.js"
import { DrainResult, Service, type Interface } from "./index.js"
import { Snapshot } from "../../snapshot.js"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { llmClient } from "../../effect/app-node-platform.js"
import { StepFailedError } from "../error.js"
import { SessionRunnerRetry } from "./retry.js"
import { SessionStep } from "./step.js"
import { ToolOutput } from "../../tool-output.js"
import { Plugin } from "../../plugin.js"
import { MAX_STEPS_PROMPT } from "./max-steps.js"

const CONTINUE_AFTER_INCOMPLETE_STREAM =
  "The previous response was interrupted. Continue from where you left off without repeating completed content."
const GOAL_CONTINUATION =
  "Continue the active session objective within the latest user scope and existing permissions. If finished, report completed; if user input is needed, report blocked and stop."

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const lifecycle = yield* LocationLifecycle.Service
    const store = yield* SessionStore.Service
    const context = yield* SessionContext.Service
    const modelTransport = yield* SessionModelTransport.Service
    const db = (yield* Database.Service).db
    const compaction = yield* SessionCompaction.Service
    const plugins = yield* Plugin.Service
    const title = yield* SessionTitle.Service
    const steps = yield* SessionStep.make
    // Title generation starts once input is visible and must not delay model execution.
    const titles = yield* FiberMap.make<SessionSchema.ID, void, never>()

    const drain = Effect.fn("SessionRunner.drain")(function* (input: Parameters<Interface["drain"]>[0]) {
      const sessionID = input.sessionID
      let force = input.force
      let continuing = input.continuation !== undefined
      let step = input.continuation?.step ?? 1
      let entering = true
      let normalCompleted = false
      let emptyCompleted = false
      let automaticGoal = input.continuation?.goal
      let admitGoal = false
      const promotable = input.promotable ?? "input"
      if (!force && !continuing) {
        const pending = yield* SessionInbox.nextPromotable(db, sessionID, "input")
        if (!pending) return DrainResult.Complete()
        const control = pending.type === "compaction" || pending.type === "move"
        if (promotable === "steer" && pending.delivery === "queue" && !control) return DrainResult.Complete()
      }
      yield* plugins.awaitActivation
      yield* settleStaleCompactions(sessionID)
      yield* settleStaleToolCalls(sessionID)

      const advanceToStep = Effect.fn("SessionRunner.advanceToStep")(() =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            while (true) {
              if (lifecycle.isClosed()) {
                yield* restore(modelTransport.close(sessionID))
                return DrainResult.Reloaded({
                  force,
                  continuation: continuing ? { step, goal: automaticGoal } : undefined,
                })
              }
              // Location entry and idle boundaries allow queued controls, not necessarily queued prompts.
              const pending = yield* SessionInbox.serialized(
                sessionID,
                Effect.gen(function* () {
                  const next = yield* SessionInbox.nextPromotable(
                    db,
                    sessionID,
                    entering || !continuing ? "input" : "steer",
                  )
                  if (next?.type === "compaction")
                    yield* bus.publishAll([
                      [SessionEvent.InboxDelivered, { sessionID, inboxID: next.id }],
                      [SessionEvent.Compaction.Started, { sessionID, reason: "manual", recent: "", inputID: next.id }],
                    ])
                  if (next?.type === "move")
                    yield* restore(
                      Effect.gen(function* () {
                        yield* modelTransport.close(sessionID)
                        yield* bus.publishAll([
                          [SessionEvent.InboxDelivered, { sessionID, inboxID: next.id }],
                          [SessionEvent.Moved, { sessionID, ...next.payload }],
                        ])
                      }),
                    )
                  return next
                }),
              )
              if (!continuing && pending?.delivery !== "steer") {
                entering = true
                step = 1
              }
              if (pending?.type === "move")
                return DrainResult.Moved({ continuation: continuing ? { step, goal: automaticGoal } : undefined })
              if (pending?.type === "compaction") {
                const session = yield* store.get(sessionID)
                if (!session) return yield* Effect.die(new Error(`Session not found: ${sessionID}`))
                const compacted = yield* restore(
                  Effect.gen(function* () {
                    return yield* compaction.compactManual({
                      session,
                      resolveContext: (session) =>
                        Effect.gen(function* () {
                          const selected = yield* context.select(session.id)
                          const model = yield* context.resolveModel(selected.session)
                          // Preview updates without admitting them after the already-delivered compaction marker.
                          const history = yield* SessionHistory.preview(
                            db,
                            session.id,
                            selected.instructions,
                            SessionProviderContext.provenance(model) ?? "local",
                          )
                          return {
                            session: selected.session,
                            agent: selected.agent,
                            tools: selected.tools,
                            model,
                            initial: history.initial,
                            messages: history.messages,
                            instructionUpdate: history.instructionUpdate,
                          }
                        }),
                      prepare: context.request.compaction,
                      messages: yield* store.context(sessionID),
                      inputID: pending.id,
                      started: true,
                    })
                  }),
                ).pipe(Effect.exit)
                if (Exit.isFailure(compacted)) {
                  yield* bus.publish(SessionEvent.Compaction.Failed, {
                    sessionID,
                    reason: "manual",
                    error: Cause.hasInterruptsOnly(compacted.cause)
                      ? { type: "aborted", message: "Compaction cancelled" }
                      : { type: "compaction.failed", message: Cause.pretty(compacted.cause) },
                    inputID: pending.id,
                  })
                  return yield* Effect.failCause(compacted.cause)
                }
                force = false
                continue
              }
              if (!force && !continuing && (!pending || (pending.delivery === "queue" && promotable === "steer"))) {
                if (pending || !normalCompleted || promotable === "steer") return DrainResult.Complete()
                const continued = yield* SessionInbox.serialized(
                  sessionID,
                  Effect.gen(function* () {
                    if (yield* SessionInbox.nextPromotable(db, sessionID, "input")) return "input" as const
                    const session = yield* store.get(sessionID)
                    const goal = session?.goal
                    if (session?.parentID || !goal || goal.status !== "active" || !goal.autoContinue || session?.revert)
                      return false
                    if (automaticGoal && (goal.id !== automaticGoal.id || goal.revision !== automaticGoal.revision))
                      return false
                    if (emptyCompleted || goal.continuationsUsed >= goal.maxContinuations) {
                      yield* bus.publish(SessionEvent.Goal.StatusChanged, {
                        sessionID,
                        status: emptyCompleted ? "blocked" : "paused",
                        reason: emptyCompleted ? "The assistant returned no output" : "Continuation limit reached",
                      })
                      return false
                    }
                    automaticGoal = { id: goal.id, revision: goal.revision }
                    admitGoal = true
                    return true
                  }),
                )
                if (continued === "input") continue
                if (!continued) return DrainResult.Complete()
                continuing = true
              }
              const ready = yield* restore(
                Effect.gen(function* () {
                  const selected = yield* prepareContext(sessionID)
                  const promoted = yield* SessionInbox.promote(
                    db,
                    bus,
                    sessionID,
                    entering && !continuing ? promotable : "steer",
                  )
                  // A control admitted during context preparation owns this boundary.
                  if (promoted === undefined) return undefined
                  if (promoted > 0 && !selected.session.parentID && SessionTitle.isUntitled(selected.session))
                    yield* FiberMap.run(titles, sessionID, title.generate(sessionID), {
                      onlyIfMissing: true,
                    })
                  if (promoted > 0) {
                    step = 1
                    automaticGoal = undefined
                    admitGoal = false
                  }
                  if (automaticGoal) {
                    const goal = (yield* store.get(sessionID))?.goal
                    if (
                      !goal ||
                      goal.status !== "active" ||
                      goal.id !== automaticGoal.id ||
                      goal.revision !== automaticGoal.revision
                    )
                      return { _tag: "Stopped" as const }
                  }
                  return { _tag: "Ready" as const, context: yield* context.load(selected) }
                }),
              )
              if (ready?._tag === "Stopped") return DrainResult.Complete()
              if (ready) return ready
            }
          }),
        ),
      )

      while (true) {
        const next = yield* advanceToStep().pipe(
          Effect.tapCause((cause) =>
            automaticGoal && !Cause.hasInterruptsOnly(cause)
              ? SessionGoal.stop(store, bus, sessionID, "blocked", Cause.pretty(cause), automaticGoal)
              : Effect.void,
          ),
        )
        if (next._tag !== "Ready") return next
        const result = yield* runStep(next.context, step, automaticGoal, admitGoal).pipe(
          Effect.tapCause((cause) =>
            automaticGoal && !Cause.hasInterruptsOnly(cause)
              ? SessionGoal.stop(store, bus, sessionID, "blocked", Cause.pretty(cause), automaticGoal)
              : Effect.void,
          ),
        )
        admitGoal = false
        continuing = result.needsContinuation
        normalCompleted = result.normal
        emptyCompleted = result.empty
        step++
        force = false
        entering = false
      }
    })

    const prepareContext = Effect.fn("SessionRunner.prepareContext")(function* (sessionID: SessionSchema.ID) {
      const selected = yield* context.select(sessionID)
      // A blocked initial instruction baseline must leave admitted input pending.
      yield* InstructionState.prepare(db, bus, selected.instructions, sessionID)
      return selected
    })

    /** Owns logical Step policy; each attempt owns its streaming, tools, and durable settlement. */
    const runStep = Effect.fn("SessionRunner.runStep")(function* (
      first: SessionContext.Loaded,
      step: number,
      goal?: { id: string; revision: number },
      admitGoal = false,
    ) {
      const sessionID = first.session.id
      const continuationID = Event.ID.create()
      let assistantMessageID = SessionMessage.ID.create()
      const retry = yield* SessionRunnerRetry.make(bus, sessionID)
      let initial: SessionContext.Loaded | undefined = first
      let recoverOverflow = true
      let recoverContinuation = true
      while (true) {
        if (goal) {
          const current = (yield* store.get(sessionID))?.goal
          if (!current || current.status !== "active" || current.id !== goal.id || current.revision !== goal.revision)
            return { needsContinuation: false, normal: false, empty: false }
        }
        // Reuse boundary preparation once; retries refresh context without delivering more input.
        const loaded = initial ?? (yield* prepareContext(sessionID).pipe(Effect.flatMap(context.load)))
        initial = undefined
        const compactionInput = {
          context: loaded,
          prepare: context.request.compaction,
        }
        if (compaction.required({ messages: loaded.messages, resolved: loaded.model, context: loaded })) {
          const result = yield* compaction.compact(compactionInput)
          if (result.status !== "completed") return yield* new StepFailedError({ error: result.error })
          if (result.recoveredOverflow) recoverOverflow = false
          assistantMessageID = SessionMessage.ID.create()
          continue
        }
        const stepLimitReached = loaded.agent.info.steps !== undefined && step >= loaded.agent.info.steps
        const transcript = SessionModelRequest.baseTranscript({
          agent: loaded.agent.info,
          model: loaded.model,
          tools: loaded.tools,
          initial: loaded.initial,
          messages: loaded.messages,
        })
        const prepared = yield* context.request.primary({
          session: loaded.session,
          agent: loaded.agent.id,
          model: loaded.model,
          tools: loaded.tools,
          system: transcript.system,
          messages: stepLimitReached
            ? [...transcript.messages, Message.assistant(MAX_STEPS_PROMPT)]
            : admitGoal
              ? [
                  ...transcript.messages,
                  Message.make({
                    id: SessionMessage.ID.fromEvent(continuationID),
                    role: "user",
                    content: GOAL_CONTINUATION,
                  }),
                ]
              : transcript.messages,
          // Keep tool definitions on the final Step to preserve the provider's cached prefix.
          toolChoice: stepLimitReached ? "none" : undefined,
          webSocket: "session",
        })
        if (goal && !prepared.canReportGoal) {
          yield* SessionGoal.stop(
            store,
            bus,
            sessionID,
            "blocked",
            "Automatic continuation requires an available goal_report tool on a tool-capable model",
            goal,
          )
          return { needsContinuation: false, normal: false, empty: false }
        }
        if (admitGoal && goal) {
          const admitted = yield* SessionInbox.serialized(
            sessionID,
            Effect.gen(function* () {
              if (yield* SessionInbox.nextPromotable(db, sessionID, "input")) return "input" as const
              const current = (yield* store.get(sessionID))?.goal
              if (
                !current ||
                current.status !== "active" ||
                !current.autoContinue ||
                current.id !== goal.id ||
                current.revision !== goal.revision
              )
                return false
              yield* bus.publishAll([
                [SessionEvent.Goal.Continued, { sessionID }, { commit: () => store.setExecutionGoal(sessionID, goal) }],
                [
                  SessionEvent.Synthetic,
                  { sessionID, text: GOAL_CONTINUATION, description: "Continuing session goal" },
                  { id: continuationID },
                ],
              ])
              return true
            }),
          )
          if (admitted !== true) return { needsContinuation: admitted === "input", normal: false, empty: false }
          admitGoal = false
        }
        const outcome = yield* steps.attempt({
          isLocationClosed: lifecycle.isClosed,
          sessionID,
          assistantMessageID,
          agent: loaded.agent.id,
          model: loaded.model,
          prepared,
          retry: (cause, error, proposed) =>
            retry.decide({
              cause,
              error,
              agent: loaded.agent.id,
              model: loaded.model.ref,
              hook: prepared.retry,
              retry: proposed,
            }),
          recoverContinuation,
          recoverOverflow: Effect.suspend(() =>
            recoverOverflow && compaction.enabled()
              ? compaction
                  .compact({ ...compactionInput, overflow: true })
                  .pipe(Effect.map((result) => result.status === "completed"))
              : Effect.succeed(false),
          ),
        })
        const completed = yield* SessionStep.Outcome.$match(outcome, {
          Completed: (outcome) => Effect.succeed(outcome.needsContinuation),
          Retry: (outcome) =>
            retry.wait({
              decision: outcome.decision,
              error: outcome.error,
              assistantMessageID,
            }),
          Continue: Effect.fnUntraced(function* (outcome) {
            yield* retry.wait({
              decision: outcome.decision,
              error: outcome.error,
              assistantMessageID,
            })
            yield* bus.publish(SessionEvent.Synthetic, { sessionID, text: CONTINUE_AFTER_INCOMPLETE_STREAM })
            assistantMessageID = SessionMessage.ID.create()
          }),
          Compacted: Effect.fnUntraced(function* () {
            recoverOverflow = false
            assistantMessageID = SessionMessage.ID.create()
          }),
          RecoverFull: Effect.fnUntraced(function* () {
            recoverContinuation = false
          }),
        })
        if (completed !== undefined) {
          const message = (yield* store.message(assistantMessageID))?.message
          const empty =
            message?.type === "assistant" &&
            !message.content.some((part) => (part.type === "text" ? part.text.trim().length > 0 : part.type === "tool"))
          return {
            needsContinuation: completed,
            normal: !stepLimitReached && message?.type === "assistant" && message.finish === "stop",
            empty,
          }
        }
      }
    })

    const settleStaleCompactions = Effect.fn("SessionRunner.settleStaleCompactions")(function* (
      sessionID: SessionSchema.ID,
    ) {
      // A process death skips compaction finalizers. Include orphans behind a
      // completed checkpoint, and settle newest first to match event projection.
      const rows = yield* db
        .select()
        .from(SessionMessageTable)
        .where(
          and(
            eq(SessionMessageTable.session_id, sessionID),
            eq(SessionMessageTable.type, "compaction"),
            sql`json_extract(${SessionMessageTable.data}, '$.status') = 'running'`,
          ),
        )
        .orderBy(desc(SessionMessageTable.seq))
        .all()
        .pipe(Effect.orDie)
      for (const row of rows) {
        const message = yield* SessionHistory.decodeMessageRow(row)
        if (message.type !== "compaction") continue
        yield* bus.publish(SessionEvent.Compaction.Failed, {
          sessionID,
          reason: message.reason,
          inputID: message.id,
          error: { type: "compaction.interrupted", message: "Compaction was interrupted" },
        })
      }
    })

    const settleStaleToolCalls = Effect.fn("SessionRunner.settleStaleToolCalls")(function* (
      sessionID: SessionSchema.ID,
    ) {
      for (const message of yield* store.context(sessionID)) {
        if (message.type !== "assistant") continue
        for (const tool of message.content) {
          if (tool.type !== "tool" || (tool.state.status !== "streaming" && tool.state.status !== "running")) continue
          const metadata = tool.state.status === "running" ? tool.state.metadata : undefined
          const childID =
            tool.name === "subagent" && typeof metadata?.sessionID === "string" ? metadata.sessionID : undefined
          yield* bus.publish(SessionEvent.Tool.Failed, {
            sessionID,
            assistantMessageID: message.id,
            id: tool.id,
            error: {
              type: "aborted",
              message: `Tool execution interrupted: ${tool.name}${childID ? ` (sessionID: ${childID})` : ""}`,
            },
            ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
            executed: tool.executed === true,
          })
        }
      }
    })

    return Service.of({ drain })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    Bus.node,
    LocationLifecycle.node,
    llmClient,
    SessionContext.node,
    SessionModelTransport.node,
    SessionStore.node,
    SessionCompaction.node,
    Plugin.node,
    SessionTitle.node,
    Snapshot.node,
    ToolOutput.node,
    Database.node,
  ],
})
