/**
 * FORK-ONLY FILE — not present upstream, so it never conflicts on rebase.
 *
 * Single place this fork's release identity is defined. `installation/index.ts` only imports from
 * here, so moving the repo or renaming the branch is a one-file change and the upstream touch points
 * stay as bare constant references.
 *
 * The one unavoidable duplication is the root `install` shell script, which cannot import TypeScript —
 * `REPO` below and the download URLs in that script must be kept in step. FORK.md records this.
 */
import { InstallationVersion } from "@opencode-ai/core/installation/version"

const REPO = "JDScript/opencode"

/** Branch the install script is fetched from. Must be the branch releases are tagged on. */
const BRANCH = "jdscript"

/**
 * Substring present in every fork version (`1.18.16-jdscript.<stamp>-<sha>`) and in no upstream one.
 *
 * Used to detect a fork build at runtime. Source checkouts report version `"local"`, so a dev run is
 * correctly *not* treated as a fork build and keeps upstream behaviour.
 */
const VERSION_MARKER = "-jdscript."

export const ForkRelease = {
  repo: REPO,
  branch: BRANCH,
  versionMarker: VERSION_MARKER,
  latestReleaseApi: `https://api.github.com/repos/${REPO}/releases/latest`,
  installScript: `https://raw.githubusercontent.com/${REPO}/${BRANCH}/install`,
} as const

/** True when the running binary was produced by this fork's release workflow. */
export function isForkBuild() {
  return InstallationVersion.includes(VERSION_MARKER)
}
