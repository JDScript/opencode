/**
 * Fork-local English copy.
 *
 * Lives here rather than in `@/i18n/en.ts` so that upstream edits to that file never collide with
 * fork keys during a rebase. Every key is prefixed `fork.` to guarantee it can never shadow an
 * upstream key. See FORK.md.
 */
export const dict = {
  "fork.settings.tab.configFile": "Config file",

  "fork.prompt.working": "Working",

  "fork.config.section.title": "Global configuration",
  "fork.config.section.description":
    "Edit the selected server's global config file. Most changes take effect immediately; server listen options (port, hostname, cors, mdns) require restarting the server manually.",
  "fork.config.file.label": "File",
  "fork.config.server.label": "Server",

  "fork.config.action.save": "Save",
  "fork.config.action.revert": "Discard changes",
  "fork.config.action.reload": "Reload from server",

  "fork.config.status.clean": "No changes",
  "fork.config.status.dirty": "Unsaved changes",
  "fork.config.status.saving": "Saving…",
  "fork.config.status.saved": "Saved",

  "fork.config.error.json": "Invalid JSON",
  "fork.config.error.schema": "Does not match the config schema",
  "fork.config.error.load": "Could not load the config file",
  "fork.config.error.save": "Could not save the config file",

  "fork.config.editor.label": "Config file contents",
  "fork.config.status.checking": "Checking…",
  "fork.config.status.valid": "Valid",
  "fork.config.problems.title": "Problems",

  "fork.config.reference.title": "Available settings",
  "fork.config.reference.search": "Search settings…",
  "fork.config.reference.empty": "No matching setting",
  "fork.config.reference.insert": "Insert at cursor",
  "fork.config.reference.count": "{{shown}} of {{total}}",
}
