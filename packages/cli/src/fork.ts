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
import { Global } from "@opencode/util/global"
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

/** The v1 OpenViking npm plugin this fork ships a built-in replacement for (see packages/plugin-openviking). */
export const LEGACY_OPENVIKING = "@openviking/opencode-plugin"

/**
 * Configured plugins still naming the v1 OpenViking package. It keeps working through the host's v1
 * compatibility adapter, but the built-in plugin stands down while it is present, so after an upgrade
 * the user is told to drop it. Only the global config is checked; project files are the project's business.
 */
export const legacyOpenVikingConfigs = Effect.fnUntraced(function* () {
  const directory = process.env.OPENCODE_CONFIG_DIR ?? Global.Path.config
  const candidates = ["opencode.json", "opencode.jsonc"].map((name) => `${directory}/${name}`)
  return yield* Effect.filter(candidates, (file) =>
    Effect.promise(() =>
      Bun.file(file)
        .text()
        .then((text) => text.includes(`"${LEGACY_OPENVIKING}"`))
        .catch(() => false),
    ),
  )
})

export const legacyOpenVikingNotice = (files: ReadonlyArray<string>) =>
  [
    `This build has OpenViking memory built in; it reuses your ~/.openviking credentials.`,
    `Remove "${LEGACY_OPENVIKING}" from the plugins list in ${files.join(" and ")} to switch over.`,
    `Until then the v1 plugin keeps running through the compatibility adapter and the built-in one stays idle.`,
  ].join("\n")
