/**
 * FORK-ONLY FILE — not present upstream, so it never conflicts on rebase.
 *
 * Where this fork's builds come from, for the updater. Upstream's `services/updater.ts` asks
 * `opencode.ai/update/api/<channel>/cli/npm` and installs from npm or `opencode.ai/v2/install`; a fork
 * build following that path would replace itself with upstream's binary on the first update check. The two
 * seams in updater.ts route through here instead when `enabled`.
 *
 * A fork build is recognised by its version, not its channel: every release-fork.yml version carries the
 * `-jdscript.` prerelease identifier, and the channel is `latest` on purpose so the build shares
 * `opencode.db` with the v1 fork and migrates it on first start (see FORK.md).
 *
 * Releases are read from the repository's Atom feed rather than the REST API. The API allows 60
 * unauthenticated requests per hour per IP, which several machines behind one NAT polling every ten
 * minutes exhaust; the feed is a plain web page with no such limit. It lists the newest ten releases,
 * prereleases included, newest first — and v2 releases are prereleases for now (release-fork.yml says why),
 * so this must not read `/releases/latest`.
 */
import { Effect } from "effect"
import { OPENCODE_VERSION } from "./version"

export const REPO = "JDScript/opencode"
/** Branch the install script is fetched from. Must be the branch releases are cut from. */
export const BRANCH = "jdscript-v2"
export const INSTALL_SCRIPT = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/install-v2`
export const enabled = OPENCODE_VERSION.includes("-jdscript.")

/** Newest published release of the same major as this build, as `{ version }` without the leading `v`. */
export const release = Effect.fnUntraced(function* () {
  const major = OPENCODE_VERSION.split(".")[0]
  const response = yield* Effect.tryPromise({
    try: (signal) =>
      fetch(`https://github.com/${REPO}/releases.atom`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      }),
    catch: (cause) => new Error("Failed to check for updates", { cause }),
  })
  if (!response.ok) return yield* Effect.fail(new Error(`Update check failed with status ${response.status}`))
  const body = yield* Effect.tryPromise({
    try: () => response.text(),
    catch: (cause) => new Error("Failed to read update information", { cause }),
  })
  const version = Array.from(body.matchAll(/<title>v(\d[^<]*)<\/title>/g), (match) => match[1]).find((candidate) =>
    candidate.startsWith(`${major}.`),
  )
  if (!version) return yield* Effect.fail(new Error(`No v${major} release found for ${REPO}`))
  return { version }
})
