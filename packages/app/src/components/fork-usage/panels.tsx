/**
 * FORK-ONLY FILE — not present upstream, so it never conflicts on rebase.
 *
 * The dashboard's two non-timeline views: a ranked bar list, and the session tree.
 *
 * Both are plain elements rather than SVG. Their geometry is one number per row — a width percentage — so
 * HTML carries it exactly, wraps text properly, and keeps the labels selectable and screen-reader legible,
 * none of which SVG would give for free. The area chart and heatmap are SVG because they have real geometry.
 */
import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js"
import { Dynamic } from "solid-js/web"
import { Icon } from "@opencode-ai/ui/v2/icon"
import type { UsageRow } from "@/utils/fork-api"
import { visibleNodes, type ReadoutEntry, type TreeNode } from "./usage-model"
import { segmentOpacity } from "./charts"
import "./panels.css"

export type BarRow = {
  key: string
  label: string
  value: number
  /**
   * The same row counted the other ways that explain the cost — requests, input, output, cache share.
   *
   * Cost alone does not say why: the same dollar is either one expensive round trip or a thousand cheap ones,
   * and on real data the model with fewer requests cost more than twice the one with more. Passed already
   * formatted, because the numbers need a locale and the labels need translating, and both live upstream of
   * this component.
   */
  facts: Array<{ label: string; value: string }>
}

/**
 * Ranked bars, scaled to the largest row rather than to the total.
 *
 * Scaling to the total is the instinct and it is wrong here: spend is extremely concentrated — one project
 * held 85% of a whole history — so every other row would collapse to a sliver and the ranking below the
 * leader would be unreadable. Against the leader, second place is still legible.
 */
export function UsageBars(props: { rows: BarRow[]; formatValue: (value: number) => string; emptyLabel: string }) {
  const peak = () => Math.max(0, ...props.rows.map((row) => row.value))
  const width = (value: number) => {
    const top = peak()
    if (top <= 0) return 0
    // A floor of 1.5% so a real-but-tiny row is still a visible mark rather than nothing at all.
    return Math.max(1.5, (value / top) * 100)
  }

  return (
    <Show
      when={props.rows.length > 0}
      fallback={
        <p data-slot="fork-usage-empty" role="status">
          {props.emptyLabel}
        </p>
      }
    >
      <ul data-component="fork-usage-bars">
        <For each={props.rows}>
          {(row) => (
            <li data-slot="fork-usage-bar-row">
              <div data-slot="fork-usage-bar-head">
                <span data-slot="fork-usage-bar-label" title={row.label}>
                  {row.label}
                </span>
                <span data-slot="fork-usage-bar-value">{props.formatValue(row.value)}</span>
              </div>
              <div data-slot="fork-usage-bar-track">
                <div data-slot="fork-usage-bar-fill" style={{ width: `${width(row.value)}%` }} />
              </div>
              <dl data-slot="fork-usage-bar-note">
                <For each={row.facts}>
                  {(fact) => (
                    <div data-slot="fork-usage-fact">
                      <dd>{fact.value}</dd>
                      <dt>{fact.label}</dt>
                    </div>
                  )}
                </For>
              </dl>
            </li>
          )}
        </For>
      </ul>
    </Show>
  )
}

/**
 * Project → session → sub-agent, as indented bars on one shared scale.
 *
 * A flame graph for money, and the reason the dashboard has no "include sub-sessions" switch: the shape it
 * shows is the characteristic thing about spend in an agent runtime. On real data a single instruction fanned
 * out into twelve sub-agents and $174 of a $204 history — a fact a flat session list cannot express, and a
 * toggle between two totals can only hint at.
 *
 * One scale across all depths, so a child's bar is directly comparable to its parent's and to any other
 * project's. Scaling each level to its own parent would make every sub-agent look large.
 */
export function UsageTree(props: {
  nodes: TreeNode[]
  formatValue: (value: number) => string
  formatRequests: (value: number) => string
  /**
   * Start with every level open. Used by the session view, where the tree is the subject rather than the detail.
   *
   * Not the same as removing the controls, which is what an earlier version did: the component then behaved
   * differently in the two places it appears, so a cascade learned in one did not exist in the other. Defaulting
   * open shows everything immediately *and* still folds.
   */
  defaultOpen?: boolean
  emptyLabel: string
}) {
  const [opened, setOpened] = createSignal(new Set<string>())

  /**
   * Seeds the open set when `defaultOpen` is on, once per set of nodes.
   *
   * Keyed on the node keys rather than run once at creation, because the rows arrive asynchronously and change
   * with the range: seeding at creation would find nothing to open. Re-seeding on a new data set means a range
   * switch starts open again, and a fold made *within* one data set survives every re-render of it.
   */
  createEffect(
    on(
      () => props.nodes.map((node) => node.key).join("\u0000"),
      () => {
        if (props.defaultOpen !== true) return
        setOpened(new Set(props.nodes.filter((node) => node.hasChildren).map((node) => node.key)))
      },
    ),
  )

  const isOpen = (key: string) => opened().has(key)
  const interactive = (node: TreeNode) => node.hasChildren
  const toggle = (key: string) => {
    const next = new Set(opened())
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setOpened(next)
  }

  /**
   * A row shows when everything above it is open.
   *
   * Projects always show; a session needs its project open, a sub-agent needs its session open. Cascading
   * rather than one switch for the whole tree, because the useful move is "open the project that cost the
   * most, then the run inside it" — expanding forty sessions to find one is not that.
   */
  const visible = createMemo(() => visibleNodes(props.nodes, isOpen))

  const peak = () => Math.max(0, ...props.nodes.map((node) => node.cost))
  const width = (value: number) => {
    const top = peak()
    if (top <= 0) return 0
    return Math.max(1.5, (value / top) * 100)
  }

  return (
    <Show
      when={props.nodes.length > 0}
      fallback={
        <p data-slot="fork-usage-empty" role="status">
          {props.emptyLabel}
        </p>
      }
    >
      <ul data-component="fork-usage-tree">
        <For each={visible()}>
          {(node) => (
            <li data-slot="fork-usage-tree-row" data-kind={node.kind} data-depth={node.depth}>
              {/*
                The whole head is the control when there is something to open, not just the caret — a 14px
                target beside a readable label is a worse thing to aim at than the label itself. A real
                <button> rather than a click handler on the div, so it is keyboard-reachable and announces its
                expanded state without any extra wiring.
              */}
              <Dynamic
                component={interactive(node) ? "button" : "div"}
                data-slot="fork-usage-tree-head"
                data-interactive={interactive(node) ? "" : undefined}
                {...(interactive(node)
                  ? { type: "button" as const, "aria-expanded": isOpen(node.key), onClick: () => toggle(node.key) }
                  : {})}
              >
                <Show when={interactive(node)} fallback={<span data-slot="fork-usage-tree-spacer" />}>
                  <span data-slot="fork-usage-tree-caret" aria-hidden="true">
                    <Icon name="chevron-down" size="small" />
                  </span>
                </Show>
                <span data-slot="fork-usage-tree-label" title={node.label}>
                  {node.label}
                </span>
                <Show when={node.agent}>
                  <span data-slot="fork-usage-tree-agent">{node.agent}</span>
                </Show>
                <span data-slot="fork-usage-tree-requests">{props.formatRequests(node.requests)}</span>
                <span data-slot="fork-usage-tree-value">{props.formatValue(node.cost)}</span>
              </Dynamic>
              <div data-slot="fork-usage-tree-track">
                <div data-slot="fork-usage-tree-fill" style={{ width: `${width(node.cost)}%` }} />
              </div>
            </li>
          )}
        </For>
      </ul>
    </Show>
  )
}

/**
 * The figures behind the chart, for the whole range or for one inspected column.
 *
 * Below the plot rather than following the pointer: a panel that tracks the cursor covers the bars it
 * describes, has to flip sides near the right edge, and moves while being read. A table rather than a line of
 * figures: a run of values wrapped as soon as there were four models, and every model added makes it worse.
 *
 * The rows are the range's series, so inspecting a column changes the numbers and never the layout — and with
 * nothing inspected the table earns its space by showing the range totals instead of sitting blank.
 */
export function UsageReadout(props: {
  /** What the figures describe: a bucket label while inspecting, otherwise the range. */
  caption: string
  total: UsageRow
  rows: ReadoutEntry[]
  columns: Array<{ label: string; of: (row: UsageRow) => string }>
}) {
  return (
    <table data-component="fork-usage-readout">
      <thead>
        <tr>
          <th data-slot="fork-usage-readout-caption">{props.caption}</th>
          <For each={props.columns}>{(column) => <th>{column.of(props.total)}</th>}</For>
        </tr>
        <tr data-slot="fork-usage-readout-units">
          <td />
          <For each={props.columns}>{(column) => <td>{column.label}</td>}</For>
        </tr>
      </thead>
      <tbody>
        <For each={props.rows}>
          {(entry) => (
            <tr data-idle={entry.idle ? "" : undefined}>
              <td data-slot="fork-usage-readout-name">
                <span data-slot="fork-usage-swatch" style={{ opacity: String(segmentOpacity(entry.order)) }} />
                <span data-slot="fork-usage-readout-label">{entry.label}</span>
              </td>
              <For each={props.columns}>{(column) => <td>{column.of(entry.row)}</td>}</For>
            </tr>
          )}
        </For>
      </tbody>
    </table>
  )
}
