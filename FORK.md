# Fork notes

A fork of [anomalyco/opencode](https://github.com/anomalyco/opencode) that carries a few **server-side** patches
for a separate client, and publishes its own binaries to this repository's GitHub Releases. The UI is not
touched: the client that consumes these patches lives elsewhere.

The design goal that shapes every decision here: **stay rebasable onto upstream forever.** Upstream moves
fast. So the rule is _new files plus the smallest possible seams_ — upstream files carry only a few
clearly-marked lines, every such line carries a `FORK` comment, and every seam is listed in section 3.

---

## 1. What changed, functionally

|                                     | Before                                                                              | After                                                                                                                                                             |
| ----------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Tool-call argument streaming**    | `tool-input-delta` swallowed by the V1 processor; a client sees the call only whole | Each chunk published as a `message.part.delta` (`field: "raw"`) on the pending tool part, so a client can meter it                                                |
| **Several Bedrock providers**       | Only the provider literally named `amazon-bedrock` got AWS credentials              | Every provider on the Bedrock SDK package resolves its own profile, region, endpoint and auth entry                                                               |
| **Usage aggregation**               | Context-window fill for the current session only, read off its last message         | `GET /fork/usage`: cost, requests, five token classes and thinking time over the whole history, grouped by time bucket, session, project, model, agent or variant |
| **Releases and `opencode upgrade`** | Point at upstream                                                                   | Point at this repository; the fork follows upstream releases automatically                                                                                        |

### What used to be here

An earlier incarnation of this fork also carried a web-UI config editor, a usage dashboard, a live TPS meter,
server-seeded sidebar projects and fork-local i18n, plus the `/fork/config` endpoint behind the editor. All of
it was retired when the UI work moved to a separate client; `/fork/usage` came back afterwards, because that
client wants the same numbers and the aggregation belongs next to the database. It is preserved, with its own
FORK.md, on the **`deprecated`** branch — frozen at `104681add5` on upstream `1.18.29`
(`57ef382843`) — and in every release tag cut before that point. Nothing on `jdscript` depends on it.

---

## 2. Branch layout

```
upstream/dev  ──►  dev         pure mirror, fast-forward only, never edited
                    ├──►  jdscript    this fork's trunk; rebased onto dev; releases are cut from here
                    │        └──►  feature branches, cut from jdscript and merged back into it
                    └──►  deprecated  frozen; the retired UI-era patch series, never rebased again
```

- `dev` exists only to track upstream. Never commit to it — that keeps it incapable of conflicting.
- `jdscript` is the fork's default branch and is treated as its **production** branch: anything
  non-trivial is developed on a branch cut from it, not committed to it directly.
- `deprecated` is an archive, not a branch of development. Cherry-pick from it if something turns out to be
  wanted again; do not rebase it.
- `git rerere` is enabled, so a conflict resolved once is replayed automatically on later rebases.
- `upstream`'s push URL is deliberately set to `DISABLED_DO_NOT_PUSH_TO_UPSTREAM`.

### Every upstream workflow is disabled in this fork

All of them, through `gh workflow disable` — a repository setting, so it costs no seam and survives every
rebase. Only the two fork-only workflows, `sync-fork.yml` and `release-fork.yml`, are active.

They had to go because a fork inherits them with write permissions and almost none of them check which
repository they are in: of the seven scheduled workflows only `stats` has a guard, so `compliance-close` was
running every thirty minutes with `issues: write` and `pull-requests: write`, `beta` hourly with
`contents: write` and a script that can push, and `close-prs` daily. That started the day `jdscript` became
the default branch, which is where GitHub reads schedules from.

The ones triggered by a push to `dev` are worse than useless rather than merely wasteful: `dev` is a pure
mirror, so `test`, `typecheck` and `nix-eval` were testing upstream's tree and never this fork's, while
`generate` sat there with `contents: write` ready to commit generated files onto the mirror. Nothing watches
`jdscript`, so nothing was lost by turning them all off.

To check, after any rebase or any upstream change to `.github/workflows/`:

```sh
gh workflow list --repo JDScript/opencode --json name,path,state \
  --jq '.[] | select(.state=="active") | .path'   # must print only sync-fork.yml and release-fork.yml
```

A workflow file that upstream _adds_ later arrives enabled, which is why this is worth re-checking rather
than assuming. It has happened: `unlock.yml` arrived that way and was disabled by hand.

### Pushing `jdscript` triggers nothing — but releasing builds what GitHub has

No workflow fires on a push to this branch. Every upstream workflow is either limited to
`dev` / `production` / `beta` / `ci`, or triggered by a `github-v*` / `vscode-v*` **tag** (never created
here), or `workflow_dispatch`-only — including `release-fork.yml`; `sync-fork.yml` is schedule and
dispatch only. So `jdscript` can be force-pushed after a rebase without side effects.

The catch runs the other way: `release-fork.yml`'s build job checks out `git rev-parse HEAD` **of the
dispatched ref on GitHub**, not anything local. A rebase that has not been pushed means a release would
build the pre-rebase code. **Push before releasing.**

### Following upstream is automatic

`.github/workflows/sync-fork.yml` runs twice a day and does, unattended, exactly what the manual
procedure below does: archive tag, fast-forward `dev`, rebase `jdscript`, typecheck, push, then dispatch
`release-fork.yml`. The manual procedure is kept because it is what the workflow runs, and what you fall
back to when it cannot.

It acts only when **upstream's version changes**, not on every upstream commit — force-pushing the trunk
dozens of times per release would fight any local work and produce releases nobody asked for. The test is
the `version` field of `packages/opencode/package.json` on upstream `dev` versus on `jdscript`; that file
is what upstream's "sync release versions" commit writes, and this fork never touches it, so it is the
upstream version the trunk currently sits on. The check is two API reads with no checkout, so the schedule
could be much tighter at no real cost; twelve hours is a choice, not a limit.

One consequence worth knowing: a rebase done **by hand** is not released, because afterwards the versions
already match and the next scheduled run sees nothing to do. Either let the workflow do the rebase, or
follow a manual one with `gh workflow run sync-fork.yml -f force=true`.

Three things it will refuse to do, and each fails the run with nothing pushed:

- **Resolve a conflict.** `git rerere`'s cache is in the local `.git`; a runner has none. Rebase locally as
  below — rerere replays anything seen before — push, and the next run finds nothing to do.
- **Drop a patch.** `git rebase` silently omits a fork patch whose changes are already upstream. That is good
  news, but the seam table in §3 is now wrong, so the run stops until someone removes the row and re-runs.
- **Push a tree that does not typecheck.** The same `bun typecheck` the pre-push hook runs. Upstream's own CI
  keeps `dev` green, so this is almost always upstream being briefly red; the next run retries.

The force-push carries `--force-with-lease` against the commit the run started from, so a manual push that
lands mid-run is never clobbered; the run fails instead and the next one starts from the new tip.

Dispatching by hand takes two inputs. `force` syncs even when the version is unchanged — onto upstream's
current tip if it moved, otherwise straight to the release — which is how to cut a release of the current
trunk without opening `release-fork.yml`. `release=false` syncs without releasing.

```sh
gh workflow run sync-fork.yml -f force=true                  # release now, on whatever upstream has
gh workflow run sync-fork.yml -f force=true -f release=false  # rebase only
```

Known edges: GitHub disables scheduled workflows in a public repository after 60 days without a commit. The
workflow's own pushes count, so that only bites if upstream stops releasing for two months — re-enable with
`gh workflow enable sync-fork.yml`. And the release is dispatched, not chained: a build failure shows up as a
failed `release-fork` run, while the `sync-fork` run that pushed the rebase stays green.

### Rebasing onto a new upstream release by hand

```sh
git fetch upstream dev --tags

# Pin the pre-rebase state before rewriting it. A tag is permanent and costs nothing, and it makes the
# force-push reversible without the reflog — which is local-only and expires after 90 days. Release tags
# already pin every *released* state; this covers the unreleased ones.
archive="fork/pre-rebase/$(date -u +%Y%m%d%H%M)-onto-$(git rev-parse --short upstream/dev)"
git tag "$archive" jdscript && git push origin "$archive"

git switch dev && git merge --ff-only upstream/dev   # cannot conflict; refuses if it would
git switch jdscript && git rebase dev

# Push the mirror too, so GitHub's compare views and the fork's own record of "which upstream point are
# we on" stay honest. The release workflow deliberately does not depend on this — it asks upstream
# directly — precisely because a stale mirror is easy to leave behind.
#
# This is the push that fires upstream's own CI, since `dev` is what those workflows watch. Harmless only
# because they are all disabled — see the section above, and re-check it if upstream added a workflow.
git push origin dev
```

Then work through section 3 and re-run the checks in section 5. If a hunk fails to apply, find the
matching row below — it says what the seam is for, which is usually enough to place it by hand.

Prune old `fork/pre-rebase/*` tags whenever they get noisy — they are pure insurance, and any state that
was actually shipped is pinned by its release tag instead.

### Tracing a past release across rebases

Rebasing rewrites `jdscript`, so a released commit stops being an ancestor of the branch. **The source is
not lost:** `gh release create --target <sha>` creates a tag at that commit, tags are independent refs
that no rebase or force-push can move, and GitHub never garbage-collects a tagged commit. Verified: the
first release's tag still resolves to its exact pre-rebase commit.

What that leaves working, and the one thing it does not:

| Question                            | Command                                                                           |
| ----------------------------------- | --------------------------------------------------------------------------------- |
| What source built version X?        | `git checkout v<version>`                                                         |
| What differs between two releases?  | `git diff v<a> v<b>`                                                              |
| How did _our patch series_ change?  | `git range-diff <baseA>..v<a> <baseB>..v<b>`                                      |
| Which upstream tree was X on?       | its release notes — upstream version **and** commit                               |
| ~~Commit log between two releases~~ | **broken**: `git log v<a>..v<b>` spans two rewritten histories and is meaningless |

`git range-diff` is the replacement for that last row and it is exact: run across the first rebase it
reported every fork patch as `=`, unchanged, with the old→new sha mapping.

The release notes carry the upstream version **and** the upstream commit because the version alone does
not identify the upstream tree — upstream lands many commits without bumping it (15 in one day, all still
`1.18.16`).

---

## 3. Upstream touch points

This table is the rebase checklist: **every upstream file this fork edits, and what for.** It records
_what_ changed, not how many lines — line counts churn on every commit and go stale faster than they help.

List every seam with:

```sh
git grep -nE '(//|#) FORK' -- ':!FORK.md'
```

Match the comment prefix, not the bare word: upstream's `patches/install-korean-ime-fix.sh` uses
`FORK_REPO` for something unrelated. That command also matches the fork-only files that carry a `FORK`
header (`mise.toml`, `.github/workflows/sync-fork.yml`, `.github/workflows/release-fork.yml`) and the two
fork test fixtures — those are **not** seams, they do not exist upstream and cannot conflict.

| File                                                             | Seam                                                                          |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `packages/opencode/src/installation/index.ts`                    | Fork release/install URLs, plus the fork-build short circuit in `latest()`    |
| `install`                                                        | `GITHUB_REPO` variable replacing hardcoded download URLs                      |
| `packages/opencode/src/provider/provider.ts`                     | Selects the Bedrock credential loader by SDK package, not only by provider id |
| `packages/opencode/src/session/processor.ts`                     | Publishes `tool-input-delta` as a `raw` PartDelta on the pending tool part    |
| `packages/opencode/src/server/routes/instance/httpapi/api.ts`    | Mounts `ForkUsageApi` on `OpenCodeHttpApi`                                    |
| `packages/opencode/src/server/routes/instance/httpapi/server.ts` | `forkUsageApiRoutes` layer, in `createRoutes`                                 |

Fork-only files that are not seams: `packages/opencode/src/installation/fork.ts`, the usage endpoint's
`groups/fork-usage.ts` and `handlers/fork-usage.ts`, the two workflows,
`mise.toml`, and the fork cases in `test/provider/amazon-bedrock.test.ts` and
`test/session/processor-effect.test.ts` (marked `FORK`, appended to upstream's own files).

### Non-obvious choices worth keeping

- **Several Bedrock providers, one AWS profile each.** `custom()` in `provider.ts` is a map of per-provider
  loaders keyed by **provider id**, and the loop that ran it looked each provider up by that id — so only the
  provider literally called `amazon-bedrock` ever got a `credentialProvider`. Pointing a second provider at
  the Bedrock package with `npm` loaded the right SDK with no credentials behind it, which is the wrong shape
  for the real requirement: one profile that may reach a model another may not. The loop now
  iterates the provider database and selects the Bedrock loader by **SDK package** as well as by id, and the
  loader reads `provider.id` instead of the hardcoded string so each provider gets its own profile, region,
  endpoint and auth entry. Two things are deliberate:
  - **Only Bedrock is matched by package.** Generalising this to the whole map would change behaviour for
    existing configs — `openai`'s loader forces `sdk.responses()` on every model, so any lookalike provider
    declaring `npm: "@ai-sdk/openai"` would silently switch API surface. Bedrock is the only loader that reads
    nothing but the provider's own config, so it is the only one that is safe to fan out.
  - **`apiKey: ""` is pinned whenever a `credentialProvider` is injected.** `createAmazonBedrock` prefers a
    bearer token over `credentialProvider`, and falls back to `AWS_BEARER_TOKEN_BEDROCK` when `apiKey` is
    absent. That variable is process-global and the loader itself writes to it from `auth.json`, while SDKs are
    built lazily at request time — so with two Bedrock providers the bearer token of whichever loaded second
    would silently outrank the first one's profile. The empty string is falsy to the SDK's own
    `trim().length > 0` check, which selects SigV4, and it also stops `resolveSDK` filling `apiKey` from
    `provider.key`.

  Upstreamable as-is. Upstream's own V2 stack already gates on the package in
  `packages/core/src/plugin/provider/amazon-bedrock.ts`, so this only brings the live V1 path in line; drop it
  if V1 is retired or upstream backports that gate.

- **Tool argument deltas are published, not stored.** Upstream's V1 `processor.ts` swallows `tool-input-delta`
  (it only makes sure the pending part exists), so a client cannot show the model writing a call, or meter it.
  The seam forwards each chunk as a `message.part.delta` with `field: "raw"` on the pending tool part — the
  field that state already carries as `""` — through `session.updatePartDelta`, which only publishes; nothing
  is persisted and `raw` is still filled in whole when `tool-call` arrives. Upstream's V2 runner
  (`packages/core/src/session/runner/publish-llm-event.ts`) already publishes the equivalent
  `Tool.Input.Delta`, so this only brings V1 in step; drop it when V1 is retired.

  Every existing consumer of `message.part.delta` was checked. The generic reducers in the app, TUI and
  `server-session` apply `part[field] += delta` at the top level, so for a few milliseconds a tool part in
  their stores carries a stray top-level `raw` string (the schema's is `state.raw`); nothing reads it, and
  the `message.part.updated` that follows `tool-call` replaces the part and clears the accumulator. ACP and the
  `run` CLI filter on part type or `field === "text"` and ignore it. A client that wants the meter reads the `raw` deltas itself.

- **`ForkUsageApi` is mounted standalone, not added to `RootHttpApi`.** Adding a group to `RootHttpApi`
  changes its requirement set, which breaks `test/server/httpapi-global.test.ts` and
  `test/server/httpapi-control-plane.test.ts` — both build `HttpApiBuilder.layer(RootHttpApi)` with a fixed
  handler list. Mounting standalone (like `EventApi`) keeps those files untouched. **If a rebase ever makes
  those tests fail with `ApiGroup<"opencode-root", "forkUsage"> is not assignable to never`, the seam has
  drifted back into `RootHttpApi`.** It needs auth only: `Database.Service` comes from the app-level layer
  group, and the endpoint reads the whole database, so no workspace routing or instance context.
- **The usage endpoint takes a bucket _duration_ and an alignment _origin_, never a calendar unit.** So the
  server holds no timezone knowledge: grouping is `(ts - originMs) / bucketMs`. The client computes
  `originMs` with its own tzdata, which SQLite does not have — `date(ts, 'unixepoch', 'Asia/Shanghai')`
  returns NULL, so the only server-side alternative is a fixed offset that misplaces spend across DST. It
  also lets the day boundary move off midnight, which matters here: 75% of one history's spend fell in the
  00:00–03:00 hours local, so a calendar day splits one night's work across two columns. A day is therefore
  never requested as a day: the client asks for hours and folds them itself, since a fixed 86400000 is not
  a local day across a DST change.
- **Usage reads both message tables and normalizes them.** v1 writes `message`, durable v2 sessions write
  `session_message`, and neither is authoritative alone — on a real installation `session_message` is empty
  and every message is in `message`. `UNION ALL` is correct either way with no flag detection, since a
  session lives in exactly one. Three shape differences would each silently yield nulls if crossed: `role`
  is inside the JSON in v1 but a column in v2, the model is flat in v1 and nested in v2, and v2's
  `Model.Ref` names it `id`, not `modelID`.
- **Usage aggregates per message, not from the `step-finish` parts that maintain the session totals.** Both
  reconcile exactly — $204.0577 three ways on real data — but only messages carry the model, agent and
  variant. Grouping by session also returns `parentSessionID` so the client can roll sub-agent spend up or
  leave it flat; sub-sessions held 31% of all spend, so both readings are needed and the endpoint takes no
  position.
- **Usage creates two indexes at runtime, not through a migration.** Without them the reasoning-time
  subquery is a full scan of `part`, and the cost is I/O, not JSON: `data` sits in overflow pages, tool
  outputs are 577 MB of its 755 MB, and `json_extract(data, '$.type')` must read every one to learn it is
  not reasoning. Measured: 5.9 s per request on a 31k-message database; 0.2 s with the indexes; results
  identical across all 186 hourly buckets. `fork_part_reasoning_time_idx` is a partial covering index over
  the 30k reasoning parts (1.6 MB), `fork_message_time_created_idx` makes a windowed query a range read
  (0.4 MB). They are `CREATE INDEX IF NOT EXISTS` on every usage request because the migration list is
  upstream's file and the worst possible conflict; Drizzle replays journal entries and never diffs the live
  schema, so it cannot notice them, and when they exist the statement compiles to a no-op in a read
  transaction (verified against a read-only connection). Two things to know: the **partial index's
  predicate must stay byte-identical** to the subquery's `WHERE`, literals and all, or SQLite silently
  stops using it and the 5.9 s comes back; and the **first request on a large database pays the build**
  (~6–8 s holding the write lock, so a concurrently streaming session waits on the 5 s `busy_timeout`
  and could see `SQLITE_BUSY`) — once per database, then never again.

### Duplications that must be kept in step

Nothing enforces these; they are the only places one value lives twice.

| Value            | Locations                                                                                                                                          |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fork GitHub repo | `REPO` in `packages/opencode/src/installation/fork.ts` · `GITHUB_REPO` in `install` (a shell script cannot import TS)                              |
| bun version      | `packageManager` in `package.json` · `mise.toml`. The release workflow reads it from `package.json`, so that one cannot drift.                     |
| Upstream repo    | the `git remote` named `upstream` · `anomalyco/opencode` in `sync-fork.yml` (twice) and `release-fork.yml` (a workflow cannot read a local remote) |
| Trunk branch     | `jdscript` is hardcoded in `sync-fork.yml` as the checkout ref, the version-check ref, the push target and the release ref                         |

---

## 4. Releasing

`.github/workflows/release-fork.yml`, run via **workflow_dispatch** — normally by `sync-fork.yml` right
after it pushes a rebase, or by hand for a release of the current trunk. Nothing else is needed: upstream's
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
cd packages/opencode && bun run typecheck
cd packages/opencode && bun test test/provider/amazon-bedrock.test.ts test/session/processor-effect.test.ts
```

Both test files are upstream's with fork cases appended; the fork cases are marked `FORK` and were each
confirmed to fail with their seam removed.

---

## 6. Known limitations

- **Tool argument deltas are visible only to a live subscriber.** They are published, never stored, so a
  client that connects mid-call sees `raw: ""` until the `tool-call` event fills it. That is the same
  trade-off `reasoning-delta` already makes, and it is what keeps the seam to one call.
- **Usage covers this fork's own database only.** It reports what opencode recorded, so it will never agree
  with a provider's dashboard or with what another client spent on the same account.
- **A free model reporting `cost: 0` is indistinguishable from no cost.** The figures are what the provider
  reported per message; a model with no pricing data contributes zero and its tokens still count.
- **An unwindowed usage query still scans `message`.** Every JSON field it sums lives in `data`, so no index
  can cover it; 118 MB and ~0.15 s warm on a real database, which is fine, but it grows with history. The
  `part` scan that actually hurt is gone (see §3).
- **`linux-arm64` needs a public repository.** The `ubuntu-24.04-arm` runner is only free on public
  repos; drop that matrix entry otherwise.
