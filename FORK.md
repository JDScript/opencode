# Fork notes (v2 line)

The v2 line of [JDScript/opencode](https://github.com/JDScript/opencode): upstream
[anomalyco/opencode](https://github.com/anomalyco/opencode)'s `v2` branch plus the smallest possible
patch set to ship a different web UI and publish binaries to this repository's GitHub Releases. The v1 line
lives on `jdscript` with its own `FORK.md`; the two share a repository and nothing else.

The design goal is unchanged from v1: **stay rebasable onto upstream forever.** New files plus the smallest
possible seams; every seam carries a `FORK` comment and is listed in section 3.

---

## 1. What this branch carries

Fifteen commits on top of upstream `v2`:

| Commit                                                              | Kind                                                                 | What                                                                                                                                     |
| ------------------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `feat(cli): embed a prebuilt web UI…`                               | seam                                                                 | `OPENCODE_WEB_UI_DIST` in `packages/cli/script/app-assets.ts`                                                                            |
| `ci: release and update fork builds…`                               | seams + fork-only                                                    | `mise.toml`, `.github/workflows/release-fork.yml`, `install-v2`, `packages/cli/src/fork.ts`; two seams in `updater.ts`                   |
| `docs: add FORK.md for the v2 line`                                 | fork-only                                                            | this file                                                                                                                                |
| `feat(core): publish session.tool.input.delta`                      | seam                                                                 | `publish-llm-event.ts`: the tool-input fragment gets the batched delta publisher text and reasoning have                                 |
| `feat(server): add GET /api/experimental/server/stats`              | seams                                                                | `protocol/groups/server.ts`, `server/handlers/server.ts`; regenerated `openapi.json` and `packages/client`                               |
| `feat: ship opencode-web as the embedded UI`                        | fork-only                                                            | `.gitmodules` + `web/` submodule → JDScript/opencode-web branch `beta`                                                                   |
| `ci: publish v2 releases as latest`                                 | fork-only                                                            | the v1 → v2 cut-over: releases stop being prereleases; `install-v2` installs as `opencode`                                               |
| `docs: track upstream v2, not beta`                                 | fork-only                                                            | this file, `release-fork.yml` upstream lookup                                                                                            |
| `feat(cli): let an empty password disable authentication`           | seams                                                                | `server-process.ts` password fallback; `server/process.ts` pre-router gate honours `ServerAuth.required`                                 |
| `ci: follow upstream v2 releases automatically`                     | fork-only                                                            | `.github/workflows/sync-fork.yml`                                                                                                        |
| `fix(core): skip MCP list calls the server does not advertise`      | seam                                                                 | `packages/core/src/mcp/client.ts`                                                                                                        |
| `packages/cli/src/commands/commands.ts`                             | `web` as an alias of `serve`                                         |
| `packages/core/src/plugin/module.ts`                                | Falls back to the v1 adapter when a module is not v2-shaped          |
| `packages/core/test/plugin/module.test.ts`                          | Three cases for the fallback                                         |
| `packages/core/src/plugin/internal.ts`                              | Registers the built-in OpenViking plugin after the config MCP plugin |
| `packages/core/package.json`                                        | Depends on `@jdscript/opencode-openviking`                           |
| `packages/cli/src/commands/handlers/upgrade.ts`                     | Prints the v1 OpenViking plugin notice after an upgrade              |
| `feat(cli): no password on loopback by default, and `opencode web`` | seams                                                                | `server-process.ts` password rules; `commands.ts` alias                                                                                  |
| `feat(core): run v1 plugins through a compatibility adapter`        | seam + fork-only                                                     | `plugin/module.ts` fallback; `plugin/legacy-v1.ts`                                                                                       |
| `chore(web): bump ui to c7a8031`                                    | fork-only                                                            | `web/` submodule                                                                                                                         |
| `feat(plugin): built-in OpenViking memory for v2`                   | seams + fork-only                                                    | `packages/plugin-openviking/`; registered in `core/plugin/internal.ts`; upgrade notice in `install-v2`, `fork.ts`, `handlers/upgrade.ts` |

Deliberately **not** carried from v1, and why:

- **`tool-input-delta` publishing.** v2 publishes `session.tool.input.delta` natively.
- **`/fork/usage`.** Not wanted on v2 yet; v2 has `GET /api/experimental/session/stats`, and its message
  storage (`session_message`, content inline, no `part` table) means the v1 query would not port anyway.
- **Per-provider Bedrock credentials.** Not re-evaluated on v2's provider stack yet.

---

## 2. Branch layout and following upstream

```
upstream/v2    ──►  jdscript-v2   this line's trunk; rebased onto upstream/v2; v2 releases cut from here
upstream/dev   ──►  dev  ──►  jdscript   the v1 line, unchanged
```

- **Track `upstream/v2`, not `beta`.** `v2` is upstream's default branch and where v2.0.x releases are cut
  (their "sync release versions" commits land there; the tags sit on detached commits whose merge-base is
  `v2`). `beta` is a release-staging branch that receives occasional merges from `v2` and stopped moving on
  2026-09-17; the fork tracked it by mistake for two days and was 83 commits behind before noticing.
- There is **no `v2` mirror branch** in the fork (unlike `dev` for v1). Pushing upstream's `v2` to the fork
  would fire the push-triggered workflows that arrive with it (`publish.yml`, `deploy.yml`, `nix-hashes.yml`,
  `test.yml`, `check.yml` all list `v2`), and a workflow file that is not on the default branch cannot be
  disabled before its first run. The upstream commit a release sits on is recorded in its notes instead.
- `jdscript-v2` is the local development checkout at `~/Developer/opencode-beta` — a separate clone from the
  v1 checkout because the two need different bun versions (`mise.toml` in each).
- `sync-fork.yml` follows upstream twice a day: when `packages/cli/package.json`'s version on `upstream/v2`
  differs from `jdscript-v2`'s, it rebases onto `v2`, regenerates the protocol/client (the fork adds an
  endpoint, so upstream's generated files go stale on every rebase — folded into one `chore: regenerate`
  commit), typechecks, archives the old tip as `fork/pre-rebase-v2/…`, force-pushes with a lease, and
  dispatches `release-fork.yml`. It stops, pushing nothing, on a conflict, on a dropped patch, or on a red
  typecheck — same rules as v1's. A manual rebase leaves the versions equal and so is not released; follow
  it with `gh workflow run sync-fork.yml -f force=true`.

```sh
git fetch upstream v2 --tags
archive="fork/pre-rebase-v2/$(date -u +%Y%m%d%H%M)-onto-$(git rev-parse --short upstream/v2)"
git tag "$archive" jdscript-v2 && git push origin "$archive"
git rebase upstream/v2
```

### Upstream workflows

All of upstream's workflows are disabled in this repository through `gh workflow disable` (a repository
setting; survives rebases). Only `sync-fork.yml` and `release-fork.yml` are active. Since `jdscript-v2`
became the default branch (2026-09-19), schedules run from it: v1's `sync-fork.yml` on `jdscript` no longer
fires on its own (`gh workflow run sync-fork.yml --ref jdscript -f force=true` still works by hand). After any rebase
that touches `.github/workflows/`, re-check:

```sh
gh workflow list --repo JDScript/opencode --json name,path,state \
  --jq '.[] | select(.state=="active") | .path'
```

Note that upstream's v2 `publish.yml` is job-guarded by `github.repository == 'anomalyco/opencode'`; it is
disabled anyway.

---

## 3. Upstream touch points

```sh
git grep -nE '(//|#) FORK' -- ':!FORK.md'
```

| File                                                                                                             | Seam                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `packages/cli/script/app-assets.ts`                                                                              | `OPENCODE_WEB_UI_DIST`: archive a prebuilt static directory instead of `packages/app`                 |
| `packages/cli/src/services/updater.ts`                                                                           | Fork builds read releases from `fork.ts` and upgrade through `install-v2`                             |
| `packages/cli/src/server-process.ts`                                                                             | An explicitly empty password is kept, not replaced by a random one (env and service config)           |
| `packages/server/src/process.ts`                                                                                 | `""` password is not "missing"; the pre-router auth gate honours `ServerAuth.required`                |
| `packages/core/src/mcp/client.ts`                                                                                | List tools/prompts/resources only when the server advertises the capability                           |
| `packages/core/src/session/runner/publish-llm-event.ts`                                                          | Publishes `session.tool.input.delta` (batched) alongside `Input.Ended`                                |
| `packages/core/test/session-runner-tool-events.test.ts`                                                          | Replaces upstream's "deltas are not published" assertion with the batched-delta one                   |
| `packages/protocol/src/groups/server.ts`                                                                         | `server.stats` endpoint and `ServerStats` schema                                                      |
| `packages/server/src/handlers/server.ts`                                                                         | `server.stats` handler                                                                                |
| `packages/protocol/openapi.json`, `packages/client/src/**/generated/**`, `packages/client/src/effect/api/api.ts` | Regenerated (`bun run generate` in `protocol` and `client`); regenerate rather than merge on conflict |

Fork-only files that are not seams: `mise.toml`, `.github/workflows/release-fork.yml`, `install-v2`,
`packages/cli/src/fork.ts`, `packages/core/src/plugin/legacy-v1.ts`, `packages/plugin-openviking/`, `.gitmodules` and
the `web/` submodule.

### Non-obvious choices worth keeping

- **Release builds use `OPENCODE_CHANNEL=latest`; development builds do not.** The channel is a compile-time
  constant with three effects (`packages/cli/src/database-path.ts`, `services/service-config.ts`,
  `services/updater.ts`): the database file, the background-service file and default port, and the update
  URL. `latest` maps to `opencode.db` — the file the v1 fork uses — which is the point: a user upgrading to
  v2 keeps their history: upstream's `V1Migration.layer` migrates it on first start (see §5). Any other
  channel gets a private `opencode-<channel>.db`, so for **development against a machine that has a real
  database**, build with `OPENCODE_CHANNEL=jdscript` or run with `OPENCODE_DB=/path/to/copy.db`; the release
  workflow must never do that.
- **Fork builds are recognised by version, not channel.** `packages/cli/src/fork.ts` sets `enabled` when
  `OPENCODE_VERSION` contains `-jdscript.`, which every `release-fork.yml` version does. The two seams in
  `updater.ts` then read releases from this repository's **Atom feed** (`/releases.atom`) and upgrade via
  `install-v2 --version X --dir <execPath dir> --name <execPath name>`. Without the seams a `latest`-channel
  build would ask `opencode.ai/update/api/latest/cli/npm`, get upstream's version, and — through the `curl`
  method — replace itself with upstream's binary on the first check. The Atom feed rather than the REST API
  because the API allows 60 unauthenticated requests per hour per IP and the updater polls every ten
  minutes; several machines behind one NAT exhaust that. The feed has no such limit, lists the newest ten
  releases newest-first, and includes prereleases. A Cloudflare Worker in front of GitHub was considered and
  is not needed for this; it becomes worth it only if the fork ever wants per-channel rollout logic or
  telemetry that GitHub cannot express.
- **v2 releases are `latest`, and that is the v1 → v2 cut-over switch.** The repository also hosts the v1
  fork, whose `opencode upgrade` (`packages/opencode/src/installation/fork.ts` on `jdscript`) reads
  `/releases/latest`; from the first v2 release marked latest (2026-09-19) every v1 user is upgraded on
  their next check and their `opencode.db` is migrated on first start (§5). Until then v2 releases were
  prereleases to prevent exactly that while the web UI was not ready. `install-v2` still reads the Atom
  feed's newest `v2.` title rather than `/releases/latest`, for the rate limit and so it stays correct
  regardless of which line is newest.
- **The web UI is embedded as a finished directory, not built by `build.ts`.** Same reasoning as v1: the
  seam points upstream's archive step at any static directory; the release workflow owns building it.
  Upstream's own embedding (`app-assets.ts` → per-file brotli → `virtual:opencode-app-assets`, served by
  `packages/cli/src/services/web-ui.ts`) is unchanged, including the CSP contract: exactly one inline
  script is allowed, the one with `id="oc-theme-preload-script"`, whose hash `web-ui.ts` computes.
- **`install-v2` installs as `opencode`, replacing a v1 fork binary in `~/.opencode/bin`.** That is the
  cut-over, and it is also what the v2 updater's `curl` method detection needs: `updater.ts` `method()`
  recognises only a binary at exactly `~/.opencode/bin/opencode`. `--name opencode-v2` keeps both side by
  side, at the cost of self-update for the v2 one. Both names open the same `opencode.db`.
- **`session.tool.input.delta` is published again, batched.** Upstream **removed** it deliberately in PR
  #42826 (`4fee4d7d86`, 2026-08-15, "batch streamed session deltas"): the server was emitting every provider
  fragment as its own public event, 32/s average and 65/s peak, so text and reasoning were batched to ~100 ms
  and tool-input deltas were dropped outright, with a test asserting they stay dropped. The schema, manifest,
  client (`solid/data.ts` appends to `tool.state.input` while streaming), TUI and generated types all still
  handle the event. The seam gives the tool-input fragment the same batched delta callback text and
  reasoning have, so it addresses upstream's event-rate concern rather than reverting it: at most one event
  per 100 ms per call, terminal flush ordered before `Input.Ended`, whose full `text` stays authoritative. It
  is the v2 counterpart of the v1 fork's `raw` PartDelta seam (which forwarded every chunk unbatched). Verified
  on a live prompt: one `session.tool.input.delta` with the read tool's JSON arguments, then `Input.Ended`.
  Upstreamable as "batch tool-input deltas like text" — a different proposal from the one they rejected.
- **`/api/experimental/server/stats` reads the serving handle, never a path.** The database file comes from
  `pragma_database_list` on the live connection, so it is exact for whatever `OPENCODE_DB`/channel resolved
  to and is `null` for `:memory:` and SqlClient-backed deployments rather than a guess. Sizes are `stat` of
  the main file and its `-wal`/`-shm` sidecars (missing → 0). Memory is `process.memoryUsage()`, `null` where
  the runtime lacks it (workerd). No checkpoint, no VACUUM, no second connection, no directory walk. It uses
  `node:fs/promises` directly because the request-handler layer does not carry the `FileSystem` service.
  Note Bun reports `heapUsed > heapTotal` at times; the numbers are the runtime's, unadjusted.
- **Regenerated client is part of the commit.** `bun run generate` in `packages/protocol` (OpenAPI) and
  `packages/client` (promise/effect clients); upstream's `check:generated` would otherwise fail on rebase.

- **`opencode serve` on loopback needs no password; anywhere else it does.** Upstream always generates a
  random password and prints it. v1 only authenticated when `OPENCODE_SERVER_PASSWORD` was set, and a
  browser client on the same machine should not need a credential exchange, so the fork decides in
  `server-process.ts`, in order: the background service keeps upstream's behaviour (stored or random)
  unless its stored password is `""` (`opencode service set password ""`); an explicit `OPENCODE_PASSWORD`
  wins; an explicitly empty one (`OPENCODE_PASSWORD=`, read from `process.env` because `Config.redacted`
  reports an empty variable as absent) disables auth on any address; otherwise `127.0.0.1`/`localhost`/`::1`
  → no auth, anything else → random, so `--hostname 0.0.0.0` never goes open by accident. The TUI's private
  `--stdio` server always gets an explicit password from `services/standalone.ts` and is unaffected.
  `ServerAuth.required()` already treats `""` as no auth; a second seam in `server/process.ts` makes its
  pre-router gate honour that and stops it rejecting `""` as "missing". Startup logs the reason when auth is
  off. `opencode web` is an alias of `serve` (`commands.ts`), as in v1.

- **v1 plugins run unmodified through `plugin/legacy-v1.ts`.** Upstream v2 rejects a v1 plugin (a factory
  returning hooks) with "Plugin must export a default definition with an id and an effect or setup
  function"; it documents the migration but offers no runtime compatibility. This fork is distributed to
  people who already have v1 plugins configured — `@openviking/opencode-plugin` being the one that
  prompted it — so `module.ts` falls back to the adapter when the v2 schema does not match (a dual-shape
  module still decodes as v2 and wins). The adapter maps each v1 hook to the v2 domain hook with the same
  meaning; the file header lists the table. Two choices worth knowing: `chat.message` maps to
  `session.hook("prompt")`, so injected text becomes part of the persisted user message — that is v1's
  semantics too (a `synthetic` text part), just without the flag for UIs to hide it; and the v1 `client`
  is a Proxy that logs `tui.showToast`, accepts `app.log`, and returns `{ data: undefined }` for anything
  else after one warning, because the in-process v2 context has no HTTP SDK. Event translation is the
  substantive part: v2 has no `message.*` events, so `message.updated`/`message.part.updated` are
  synthesised from `session.inbox.enqueued`, `session.step.*`, `session.text.ended`,
  `session.reasoning.ended` and `session.tool.*` (names remembered from `session.tool.input.started`);
  `session.idle`/`session.error`/`session.compacted` come from `session.execution.*` and
  `session.compaction.ended`. Unsupported v1 hooks (`tool`, `auth`, `provider`, `chat.params`, …) log one
  warning and are ignored. Verified against the real OpenViking plugin on a live server: MCP registered
  (15 tools), session derived, context injected into the prompt, state persisted, no adapter warnings.

- **OpenViking memory is a built-in plugin, `packages/plugin-openviking`.** The v1 npm plugin
  (`@openviking/opencode-plugin`) runs on this fork through the compatibility adapter, but its design does
  not fit v2: it is instantiated once per open project, each instance keeps every captured message part in
  memory forever and rewrites a growing pretty-printed JSON on every part event, each spawns its own
  `mcp-proxy` node process, and its injected context is glued into the user's prompt text. Five open
  projects put the server at 3.3 GB RSS. The built-in plugin keeps OpenViking's server API, credential
  lookup (`~/.openviking/ovcli.conf`, `OPENVIKING_*`, `openviking-config.json`), session-id derivation,
  recall/profile assembly and capture filters by vendoring `lib/shared/*` from the npm package verbatim
  (`vendor/openviking/`, Apache-2.0, see `NOTICE` and `PATCHES.md`), and rewrites only the host layer:
  one module-level runtime shared by all locations; MCP registered as a `remote` server with the auth
  headers the proxy used to add (the server speaks streamable HTTP directly); capture pulled from
  `ctx.session.context()` at `session.execution.*`, `session.deleted` and the `compaction` hook, advancing a
  per-session cursor persisted in a few-hundred-byte `openviking-capture-state.json`; and memory injected
  as **synthetic messages** admitted from the `prompt` hook, which runs before the prompt's own inbox row
  exists, so profile → recall → prompt are promoted as one batch and the model reads them in that order
  in a single request while the transcript shows them as collapsible entries with a `description`. (A
  first attempt used the `context` hook plus `ctx.session.synthetic`, the Plan-plugin idiom; admitting
  the synthetic mid-drain promoted it as a steer and produced a second provider turn.) The plugin is
  inert without OpenViking credentials, and stands down — one WARN in `openviking-memory.log` — while the
  v1 package is still in `plugins`, so both never inject at once. `install-v2` and `opencode upgrade`
  print the switch-over notice when the global config still names the v1 package; user config is never
  edited. Not carried over: the `viking://` URI guard (v1 threw from `tool.execute.before`; promise hooks
  cannot fail a tool call in v2), toasts, and the setup wizard. Same server, five projects: 348 MB RSS,
  zero proxy processes, state file 432 bytes.

### Duplications that must be kept in step

| Value            | Locations                                                                                                |
| ---------------- | -------------------------------------------------------------------------------------------------------- |
| Fork GitHub repo | `GITHUB_REPO` in `install-v2` (and, once added, the updater seam)                                        |
| bun version      | `packageManager` in `package.json` · `mise.toml`. The workflow reads `package.json`, so it cannot drift. |
| Archive names    | `opencode-<os>-<arch>.{zip,tar.gz}` in `release-fork.yml` and `install-v2`                               |

---

## 4. Releasing and the web UI

`gh workflow run release-fork.yml --ref jdscript-v2`. Version format `2.0.6-jdscript.202609190200-abcdef0`:
base from `packages/cli/package.json`, UTC stamp, fork sha. `packages/cli/src/services/updater-action.ts`
requires a valid semver with prerelease identifiers and treats equal strings as the same release, so the
stamp is required. Draft → three builds → publish as latest → verify.

The web UI is the `web/` submodule: [JDScript/opencode-web](https://github.com/JDScript/opencode-web), branch
`beta` (its v2 line; `main` targets the v1 fork). Bumping it is one gitlink commit:

```sh
git submodule update --remote web && git add web && git commit -m "chore(web): bump ui to $(git -C web rev-parse --short HEAD)"
```

`release-fork.yml` builds `web/` with pnpm when `web/package.json` exists and passes `web/apps/spa/dist`
through `OPENCODE_WEB_UI_DIST`. The
submodule checkout uses `WEB_CHECKOUT_TOKEN` from the `production` environment (fine-grained PAT,
`contents: read` on both repositories). The UI must: build to a static directory with an `index.html`, use
relative asset paths or same-origin, talk to `/api/*` at `location.origin`, send Basic auth with username
`opencode` (v2 servers require a password by default), and give its one inline script
`id="oc-theme-preload-script"`.

Local build, exactly as the workflow does it:

```sh
mise install && bun install
cd packages/cli
OPENCODE_CHANNEL=jdscript OPENCODE_VERSION=2.0.6-jdscript.local bun run script/build.ts --single --skip-install
OPENCODE_PASSWORD=x ./dist/cli-*/bin/opencode serve --port 4300 --print-logs
```

`OPENCODE_CHANNEL=jdscript` here is deliberate: it keeps a local build off the real `opencode.db` (release
builds use `latest`, see §3). Prefix `OPENCODE_WEB_UI_DIST=/path/to/ui/dist` to embed a different UI. `--skip-install` skips fetching the
`@opentui/core` and `@opencode-ai/pty` binaries for other targets; drop it if the build complains.

---

## 5. Known limitations

- **Self-update needs the binary at `~/.opencode/bin/opencode`.** Upstream's `curl` method detection is
  path-based; an `install-v2 --name opencode-v2` side-by-side install is outside it (see §3).
- **The V1 → V2 migration is upstream's, automatic and irreversible.** A v2 build opening a V1 `opencode.db`
  starts migrating on first start: the `event` table is cleared, V1 sessions are copied into
  `session_v2`/`session_message`, and V1 tables are never read again — V1 sessions written afterwards are not
  imported. Measured on a 9.4 GB database: about 70 s, no warnings, 647 sessions and 41k messages carried over.
  Two things upstream does not do: **back up** (copy `opencode.db` before the first v2 start) and **reclaim
  space** (the file stays 9.4 GB until a `VACUUM`, which took 36 s and left 2.3 GB). Progress is at
  `GET /api/experimental/migration/v1` (`required` → `running` with `{numerator, denominator}` sessions →
  `completed` | `error`); upstream's TUI overlays it, its web app does not, so the fork's web UI should poll
  it and block while `running`. A user-acknowledged variant with backup and VACUUM was built, measured
  (165 s end to end) and then dropped in favour of upstream's behaviour; it is in this branch's history at
  tag `fork/archive/gated-migration` (commit `528c8c90e2`) if wanted again.
- **No `v2` mirror branch.** See §2.
- **`linux-arm64` needs a public repository.** The `ubuntu-24.04-arm` runner is only free on public repos.
