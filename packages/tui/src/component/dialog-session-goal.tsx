import { createMemo, createSignal, Show } from "solid-js"
import { useClient } from "../context/client"
import { useData } from "../context/data"
import { useTheme } from "../context/theme"
import { type DialogContext, useDialog } from "../ui/dialog"
import { DialogConfirm } from "../ui/dialog-confirm"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogSelect } from "../ui/dialog-select"
import { useToast } from "../ui/toast"
import {
  applyGoalCommand,
  goalConfirmation,
  goalExecutionGuidance,
  parseGoalCommand,
  parseGoalLimit,
  type GoalCommand,
} from "../util/goal"

export function useGoalControls(sessionID: () => string) {
  const client = useClient()
  const data = useData()
  const dialog = useDialog()
  const toast = useToast()

  async function apply(command: Exclude<GoalCommand, { action: "inspect" }>) {
    const id = sessionID()
    await applyGoalCommand(client.api.session, id, command)
    data.session.invalidate(id)
    await data.session.sync(id)
    toast.show({ message: goalConfirmation(command), variant: "info", duration: 6000 })
  }

  function run(input?: string) {
    void Promise.resolve()
      .then(() => {
        const command = parseGoalCommand(input)
        if (command.action === "inspect") return DialogSessionGoal.show(dialog, sessionID())
        return apply(command)
      })
      .catch(toast.error)
  }

  return { apply, run }
}

export function DialogSessionGoal(props: { sessionID: string }) {
  const data = useData()
  const dialog = useDialog()
  const theme = useTheme().surface("dialog")
  const toast = useToast()
  const controls = useGoalControls(() => props.sessionID)
  const goal = createMemo(() => data.session.get(props.sessionID)?.goal)
  const [saving, setSaving] = createSignal(false)
  const back = () => DialogSessionGoal.show(dialog, props.sessionID)

  function save(command: Exclude<GoalCommand, { action: "inspect" }>) {
    if (saving()) return
    setSaving(true)
    void controls
      .apply(command)
      .then(back)
      .catch(toast.error)
      .finally(() => setSaving(false))
  }

  function objective(action: "set" | "update") {
    const current = goal()
    dialog.replace(() => (
      <DialogPrompt
        title={action === "set" ? "Set session goal" : "Edit session goal"}
        placeholder="What should this session accomplish?"
        value={action === "update" ? current?.text : undefined}
        description={() => <text fg={theme.text.muted}>{goalExecutionGuidance}</text>}
        onCancel={back}
        onConfirm={(value) => {
          const text = value.trim()
          if (!text) return
          if (action === "set" && current && current.status !== "completed") {
            dialog.replace(() => (
              <DialogConfirm
                title="Replace unfinished goal?"
                message="This replaces the current objective and resets its continuation budget. Automatic continuation starts off."
                onConfirm={() => save({ action, text })}
                onCancel={() => queueMicrotask(back)}
              />
            ))
            return
          }
          save({ action, text })
        }}
      />
    ))
  }

  function limit() {
    dialog.replace(() => (
      <DialogPrompt
        title="Automatic continuation limit"
        value={String(goal()?.maxContinuations ?? 10)}
        description={() => (
          <text fg={theme.text.muted}>1–100 continuations. Editing preserves the amount already used.</text>
        )}
        onCancel={back}
        onConfirm={(value) => {
          void Promise.resolve()
            .then(() => save({ action: "limit", maxContinuations: parseGoalLimit(value) }))
            .catch(toast.error)
        }}
      />
    ))
  }

  return (
    <box>
      <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
        <Show when={goal()} fallback={<text fg={theme.text.muted}>No session goal</text>}>
          {(value) => (
            <box gap={1}>
              <scrollbox maxHeight={8} horizontalScrollbarOptions={{ visible: false }}>
                <text fg={theme.text.base}>{value().text}</text>
                <Show when={value().reason}>{(reason) => <text fg={theme.text.muted}>{reason()}</text>}</Show>
              </scrollbox>
              <text fg={theme.text.feedback.info.base}>
                {value().status} · auto {value().autoContinue ? "on" : "off"} · {value().continuationsUsed}/
                {value().maxContinuations} continuations
              </text>
            </box>
          )}
        </Show>
        <text fg={theme.text.muted}>{goalExecutionGuidance}</text>
      </box>
      <DialogSelect
        title="Session goal"
        renderFilter={false}
        locked={saving()}
        options={[
          { title: goal() ? "Replace goal" : "Set goal", value: "set", onSelect: () => objective("set") },
          ...(goal()
            ? [
                { title: "Edit objective", value: "update", onSelect: () => objective("update") },
                ...(goal()?.status === "active"
                  ? [{ title: "Pause goal", value: "pause", onSelect: () => save({ action: "pause" }) }]
                  : goal()?.status === "completed"
                    ? []
                    : [{ title: "Resume goal", value: "resume", onSelect: () => save({ action: "resume" }) }]),
                {
                  title: goal()?.autoContinue ? "Disable automatic continuation" : "Enable automatic continuation",
                  description: "Explicit consent to bounded follow-up steps; Ctrl-C pauses the goal",
                  value: "auto",
                  onSelect: () => save({ action: "auto", autoContinue: !goal()?.autoContinue }),
                },
                { title: "Change continuation limit", value: "limit", onSelect: limit },
                {
                  title: "Clear goal",
                  value: "clear",
                  onSelect: () =>
                    dialog.replace(() => (
                      <DialogConfirm
                        title="Clear session goal?"
                        message="Remove this objective from the session."
                        onConfirm={() => save({ action: "clear" })}
                        onCancel={() => queueMicrotask(back)}
                      />
                    )),
                },
              ]
            : []),
        ]}
      />
    </box>
  )
}

DialogSessionGoal.show = (dialog: DialogContext, sessionID: string) =>
  dialog.replace(() => <DialogSessionGoal sessionID={sessionID} />)

export function SessionGoalStatus(props: { sessionID: string }) {
  const data = useData()
  const dialog = useDialog()
  const theme = useTheme()
  const goal = createMemo(() => data.session.get(props.sessionID)?.goal)
  return (
    <Show when={goal()}>
      {(value) => (
        <box flexShrink={0} height={1} onMouseUp={() => DialogSessionGoal.show(dialog, props.sessionID)}>
          <text fg={theme.text.base} wrapMode="none" truncate minWidth={0}>
            <span style={{ fg: theme.text.feedback.info.base }}>
              Goal {value().status} · auto {value().autoContinue ? "on" : "off"} {value().continuationsUsed}/
              {value().maxContinuations}
            </span>
            {" · " + value().text.replace(/\s+/g, " ")}
          </text>
        </box>
      )}
    </Show>
  )
}
