/**
 * Typed builders — how a NATIVE page authors its spec.
 *
 * A native page does not write JSON. It calls these helpers, which are
 * ordinary typed functions, so the compiler catches a bad block kind, a
 * missing required prop, or a drill wrapping a drill before the page ever
 * renders. The output is nonetheless plain serializable data, so the same
 * spec can be persisted, diffed against a tenant override, handed to an agent
 * to patch, or validated by `validateSpec` — the JSON path and the TypeScript
 * path produce identical structures by construction.
 *
 * `ref<T>()` is the one place a page names loader output. Parameterising it by
 * the loader's own data type means a typo in a field path is a compile error
 * on native pages, while tenant specs get the same guarantee at runtime from
 * the renderer's field resolution.
 */

import type {
  BadgeCell,
  Block,
  CellSpec,
  Column,
  DateCell,
  DrillCell,
  TxnCell,
  WidgetCell,
  TableSpanRow,
  FieldRef,
  FilterBarBlock,
  FilterBarControls,
  LeafCell,
  LinkCell,
  MoneyCell,
  NumberCell,
  PageHeaderBlock,
  PageSpec,
  PaginationBlock,
  PaperBlock,
  RecordLinkCell,
  SummaryLineBlock,
  TableBlock,
  TextBlock,
  TextCell,
  ToggleLinkGroup,
  Tone,
  Value,
  WidgetBlock,
  WidgetRef,
  FrameBlock,
  GridBlock,
  PanelBlock,
  StatTileBlock,
  RepeatBlock,
  HeadingBlock,
} from './types.ts'
import { SPEC_VERSION } from './types.ts'

/**
 * Name a field on the loader output. Typed against the loader's shape so a
 * native page cannot reference a field that does not exist.
 *
 *   const f = ref<PartnersData>()
 *   f('rows')            // ok
 *   f('rowz')            // compile error
 *
 * Nested paths stay strings (`'totals.balance'`) — the depth is not tracked by
 * the type, only the root key, which catches the mistakes that actually happen.
 */
export function ref<T>(): <K extends Extract<keyof T, string>>(path: K | `${K}.${string}`) => FieldRef {
  return (path) => ({ $: path })
}

/** An untyped field reference, for row scopes whose shape the page knows. */
export function field(path: string): FieldRef {
  return { $: path }
}

/**
 * Reference page-level data from inside a row scope.
 *
 * Table cells resolve against their row, but a cell often needs a page-level
 * constant — a column's shared placeholder text, a currency label. Copying
 * that constant onto every row would work and would be wasteful; instead the
 * renderer exposes the page scope at `$root`.
 *
 * This is deliberately the ONLY scope escape, and it always resolves to the
 * PAGE — not "one level up". Nesting preserves it, so the same reference means
 * the same thing at any depth. It is a fixed name, not a traversal operator:
 * it adds one reachable object rather than a way to walk arbitrary scopes.
 *
 * Safe to use at page level too, so a table can be moved into or out of a
 * `repeat` without rewriting its headers.
 */
export function rootRef<T>(): <K extends Extract<keyof T, string>>(path: K | `${K}.${string}`) => FieldRef {
  return (path) => ({ $: `${ROOT_SCOPE_KEY}.${path}` })
}

export const ROOT_SCOPE_KEY = '$root'

/* ----------------------------- cell renderers ----------------------------- */

export function text(
  f: FieldRef,
  opts: {
    fallback?: Value
    tone?: Value<Tone>
    numeric?: boolean
    prefix?: TextCell['prefix']
    suffix?: TextCell['suffix']
    fallbackClassName?: string
  } = {},
): TextCell {
  return { kind: 'text', field: f, ...opts }
}

export function money(f: FieldRef, opts: { tone?: Value<Tone> } = {}): MoneyCell {
  return { kind: 'money', field: f, ...opts }
}

export function number(f: FieldRef, opts: { tone?: Value<Tone> } = {}): NumberCell {
  return { kind: 'number', field: f, ...opts }
}

export function date(f: FieldRef): DateCell {
  return { kind: 'date', field: f }
}

export function badge(f: FieldRef, opts: { variant?: BadgeCell['variant'] } = {}): BadgeCell {
  return { kind: 'badge', field: f, ...opts }
}

export function link(f: FieldRef, href: FieldRef, className?: string): LinkCell {
  return { kind: 'link', field: f, href, ...(className ? { className } : {}) }
}

export function recordLink(f: FieldRef, recordType: Value, id: FieldRef): RecordLinkCell {
  return { kind: 'record-link', field: f, recordType, id }
}

/** Wrap a leaf cell in a report drill-down link. Cannot nest — the parameter
 *  type is `LeafCell`, so `drill(drill(...))` is a compile error. */
export function drill(target: FieldRef, inner: LeafCell): DrillCell {
  return { kind: 'drill', target, inner }
}

/** Wrap a leaf cell in a transaction drawer link. Cannot nest, like `drill`. */
export function txn(target: FieldRef, inner: LeafCell): TxnCell {
  return { kind: 'txn', target, inner }
}

/* --------------------------------- widgets -------------------------------- */

export function widget(name: string, props?: Record<string, unknown>, when?: FieldRef): WidgetRef {
  return { widget: name, ...(props ? { props } : {}), ...(when ? { when } : {}) }
}

/* --------------------------------- blocks --------------------------------- */

export function pageHeader(spec: Omit<PageHeaderBlock, 'kind'>): PageHeaderBlock {
  return { kind: 'page-header', ...spec }
}

export function filterBar(
  controls: FilterBarControls,
  opts: Omit<FilterBarBlock, 'kind' | 'controls'> = {},
): FilterBarBlock {
  return { kind: 'filter-bar', controls, ...opts }
}

/**
 * Place a host-registered domain component.
 *
 * Not every table should be decomposed into `table` blocks. A component like
 * the statement matrix owns real presentation logic — variance percentages,
 * scale divisors, hierarchical lines, its own drill construction — and
 * re-expressing that as generic columns would reimplement it badly rather than
 * compose it. ViewSpec's job is page composition, so complex domain components
 * stay whole and are placed by name, exactly as interactive widgets are.
 */
export function widgetBlock(name: string, props?: Record<string, unknown>, when?: FieldRef): WidgetBlock {
  return { kind: 'widget', widget: name, ...(props ? { props } : {}), ...(when ? { when } : {}) }
}

export function toggleLinks(links: ToggleLinkGroup['links']): ToggleLinkGroup {
  return { kind: 'toggle-links', links }
}

export function summaryLine(label: Value, value: CellSpec): SummaryLineBlock {
  return { kind: 'summary-line', label, value }
}

export function paper(spec: Omit<PaperBlock, 'kind'>): PaperBlock {
  return { kind: 'paper', ...spec }
}

/** A host-registered component rendered inside a cell. */
export function widgetCell(name: string, props?: Record<string, unknown>): WidgetCell {
  return { kind: 'widget', widget: name, ...(props ? { props } : {}) }
}

export function spanRow(spec: TableSpanRow): TableSpanRow {
  return spec
}

export function column(header: Value, cell: CellSpec, opts: Omit<Column, 'header' | 'cell'> = {}): Column {
  return { header, cell, ...opts }
}

export function table(spec: Omit<TableBlock, 'kind'>): TableBlock {
  return { kind: 'table', ...spec }
}

export function pagination(spec: Omit<PaginationBlock, 'kind'>): PaginationBlock {
  return { kind: 'pagination', ...spec }
}

export function textBlock(
  content: Value,
  opts: { size?: TextBlock['size']; tone?: Value<Tone>; className?: string; when?: FieldRef } = {},
): TextBlock {
  return { kind: 'text', content, ...opts }
}

export function grid(
  className: string | undefined,
  blocks: Block[],
  opts: { as?: GridBlock['as'] } = {},
): GridBlock {
  return { kind: 'grid', ...(className ? { className } : {}), ...opts, blocks }
}

/** A host wrapper component around spec-authored children. */
export function frame(
  name: string,
  blocks: Block[],
  props?: Record<string, unknown>,
): FrameBlock {
  return { kind: 'frame', frame: name, ...(props ? { props } : {}), blocks }
}

export function heading(level: 2 | 3, content: Value, className?: string): HeadingBlock {
  return { kind: 'heading', level, content, ...(className ? { className } : {}) }
}

export function panel(spec: Omit<PanelBlock, 'kind'>): PanelBlock {
  return { kind: 'panel', ...spec }
}

export function statTile(spec: Omit<StatTileBlock, 'kind'>): StatTileBlock {
  return { kind: 'stat-tile', ...spec }
}

export function repeat(spec: Omit<RepeatBlock, 'kind'>): RepeatBlock {
  return { kind: 'repeat', ...spec }
}

/* ---------------------------------- page ---------------------------------- */

export function page(spec: {
  layout?: PageSpec['layout']
  bodyClassName?: string
  header?: Block[]
  body: Block[]
}): PageSpec {
  return {
    specVersion: SPEC_VERSION,
    layout: spec.layout ?? 'list',
    ...(spec.bodyClassName ? { bodyClassName: spec.bodyClassName } : {}),
    header: spec.header ?? [],
    body: spec.body,
  }
}
