export type GoalCommand =
  | { action: "inspect" }
  | { action: "pause" | "resume" | "clear" }
  | { action: "set" | "update"; text: string }
  | { action: "auto"; autoContinue: boolean }
  | { action: "limit"; maxContinuations: number }

export function parseGoalCommand(input?: string): GoalCommand {
  const text = input?.trim() ?? ""
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(text)
  if (!match) return { action: "inspect" }
  const action = match[1]
  const argument = match[2]?.trim() ?? ""
  if (action === "set" || action === "update") {
    if (!argument) throw new Error(`/goal ${action} requires an objective`)
    return { action, text: argument }
  }
  if (action === "pause" || action === "resume" || action === "clear") {
    if (argument) throw new Error(`/goal ${action} takes no arguments`)
    return { action }
  }
  if (action === "auto") {
    if (argument !== "on" && argument !== "off") throw new Error("Use /goal auto on|off")
    return { action, autoContinue: argument === "on" }
  }
  if (action === "limit") return { action, maxContinuations: parseGoalLimit(argument) }
  return { action: "set", text }
}

export function parseGoalLimit(input: string) {
  if (!/^\d+$/.test(input.trim())) throw new Error("Continuation limit must be an integer from 1 to 100")
  const value = Number(input)
  if (value < 1 || value > 100) throw new Error("Continuation limit must be an integer from 1 to 100")
  return value
}

export const goalExecutionGuidance = "Send your next prompt to work with goal guidance; this does not start execution."

export function goalConfirmation(command: Exclude<GoalCommand, { action: "inspect" }>) {
  if (command.action === "set") return `Goal set. ${goalExecutionGuidance}`
  if (command.action === "update") return `Goal updated; continuation usage preserved. ${goalExecutionGuidance}`
  if (command.action === "resume") return `Goal resumed. ${goalExecutionGuidance}`
  if (command.action === "pause") return "Goal paused."
  if (command.action === "clear") return "Goal cleared."
  if (command.action === "auto") {
    return command.autoContinue
      ? `Automatic continuation enabled within the goal's limit. ${goalExecutionGuidance}`
      : "Automatic continuation disabled."
  }
  if (command.action === "limit") return `Continuation limit set to ${command.maxContinuations}; usage preserved.`
  throw new Error("Open /goal to inspect the goal")
}

type GoalAPI = {
  setGoal(input: {
    sessionID: string
    text: string
    autoContinue?: boolean
    maxContinuations?: number
  }): Promise<unknown>
  updateGoal(input: {
    sessionID: string
    text?: string
    autoContinue?: boolean
    maxContinuations?: number
  }): Promise<unknown>
  pauseGoal(input: { sessionID: string }): Promise<unknown>
  resumeGoal(input: { sessionID: string }): Promise<unknown>
  clearGoal(input: { sessionID: string }): Promise<unknown>
}

export function applyGoalCommand(
  api: GoalAPI,
  sessionID: string,
  command: Exclude<GoalCommand, { action: "inspect" }>,
) {
  if (command.action === "set") return api.setGoal({ sessionID, text: command.text, autoContinue: false })
  if (command.action === "update") return api.updateGoal({ sessionID, text: command.text })
  if (command.action === "auto") return api.updateGoal({ sessionID, autoContinue: command.autoContinue })
  if (command.action === "limit") return api.updateGoal({ sessionID, maxContinuations: command.maxContinuations })
  if (command.action === "pause") return api.pauseGoal({ sessionID })
  if (command.action === "resume") return api.resumeGoal({ sessionID })
  if (command.action === "clear") return api.clearGoal({ sessionID })
  throw new Error("Open /goal to inspect the goal")
}
