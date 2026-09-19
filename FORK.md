# Fork notes (v2 line)

The v2 line of [JDScript/opencode](https://github.com/JDScript/opencode): upstream
[anomalyco/opencode](https://github.com/anomalyco/opencode)'s `beta` branch plus the smallest possible
patch set to ship a different web UI and publish binaries to this repository's GitHub Releases. The v1 line
lives on `jdscript` with its own `FORK.md`; the two share a repository and nothing else.

The design goal is unchanged from v1: **stay rebasable onto upstream forever.** New files plus the smallest
possible seams; every seam carries a `FORK` comment and is listed in section 3.

---

## 1. What this branch carries

| Commit                                | Kind      | What                                                                                 |
| ------------------------------------- | --------- | ------------------------------------------------------------------------------------ |
| `chore: pin bun via mise`             | fork-only | `mise.toml`, bun 1.4.2 (upstream v2 requires it; `packages/script` throws otherwise) |
| `feat(cli): embed a prebuilt web UI…` | seam      | `OPENCODE_WEB_UI_DIST` in `packages/cli/script/app-assets.ts`                        |
| `ci: release v2 fork builds…`         | fork-only | `.github/workflows/release-fork.yml`, `install-v2`                                   |
| this file                             | fork-only |                                                                                      |

Deliberately **not** carried from v1, and why:

- **`tool-input-delta` publishing.** v2 publishes `session.tool.input.delta` natively.
- **`/fork/usage`.** Not wanted on v2 yet; v2 has `GET /api/experimental/session/stats`, and its message
  storage (`session_message`, content inline, no `part` table) means the v1 query would not port anyway.
- **Per-provider Bedrock credentials.** Not re-evaluated on v2's provider stack yet.
- **The `web/` submodule.** The v2 web UI is a separate, not-yet-existing repository. The seam and the
  workflow are ready for it (see §4); until it is added, releases embed upstream's `packages/app`.

---

## 2. Branch layout and following upstream

```
upstream/beta  ──►  jdscript-v2   this line's trunk; rebased onto upstream/beta; v2 releases cut from here
upstream/dev   ──►  dev  ──►  jdscript   the v1 line, unchanged
```

- There is **no `beta` mirror branch** in the fork (unlike `dev` for v1). Pushing upstream's `beta` to the
  fork would fire the push-triggered workflows that arrive with it (`publish.yml`, `deploy.yml`,
  `nix-hashes.yml` all list `beta`), and a workflow file that is not on the default branch cannot be
  disabled before its first run. The upstream commit a release sits on is recorded in its notes instead.
- `jdscript-v2` is the local development checkout at `~/Developer/opencode-beta` — a separate clone from the
  v1 checkout because the two need different bun versions (`mise.toml` in each).
- Rebasing is manual for now; the v1 `sync-fork.yml` is not ported. When it is, its version gate must read
  `packages/cli/package.json`, not `packages/opencode/package.json`.

```sh
git fetch upstream beta --tags
archive="fork/pre-rebase-v2/$(date -u +%Y%m%d%H%M)-onto-$(git rev-parse --short upstream/beta)"
git tag "$archive" jdscript-v2 && git push origin "$archive"
git rebase upstream/beta
```

### Upstream workflows

All of upstream's workflows are disabled in this repository through `gh workflow disable` (a repository
setting; survives rebases). Only `sync-fork.yml` (v1) and `release-fork.yml` are active. After any rebase
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

| File                                | Seam                                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------- |
| `packages/cli/script/app-assets.ts` | `OPENCODE_WEB_UI_DIST`: archive a prebuilt static directory instead of `packages/app` |

Fork-only files that are not seams: `mise.toml`, `.github/workflows/release-fork.yml`, `install-v2`.

### Non-obvious choices worth keeping

- **`OPENCODE_CHANNEL=jdscript`, never `latest`.** The inverse of the v1 rule. `packages/cli/src/database-path.ts`
  maps `latest`/`beta`/`dev`/`next` to `opencode.db` — the file the v1 fork uses — and v2 migrates a v1
  database on first start, irreversibly (it deletes the `event` table and never re-imports v1 sessions
  written afterwards). Any other channel gets `opencode-<channel>.db`, `service-<channel>.json`
  (`services/service-config.ts`) and a hash-derived default port, so a `jdscript` build runs beside a v1
  install without touching its data. The cost: `services/updater.ts` asks
  `opencode.ai/update/api/jdscript/cli/npm`, which does not exist, and logs a warning every ten minutes —
  see §5.
- **v2 releases are prereleases.** The repository also hosts the v1 fork, whose `opencode upgrade`
  (`packages/opencode/src/installation/fork.ts` on `jdscript`) reads `/releases/latest` = newest
  non-prerelease. A v2 release marked latest would be installed over every v1 user's binary. `install-v2`
  and the workflow's verify step list releases and take the newest `v2.` tag instead, and the verify step
  fails if `/releases/latest` stops being a `v1.*` tag. Flip `--prerelease` off when the v1 line retires.
- **The web UI is embedded as a finished directory, not built by `build.ts`.** Same reasoning as v1: the
  seam points upstream's archive step at any static directory; the release workflow owns building it.
  Upstream's own embedding (`app-assets.ts` → per-file brotli → `virtual:opencode-app-assets`, served by
  `packages/cli/src/services/web-ui.ts`) is unchanged, including the CSP contract: exactly one inline
  script is allowed, the one with `id="oc-theme-preload-script"`, whose hash `web-ui.ts` computes.
- **`install-v2` installs as `opencode-v2` by default.** `~/.opencode/bin/opencode` may be the v1 fork. The
  v2 updater's `curl` method detection (`updater.ts` `method()`) only recognises a binary at exactly
  `~/.opencode/bin/opencode`, so an `opencode-v2` install reports "installation method not found" for
  self-update — acceptable until the updater seam exists.

### Duplications that must be kept in step

| Value            | Locations                                                                                                |
| ---------------- | -------------------------------------------------------------------------------------------------------- |
| Fork GitHub repo | `GITHUB_REPO` in `install-v2` (and, once added, the updater seam)                                        |
| bun version      | `packageManager` in `package.json` · `mise.toml`. The workflow reads `package.json`, so it cannot drift. |
| Channel name     | `OPENCODE_CHANNEL: jdscript` in `release-fork.yml`; the db/service/port derive from it at runtime        |
| Archive names    | `opencode-<os>-<arch>.{zip,tar.gz}` in `release-fork.yml` and `install-v2`                               |

---

## 4. Releasing and the web UI

`gh workflow run release-fork.yml --ref jdscript-v2`. Version format `2.0.6-jdscript.202609190200-abcdef0`:
base from `packages/cli/package.json`, UTC stamp, fork sha. `packages/cli/src/services/updater-action.ts`
requires a valid semver with prerelease identifiers and treats equal strings as the same release, so the
stamp is required. Draft → three builds → prerelease → verify.

Adding the v2 web UI later is one commit and no workflow change:

```sh
git submodule add -b main ../<v2-webui-repo>.git web && git commit -m "feat: ship <name> as the embedded UI"
```

`release-fork.yml` already builds `web/` with pnpm when `web/package.json` exists and passes
`web/apps/spa/dist` through `OPENCODE_WEB_UI_DIST`; adjust that path if the new UI's output differs. The
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

Prefix `OPENCODE_WEB_UI_DIST=/path/to/ui/dist` to embed a different UI. `--skip-install` skips fetching the
`@opentui/core` and `@opencode-ai/pty` binaries for other targets; drop it if the build complains.

---

## 5. Known limitations

- **`opencode upgrade` does not work on the v2 fork build.** `services/updater.ts` hardcodes
  `opencode.ai/update/api/<channel>/cli/npm` and `opencode.ai/v2/install`; with channel `jdscript` the check
  fails and is logged as a warning on every 10-minute poll. The fix is a seam that, for this channel, reads
  the newest `v2.` release from GitHub and installs via `install-v2` — the v2 analogue of v1's
  `installation/fork.ts`. Until then, re-run `install-v2`.
- **No automatic upstream following.** See §2.
- **No `beta` mirror branch.** See §2.
- **`linux-arm64` needs a public repository.** The `ubuntu-24.04-arm` runner is only free on public repos.
