/**
 * FORK-ONLY FILE — not present upstream, so it never conflicts on rebase.
 *
 * Config-file editor for the active server's global config.
 *
 * Upstream's settings dialog can only reach two config keys (`shell` and `disabled_providers`), so
 * anything else means opening a shell on the machine. This tab edits the whole file instead, which
 * also means it never falls behind: the field reference is generated from the server's own schema, so
 * a key added upstream shows up here without any change to this file.
 *
 * Validation is a server round-trip rather than a local `JSON.parse`, because the file is `.jsonc` —
 * see `groups/fork-config.ts` for the full reasoning.
 */
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { Icon } from "@opencode-ai/ui/icon"
import { type Component, createEffect, createMemo, createResource, createSignal, For, onCleanup, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { serverName } from "@/context/server"
import { useServerSDK } from "@/context/server-sdk"
import { configFieldDocs, createForkApi } from "@/utils/fork-api"
import "./fork-config.css"

/** Long enough that typing a key does not fire a request per character. */
const VALIDATE_DEBOUNCE_MS = 400

export const SettingsForkConfigV2: Component = () => {
  const language = useLanguage()
  const platform = usePlatform()
  const serverSdk = useServerSDK()

  const api = createMemo(() => createForkApi({ server: serverSdk().server.http, fetch: platform.fetch }))

  const [file, { refetch: refetchFile }] = createResource(api, (client) => client.read())
  const [schema] = createResource(api, (client) => client.schema())

  /** Unsaved buffer. `undefined` means "showing exactly what the server last returned". */
  const [draft, setDraft] = createSignal<string | undefined>()
  const [saving, setSaving] = createSignal(false)
  const [saved, setSaved] = createSignal(false)
  const [problems, setProblems] = createSignal<string | undefined>()
  const [checking, setChecking] = createSignal(false)
  const [query, setQuery] = createSignal("")

  let editor: HTMLTextAreaElement | undefined

  const content = () => draft() ?? file()?.content ?? ""
  const dirty = () => draft() !== undefined && draft() !== (file()?.content ?? "")

  // Debounced authoritative validation. Runs on load too, so an already-broken config announces
  // itself instead of waiting for the next save attempt.
  createEffect(() => {
    const value = content()
    const client = api()
    if (file.loading) return

    setChecking(true)
    const handle = window.setTimeout(() => {
      client
        .validate(value)
        .then((result) => setProblems(result.ok ? undefined : (result.error ?? "invalid")))
        .catch((error) => setProblems(error instanceof Error ? error.message : String(error)))
        .finally(() => setChecking(false))
    }, VALIDATE_DEBOUNCE_MS)

    onCleanup(() => window.clearTimeout(handle))
  })

  const save = async () => {
    setSaving(true)
    setSaved(false)
    try {
      const result = await api().write(content())
      if (!result.ok) {
        setProblems(result.error)
        return
      }
      setProblems(undefined)
      setDraft(undefined)
      await refetchFile()
      setSaved(true)
    } catch (error) {
      setProblems(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  const revert = () => {
    setDraft(undefined)
    setSaved(false)
  }

  const reload = async () => {
    setDraft(undefined)
    setSaved(false)
    await refetchFile()
  }

  const fields = createMemo(() => configFieldDocs(schema()))
  const filtered = createMemo(() => {
    const needle = query().trim().toLowerCase()
    if (!needle) return fields()
    return fields().filter(
      (field) => field.key.toLowerCase().includes(needle) || field.description?.toLowerCase().includes(needle),
    )
  })

  /** Insert `"key": ` at the caret so the reference panel doubles as completion. */
  const insert = (key: string) => {
    const snippet = `"${key}": `
    const element = editor
    if (!element) {
      setDraft(`${content()}${snippet}`)
      return
    }
    const start = element.selectionStart ?? element.value.length
    const end = element.selectionEnd ?? start
    setDraft(`${element.value.slice(0, start)}${snippet}${element.value.slice(end)}`)
    const caret = start + snippet.length
    // After Solid flushes the new value, put the caret back where the user is now typing.
    queueMicrotask(() => {
      element.focus()
      element.setSelectionRange(caret, caret)
    })
  }

  const status = () => {
    if (saving()) return language.t("fork.config.status.saving")
    if (checking()) return language.t("fork.config.status.checking")
    if (dirty()) return language.t("fork.config.status.dirty")
    if (saved()) return language.t("fork.config.status.saved")
    if (problems()) return undefined
    return language.t("fork.config.status.valid")
  }

  return (
    <>
      {/* Same header/body split every other tab uses (see general.tsx, models.tsx) — the tab-level
          classes carry the 40px padding, title scale and sticky behaviour. */}
      <div class="settings-v2-tab-header settings-v2-tab-header--stacked">
        <h2 class="settings-v2-tab-title">{language.t("fork.config.section.title")}</h2>
        {/* Which server is being edited. Config writes go to the *active* server, same as the shell and
            provider settings — with several servers connected that is otherwise invisible. */}
        <div data-slot="fork-config-target">
          <span data-slot="fork-config-target-item">
            <span data-slot="fork-config-target-label">{language.t("fork.config.server.label")}</span>
            <span data-slot="fork-config-target-value">{serverName(serverSdk().server)}</span>
          </span>
          <Show when={file()}>
            {(loaded) => (
              <span data-slot="fork-config-target-item">
                <span data-slot="fork-config-target-label">{language.t("fork.config.file.label")}</span>
                <code data-slot="fork-config-target-value">{loaded().path}</code>
              </span>
            )}
          </Show>
        </div>
      </div>

      <div class="settings-v2-tab-body" data-component="fork-config">
        <p data-slot="fork-config-description">{language.t("fork.config.section.description")}</p>

        <div data-slot="fork-config-body">
          <div data-slot="fork-config-editor">
            <textarea
              ref={(element) => (editor = element)}
              aria-label={language.t("fork.config.editor.label")}
              spellcheck={false}
              autocapitalize="off"
              autocomplete="off"
              data-invalid={problems() ? "true" : undefined}
              disabled={file.loading}
              value={content()}
              onInput={(event) => {
                setSaved(false)
                setDraft(event.currentTarget.value)
              }}
            />

            {/* Problems sit above the action row so the buttons are always the bottom-most element of
                the column and never shift position as errors appear and clear. */}
            <Show when={problems()}>
              {(message) => (
                <div data-slot="fork-config-problems">
                  <div data-slot="fork-config-problems-title">{language.t("fork.config.problems.title")}</div>
                  <pre>{message()}</pre>
                </div>
              )}
            </Show>

            <div data-slot="fork-config-actions">
              <div data-slot="fork-config-status" data-state={problems() ? "error" : "ok"}>
                <Show when={status()}>{(text) => <span>{text()}</span>}</Show>
              </div>
              <ButtonV2 size="small" variant="ghost" onClick={() => void reload()} disabled={saving()}>
                {language.t("fork.config.action.reload")}
              </ButtonV2>
              <ButtonV2 size="small" variant="ghost-muted" onClick={revert} disabled={!dirty() || saving()}>
                {language.t("fork.config.action.revert")}
              </ButtonV2>
              <ButtonV2
                size="small"
                onClick={() => void save()}
                // Blocked while invalid: the server would refuse anyway, and a disabled button is a
                // clearer signal than a rejected request.
                disabled={!dirty() || saving() || checking() || !!problems()}
              >
                {language.t("fork.config.action.save")}
              </ButtonV2>
            </div>
          </div>

          <div data-slot="fork-config-reference">
            <div data-slot="fork-config-reference-header">
              <span data-slot="fork-config-reference-title">{language.t("fork.config.reference.title")}</span>
              <Show when={fields().length}>
                <span data-slot="fork-config-reference-count">
                  {language.t("fork.config.reference.count", { shown: filtered().length, total: fields().length })}
                </span>
              </Show>
            </div>

            <TextInputV2
              appearance="base"
              leadingIcon={<Icon name="magnifying-glass" />}
              placeholder={language.t("fork.config.reference.search")}
              value={query()}
              showClearButton={!!query()}
              onClearClick={() => setQuery("")}
              onInput={(event) => setQuery(event.currentTarget.value)}
            />

            <div data-slot="fork-config-reference-list">
              <For
                each={filtered()}
                fallback={
                  <div data-slot="fork-config-reference-empty">{language.t("fork.config.reference.empty")}</div>
                }
              >
                {(field) => (
                  <button
                    type="button"
                    data-slot="fork-config-reference-item"
                    title={language.t("fork.config.reference.insert")}
                    onClick={() => insert(field.key)}
                  >
                    {/* Key and type share one line, type ellipsised with the full value on hover —
                        several types (`record<string, AgentConfig> | null`) are long enough to wrap to
                        three lines otherwise and the list becomes unreadable. */}
                    <span data-slot="fork-config-reference-row">
                      <span data-slot="fork-config-reference-key">{field.key}</span>
                      <span data-slot="fork-config-reference-type" title={field.type}>
                        {field.type}
                      </span>
                    </span>
                    <Show when={field.description}>
                      {(description) => <span data-slot="fork-config-reference-doc">{description()}</span>}
                    </Show>
                  </button>
                )}
              </For>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
