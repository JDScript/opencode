# Fork notes

A fork of [anomalyco/opencode](https://github.com/anomalyco/opencode) that adds a real config editor to
the web UI and makes the sidebar's project list discover itself from the server, published to this
repository's own GitHub Releases.

The design goal that shapes every decision here: **stay rebasable onto upstream forever.** Upstream
moves fast. So the rule is _new files plus the smallest possible seams_ — almost all logic lives in
files upstream does not have, and upstream files carry only a few clearly-marked lines. Every such line
carries a `FORK` comment and is listed below.

---

## 1. What changed, functionally

|                                    | Before                                                                       | After                                                                                                                       |
| ---------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Config editing from the web UI** | Two keys only (`shell`, `disabled_providers`)                                | Whole global config file, with server-authoritative validation and a field reference generated from the server's own schema |
| **Sidebar project list**           | Purely local to each browser — every device re-adds the same folders by hand | Auto-seeded from the server's `project` table; local list still owns show/hide/order                                        |

Deliberately **not** done, and why:

- **UI-preference roaming.** UI settings stay in `localStorage`. The theme is read synchronously in
  `<head>` by `packages/app/public/oc-theme-preload.js` to avoid a flash of the wrong theme; making it
  server-sourced reintroduces that flash unless localStorage becomes a cache, which is a lot of moving
  parts for little gain.
- **Server self-restart.** Config changes already take effect without one: `PATCH /global/config` and
  the fork's `PUT /fork/config/raw` both dispose every instance, so the next request rebuilds against
  the new config. Only the server listen options (`port`, `hostname`, `cors`, `mdns`) need a real
  restart, because `cli/network.ts` reads them once at startup. A self-restart endpoint was rejected on
  safety grounds: these servers are reached only over the network, so a failed restart would leave the
  machine unreachable — and a config editor is exactly where a bad value gets introduced.
- **Cross-machine session aggregation.** Not needed. The app already fans out to several servers, each
  with its own SDK and event stream (`context/server-sdk.tsx`), so pointing it at every machine over
  Tailscale already gives one UI over all of them — including running tools on the remote machine,
  since the browser talks to that machine's own server.
- **Publishing to npm / brew / AUR / ghcr.** Only GitHub Releases + the `curl` installer.

---

## 2. Branch layout

```
upstream/dev  ──►  dev        pure mirror, fast-forward only, never edited
                    └──►  jdscript   this fork's work; rebased onto dev; releases tagged here
```

- `dev` exists only to track upstream. Never commit to it — that keeps it incapable of conflicting.
- `jdscript` is the working branch and the fork's default branch.
- `git rerere` is enabled, so a conflict resolved once is replayed automatically on later rebases.
- `upstream`'s push URL is deliberately set to `DISABLED_DO_NOT_PUSH_TO_UPSTREAM`.

### Rebasing onto a new upstream release

```sh
git fetch upstream dev --tags
git switch dev && git merge --ff-only upstream/dev   # cannot conflict; refuses if it would
git switch jdscript && git rebase dev
```

Then work through section 3 and re-run the checks in section 5. If a hunk fails to apply, find the
matching row below — it says what the seam is for, which is usually enough to place it by hand.

---

## 3. Upstream touch points

This is the entire rebase cost: **8 files, +113 / −22 lines**, most of which are explanatory comments.
List every seam with:

```sh
git grep -nE '(//|#) FORK' -- ':!FORK.md'    # 20 lines across the 8 files below
```

(Match the comment prefix, not the bare word — upstream's `patches/install-korean-ime-fix.sh` uses
`FORK_REPO` for something unrelated.)

| File                                                             | Lines  | Seam                                                                       |
| ---------------------------------------------------------------- | ------ | -------------------------------------------------------------------------- |
| `packages/opencode/src/server/routes/instance/httpapi/api.ts`    | +2     | Mounts `ForkConfigApi` on `OpenCodeHttpApi`                                |
| `packages/opencode/src/server/routes/instance/httpapi/server.ts` | +9     | `forkConfigApiRoutes` layer, added to `createRoutes`                       |
| `packages/opencode/src/config/config.ts`                         | +4 −1  | `export` on `globalConfigFile()`                                           |
| `packages/opencode/src/installation/index.ts`                    | +22 −4 | Fork release/install URLs, plus the fork-build short circuit in `latest()` |
| `install`                                                        | +12 −7 | `GITHUB_REPO` variable replacing hardcoded download URLs                   |
| `packages/app/src/context/language.tsx`                          | +8 −4  | Merges the fork i18n dictionaries                                          |
| `packages/app/src/context/layout.tsx`                            | +46 −6 | `openProject` extraction + the project-seeding effect                      |
| `packages/app/src/components/settings-v2/dialog-settings-v2.tsx` | +10    | Config-file tab trigger and content                                        |

### Non-obvious choices worth keeping

- **`ForkConfigApi` is mounted standalone, not added to `RootHttpApi`.** Adding a group to `RootHttpApi`
  changes its requirement set, which breaks `test/server/httpapi-global.test.ts` and
  `test/server/httpapi-control-plane.test.ts` — both build `HttpApiBuilder.layer(RootHttpApi)` with a
  fixed handler list. Mounting standalone (like `EventApi`) keeps those files untouched. **If a rebase
  ever makes those tests fail with `ApiGroup<"opencode-root", "forkConfig"> is not assignable to never`,
  the seam has drifted back into `RootHttpApi`.**
- **`globalConfigFile()` is exported rather than reimplemented.** It probes `opencode.jsonc`,
  `opencode.json`, `config.json` in order. Copying that list would let the editor silently read and
  write a _different_ file than the server loads if upstream reorders it. A missing export is a build
  error; silent divergence is not.
- **Fork i18n keys live in `packages/app/src/i18n/fork/`, never in `en.ts` / `zh.ts`.** Those two files
  change constantly upstream. Every fork key is prefixed `fork.` so it can never shadow an upstream one,
  and locales without a fork translation fall back through the English base automatically.
- **No generated SDK regeneration.** `/fork/*` endpoints are called through the hand-written
  `packages/app/src/utils/fork-api.ts`. Regenerating `@opencode-ai/sdk` / `@opencode-ai/client` would
  rewrite thousands of lines in checked-in `generated/` directories that upstream also regenerates —
  the worst possible conflict.
- **Config validation is a server round-trip, not a local `JSON.parse`.** The file is `.jsonc`, so
  `JSON.parse` cannot read it and any regex that strips comments mishandles string literals containing
  `//`. `POST /fork/config/validate` runs the real parser and the real schema decode, so the editor's
  verdict can never disagree with what a save does.
- **The project-seeding effect skips `recentlyClosed` and the `global` pseudo-project.**
  `server.projects.open()` _removes_ a directory from `recentlyClosed`, so seeding without that check
  would silently undo every close on the next render. And every directory outside a git repo resolves to
  one project whose worktree is `/`, holding unrelated sessions from many directories — auto-adding it
  would put a bare `/` row in the sidebar.

### Duplications that must be kept in step

Nothing enforces these; they are the only places one value lives twice.

| Value       | Locations                                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------ |
| GitHub repo | `REPO` in `packages/opencode/src/installation/fork.ts` · `GITHUB_REPO` in `install` (a shell script cannot import TS)          |
| bun version | `packageManager` in `package.json` · `mise.toml`. The release workflow reads it from `package.json`, so that one cannot drift. |

---

## 4. Releasing

`.github/workflows/release-fork.yml`, run via **workflow_dispatch**. Nothing else is needed: upstream's
`publish.yml` is guarded by `if: github.repository == 'anomalyco/opencode'` and so does nothing in a
fork — which is why it is left completely unmodified.

Version format:

```
1.18.16-jdscript.202608111432-a1b2c3d
└ upstream base   └ UTC stamp     └ commit
```

- The base is read from `packages/opencode/package.json`, or passed in explicitly via the `base` input.
  **Not from `git describe`** — upstream's release tags are not ancestors of `dev`, because
  `script/publish.ts` commits and tags on a detached commit and pushes only a separate "sync release
  versions" commit to `dev`. `git describe` therefore cannot see `v1.18.16` and walks back to whatever
  ancient tag happens to be reachable; the first run of this workflow derived `1.4.11` that way. That
  same sync commit is what writes the released version into every `package.json`, which makes that file
  upstream's own record of the branch's release.
- The stamp sorts lexicographically, which is how semver compares alphanumeric prerelease identifiers,
  so versions order by release time. The sha makes any build traceable to exact source.
- **A stamp is required, not optional.** `cli/upgrade.ts` compares versions with plain string equality
  (`if (InstallationVersion === latest) return`), so two releases on the same upstream base sharing a
  version string means clients never see the second one.

`script/publish.ts` is **never** run. It publishes to npm/brew/AUR/ghcr and — the real problem — commits
and force-pushes to `dev`, which would fight the rebase workflow. Version instead comes from
`OPENCODE_VERSION`, which `packages/script` treats as highest priority, so **releasing produces no git
commits at all.**

The release is created as a draft, assets are uploaded by `build.ts`, and only then is it published, so
a failed build cannot leave `/releases/latest` pointing at a release with missing assets. The final job
asserts against the live API that the release is neither draft nor prerelease, has three binary assets,
and is what `repos/…/releases/latest` actually returns.

### Two constraints that silently break `opencode upgrade`

1. **`OPENCODE_CHANNEL` must be `latest`.** `packages/core/src/database/database.ts` picks the filename
   `opencode-<channel>.db` for any other value, so the build starts against an empty database and every
   existing project and session vanishes.
2. **Install via `curl`, into `~/.opencode/bin`.** `Installation.method()` infers the install method from
   `process.execPath`; anywhere else it shells out to `npm list -g`, `brew list`, etc. A leftover official
   install would then be treated as the upgrade channel. `latest()` has a fork-build short circuit that
   stops that from silently replacing the fork with the upstream build, but the method detection itself is
   still upstream's, so a wrong method makes upgrade fail loudly instead.

```sh
curl -fsSL https://raw.githubusercontent.com/JDScript/opencode/jdscript/install | bash
```

---

## 5. Working on this fork

bun is pinned in `mise.toml` (`mise install`), because `packages/script` throws if the running bun does
not match `packageManager`.

```sh
mise install && bun install
cd packages/app      && bun run typecheck
cd packages/opencode && bun run typecheck
```

**Running the web UI locally needs two processes.** When there is no embedded UI bundle,
`server/shared/ui.ts` reverse-proxies `/*` to `https://app.opencode.ai` — so running only the server
shows the _official_ live frontend and none of your changes:

```sh
cd packages/opencode && bun run --conditions=browser ./src/index.ts serve --port 4096
cd packages/app      && bun dev -- --port 4444    # open this one
```

`entry.tsx` points the dev build at `localhost:4096`.

---

## 6. Known limitations

- **The config editor shows secrets in plaintext.** The global config can hold provider API keys. This is
  not a new exposure — `GET /global/config` already returns the same values and both require auth — but
  the values are now on screen. Do not screen-share that tab.
- **Config editing is global-scope only.** Per-project `opencode.json` is not editable from the UI. Those
  files are usually committed to a team repo, so editing them from a browser invites accidents. The
  endpoints take no scope parameter yet; adding one is the natural extension.
- **No "effective configuration" view.** What the server actually ends up using is the merge of six
  sources (remote well-known config, global file, `OPENCODE_CONFIG`, project files, `OPENCODE_CONFIG_DIR`,
  `OPENCODE_CONFIG_CONTENT`) and is per-directory, so it does not belong in a global-scope editor.
- **Seeded projects arrive expanded and unbounded.** `server.projects.open()` hardcodes `expanded: true`,
  and `context/layout.tsx` loads sessions for every listed project on mount. Fine at the current handful
  of projects; past a few dozen, cap that `onMount` loop to expanded or recent projects.
- **Closing more than 16 projects lets the oldest reappear.** `recentlyClosed` is capped at
  `RECENTLY_CLOSED_HISTORY_LIMIT = 16`, and the seeding effect uses it as the "don't re-add" set.
- **`linux-arm64` needs a public repository.** The `ubuntu-24.04-arm` runner is only free on public
  repos; drop that matrix entry otherwise.
- **The old settings UI is not touched.** The config tab is only in `settings-v2`, shown when
  `settings.general.newLayoutDesigns` is on. Upstream sunsets the v1 layout on 2026-09-14
  (`context/settings.tsx`), so v1 was not worth wiring up.
