/**
 * FORK-ONLY FILE — not present upstream, so it never conflicts on rebase.
 *
 * Configured plugin packages that a built-in plugin of this fork replaces. A user who upgrades from the
 * v1 fork still lists the npm package in `plugins`; loading it would run the v1 code through the
 * compatibility adapter alongside the built-in, so the supervisor drops the operation instead and says so
 * once. The config file is never edited: the entry is harmless and the user can remove it whenever.
 */
import { Effect } from "effect"
import type { ConfigPluginSource } from "../config/plugin/source.js"

export const SUPERSEDED: Readonly<Record<string, string>> = {
  "@openviking/opencode-plugin": "opencode.openviking",
}

/** Package name of an npm plugin target, without a version or tag suffix. */
export function packageName(target: string) {
  const at = target.indexOf("@", target.startsWith("@") ? 1 : 0)
  return at === -1 ? target : target.slice(0, at)
}

const announced = new Set<string>()

export const filter = Effect.fn("PluginSuperseded.filter")(function* (
  operations: readonly ConfigPluginSource.Operation[],
) {
  return yield* Effect.filter(operations, (operation) =>
    Effect.gen(function* () {
      if (operation.type !== "add") return true
      const builtin = SUPERSEDED[packageName(operation.target)]
      if (!builtin) return true
      if (!announced.has(operation.target)) {
        announced.add(operation.target)
        yield* Effect.log({
          msg: "configured plugin is superseded by a built-in plugin and was not loaded",
          target: operation.target,
          builtin,
          hint: `remove "${operation.target}" from the plugins list; the built-in plugin reuses the same credentials`,
        })
      }
      return false
    }),
  )
})

export * as PluginSuperseded from "./superseded.js"
