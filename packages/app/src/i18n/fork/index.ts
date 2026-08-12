/**
 * Fork-local i18n dictionaries.
 *
 * Why this exists: adding keys directly to `@/i18n/en.ts` and `@/i18n/zh.ts` would mean editing two
 * files upstream touches constantly, producing a rebase conflict on every release. Keeping fork copy
 * in its own directory means the only upstream file involved is `@/context/language.tsx`, where two
 * one-line seams pull these dictionaries in. See FORK.md.
 *
 * Fork dictionaries are tiny and always needed, so they are imported eagerly rather than
 * code-split per locale like the upstream dictionaries.
 */
import type { DesktopNativeLocale } from "../desktop-native"
import { dict as en } from "./en"
import { dict as zh } from "./zh"

export { dict as forkEn } from "./en"

const overlays: Partial<Record<DesktopNativeLocale, Record<string, string>>> = { en, zh }

/**
 * Fork copy for one locale, to be layered on top of that locale's upstream dictionary.
 *
 * Returns `{}` for locales with no fork translation — those fall through to the fork English keys,
 * which are already part of the English base every locale dictionary is built on.
 */
export function forkOverlay(locale: DesktopNativeLocale): Record<string, string> {
  return overlays[locale] ?? {}
}
