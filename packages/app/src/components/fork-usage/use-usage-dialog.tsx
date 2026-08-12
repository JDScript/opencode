/**
 * FORK-ONLY FILE — not present upstream, so it never conflicts on rebase.
 *
 * Opening the usage dashboard, and registering it as a command.
 *
 * Registration goes through `useCommand().register()`, which is a runtime API — so the `/usage` slash
 * command and the palette entry both appear without touching any central list. `prompt-input-v2.tsx` builds
 * its slash menu by filtering registered commands for a `slash` property, so that one field is the whole
 * integration.
 */
import { onCleanup } from "solid-js"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useDialog } from "@opencode-ai/ui/context/dialog"

/**
 * Returns an opener for the dashboard, scoped to a session when one is given.
 *
 * Imported lazily and guarded the same way `useSettingsDialog` is: the chart code is only needed once
 * someone asks for it, and a dialog must not appear after the caller has gone away or been superseded.
 */
export function useForkUsageDialog(sessionID?: () => string | undefined) {
  const dialog = useDialog()
  let run = 0
  let dead = false

  onCleanup(() => {
    dead = true
  })

  return () => {
    const current = ++run
    const session = sessionID?.()
    void import("./dialog-usage").then((module) => {
      if (dead || run !== current) return
      void dialog.show(() => <module.DialogUsage sessionID={session} />)
    })
  }
}

/**
 * Registers the dashboard as `/usage` and as a palette entry.
 *
 * The registration key is what keeps this idempotent: `activeCommandRegistrations` de-duplicates by key and
 * keeps the newest, so mounting this from more than one place cannot produce a doubled palette entry.
 */
export function useForkUsageCommand(sessionID?: () => string | undefined) {
  const command = useCommand()
  const language = useLanguage()
  const show = useForkUsageDialog(sessionID)

  command.register("fork-usage", () => [
    {
      id: "fork.usage.open",
      title: language.t("fork.usage.command"),
      description: language.t("fork.usage.command.description"),
      slash: "usage",
      onSelect: show,
    },
  ])

  return show
}
