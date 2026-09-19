# @jdscript/opencode-openviking

OpenViking long-term memory and repository retrieval for OpenCode v2, written against the v2 plugin API.
Built into the JDScript/opencode fork as `opencode.openviking`; the package is shaped so it can also be
published and loaded through `plugins` on any v2 build.

## What it does

- Registers the OpenViking MCP server (`openviking`) as a direct remote connection with your credentials.
- Before each of your prompts, recalls relevant memories (and, once per session, your profile and the
  session's previous archive) and adds them as a separate collapsible **synthetic message** in front of
  the prompt.
- After each turn, sends the new messages to the OpenViking session derived from the OpenCode session,
  and commits it on compaction, deletion, or when the server's pending-token threshold is reached.
- Adds a system-prompt note listing repositories indexed in OpenViking.

## Configuration

Nothing OpenCode-specific. Credentials come from `~/.openviking/ovcli.conf`, `OPENVIKING_*` environment
variables, or `~/.config/opencode/openviking-config.json` / `<project>/.opencode/openviking-config.json`,
exactly as with `@openviking/opencode-plugin`. Without any of these the plugin does nothing.

Logs: `~/.config/opencode/openviking/openviking-memory.log`. State (a per-session capture cursor):
`~/.config/opencode/openviking/openviking-capture-state.json`.

## Migrating from `@openviking/opencode-plugin`

Remove `"@openviking/opencode-plugin"` from `plugins` in your `opencode.json`. While it is still listed the
v1 plugin keeps running (through the fork's compatibility adapter) and this plugin stays idle. The manual
`mcp.openviking` entry pointing at `mcp-proxy.mjs` can go too; this plugin registers the server itself.

## Layout

- `src/` — the host layer: `runtime.ts` (shared state), `recall.ts` (injection), `capture.ts` (pull-model
  capture), `index.ts` (setup, MCP, event loop).
- `vendor/openviking/` — OpenViking's own host-agnostic modules, copied from the npm package. See
  `PATCHES.md` for the one local change and `VERSION` for the source version.
