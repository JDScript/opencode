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
  "fork.config.error.unsupported":
    "{{server}} does not provide config file access. It is not running a build of this fork, or is running one older than this feature.",
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

  "fork.usage.title": "Usage",
  "fork.usage.session.title": "Session usage",
  "fork.usage.command": "View usage",
  "fork.usage.command.description": "Cost, requests and tokens for this session and everywhere else",
  "fork.usage.server": "Server",
  "fork.usage.error.load": "Could not load usage",
  "fork.usage.error.unsupported":
    "{{server}} does not report usage. It is not running a build of this fork, or is running one older than this feature.",

  "fork.usage.range.5h": "5h",
  "fork.usage.range.1d": "1d",
  "fork.usage.range.7d": "7d",
  "fork.usage.range.30d": "30d",
  "fork.usage.range.all": "All",

  "fork.usage.metric.cost": "Spent",
  "fork.usage.metric.requests": "Requests",
  "fork.usage.metric.input": "Input",
  "fork.usage.metric.output": "Output",
  "fork.usage.cached.pct": "{{pct}}% cached",

  "fork.usage.short.requests": "req",
  "fork.usage.short.cost": "cost",
  "fork.usage.short.input": "in",
  "fork.usage.short.output": "out",
  "fork.usage.short.cached": "cached",

  "fork.usage.range.label": "Time range",
  "fork.usage.range.whole.5h": "Last 5 hours",
  "fork.usage.range.whole.1d": "Last 24 hours",
  "fork.usage.range.whole.7d": "Last 7 days",
  "fork.usage.range.whole.30d": "Last 30 days",
  "fork.usage.range.whole.all": "All time",
  "fork.usage.requests.n": "{{count}} requests",

  "fork.usage.chart.title": "Requests and cost",
  "fork.usage.chart.hint": "Cost split by model",
  "fork.usage.chart.label": "Requests and cost per period, cost split by model",
  "fork.usage.chart.empty": "Nothing in this range",
  "fork.usage.chart.other": "Other",
  "fork.usage.chart.all": "All",
  "fork.usage.value.unset": "Not recorded",

  "fork.usage.projects.title": "Projects",
  "fork.usage.models.title": "Models",
  "fork.usage.project.none": "Outside a repository",

  "fork.usage.sessions.title": "Sessions",
  "fork.usage.sessions.count": "{{count}} in range",
  "fork.usage.sessions.hint": "Sub-agents nested under the session that started them",

  "fork.usage.heatmap.title": "Every day",
  "fork.usage.heatmap.hint": "Spend per day, all history",
  "fork.usage.heatmap.label": "Spend per day over the last year",
  "fork.usage.heatmap.empty": "No usage recorded yet",

  "fork.usage.truncated": "Too many groups to return; showing the first ones only",
}
