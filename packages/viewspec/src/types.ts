/**
 * ViewSpec — the declarative page-composition language.
 *
 * The contract that makes this safe, and the one rule to defend:
 *
 *   THE LOADER COMPUTES. THE SPEC BINDS.
 *
 * A page's server loader stays ordinary TypeScript: permissions, queries,
 * i18n, formatting, derived flags. It emits a presentation-ready `ViewData`.
 * The spec then only *names* which block renders where and which already-
 * resolved field it reads. A spec can reference a field; it can never compute
 * one. That is what keeps ViewSpec from degenerating into a scripting language
 * — the failure mode that would destroy the security model, because an
 * expression evaluator in the render path is an escape hatch out of the block
 * registry.
 *
 * Consequences worth stating explicitly:
 *   - No conditionals, arithmetic, string building, or function values here.
 *     Precompute in the loader and bind the result.
 *   - Every block kind and cell renderer is a CLOSED union. A spec that names
 *     something outside it fails validation rather than rendering unknown
 *     markup. Extending the language is a deliberate, reviewed act.
 *   - `specVersion` is public API from day one; removing a block kind or
 *     renderer is a breaking change forever.
 *
 * The block and renderer vocabulary below is not invented — it was measured
 * from the 178 existing pages (raw `TableCell` 265, `TxnLink` 11,
 * `ReportDrillLink` 9, `Badge` 5, money formatters 5, …), so v1 covers what
 * the app demonstrably already does rather than what might be wanted later.
 */

export const SPEC_VERSION = 1 as const

/**
 * A reference to a field on the loader's output. The ONLY indirection the
 * language has. `path` is a dot path resolved against the current scope (the
 * page's `ViewData`, or the current row inside a table body).
 */
export interface FieldRef {
  $: string
}

/** A literal or a field reference. Literals are for static chrome (labels). */
export type Value<T = string> = T | FieldRef

export function isFieldRef(value: unknown): value is FieldRef {
  return typeof value === 'object' && value !== null && typeof (value as FieldRef).$ === 'string'
}

/* -------------------------------------------------------------------------- */
/* Cell renderers — the closed set of ways a table cell may present a value.   */
/* -------------------------------------------------------------------------- */

export type Align = 'left' | 'right' | 'center'

/** Tone is a NAMED presentation state the loader decides, never a comparison
 *  the spec performs. `negative` renders the red treatment used across
 *  statements; `muted`/`strong` map to the existing slate ramps. */
export type Tone = 'default' | 'negative' | 'positive' | 'warning' | 'muted' | 'strong'

export interface TextCell {
  kind: 'text'
  field: FieldRef
  /** Rendered when the field is null/undefined/''. Italic subtle treatment. */
  fallback?: Value
  /** Override the fallback's class (aging uses a dimmer em-dash placeholder). */
  fallbackClassName?: string
  tone?: Value<Tone>
  /** Render as monospace tabular figures (the `tabular-nums` treatment). */
  numeric?: boolean
  /**
   * A second value rendered before the main one in its own span — the
   * "account number then account name" idiom several report tables use. Two
   * fields with different treatment in one cell is common enough to name;
   * without it those cells would each need a bespoke widget.
   */
  prefix?: { field: FieldRef; className?: string }
  /** Symmetric to `prefix`; the trailing "· email" idiom on owner cells. */
  suffix?: { field: FieldRef; className?: string }
}

/** Money and number cells expect the loader to have ALREADY formatted the
 *  string (currency, scale, locale). They add only alignment and tone. */
export interface MoneyCell {
  kind: 'money'
  field: FieldRef
  tone?: Value<Tone>
}

export interface NumberCell {
  kind: 'number'
  field: FieldRef
  tone?: Value<Tone>
}

export interface DateCell {
  kind: 'date'
  field: FieldRef
}

export interface BadgeCell {
  kind: 'badge'
  field: FieldRef
  variant?: Value<'default' | 'secondary' | 'outline' | 'destructive' | 'warning' | 'success'>
}

/** An ordinary link. `href` is resolved by the loader, not built by the spec. */
export interface LinkCell {
  kind: 'link'
  field: FieldRef
  href: FieldRef
  className?: string
}

/**
 * A record link into a host-registered target (documents, parties, projects).
 * The host resolves `target` → route via the nav registry's recordTarget
 * contract, so specs never hardcode routes.
 */
export interface RecordLinkCell {
  kind: 'record-link'
  field: FieldRef
  recordType: Value
  id: FieldRef
}

/**
 * Wrapper: renders `inner` inside a report drill-down link. The drill target
 * itself is an opaque object the loader built — the spec only says which field
 * carries it. This is how the statement/report pages compose today.
 */
export interface DrillCell {
  kind: 'drill'
  target: FieldRef
  inner: LeafCell
}

export type LeafCell =
  | TextCell
  | MoneyCell
  | NumberCell
  | DateCell
  | BadgeCell
  | LinkCell
  | RecordLinkCell

/**
 * Wrapper: renders `inner` inside a transaction drawer link.
 *
 * Sibling of `drill`. The target ({entryId, docKind, docId}) is built by the
 * loader and denormalized onto whatever row the cell sits in — deliberately,
 * rather than reaching up to a parent scope. A nested table inside a `repeat`
 * would otherwise need scope traversal to find its group's identity, and
 * "precompute in the loader" is the cheaper answer that keeps the language
 * from needing one.
 */
export interface TxnCell {
  kind: 'txn'
  target: FieldRef
  inner: LeafCell
}

/**
 * A host-registered component rendered inside a cell.
 *
 * The same escape valve the `widget` block provides, at cell granularity: some
 * cells hold a small composite (an entry link beside a document-type badge)
 * that is a component, not a value. Props may be field refs, resolved against
 * the row exactly as a widget block's are.
 */
export interface WidgetCell {
  kind: 'widget'
  widget: string
  props?: Record<string, unknown>
}

export type CellSpec = LeafCell | DrillCell | TxnCell | WidgetCell

export const LEAF_CELL_KINDS = [
  'text',
  'money',
  'number',
  'date',
  'badge',
  'link',
  'record-link',
] as const

export const CELL_KINDS = [...LEAF_CELL_KINDS, 'drill', 'txn', 'widget'] as const

/* -------------------------------------------------------------------------- */
/* Widgets — host-registered interactive components a spec may place.          */
/* -------------------------------------------------------------------------- */

/**
 * Slots (filter-bar actions, header actions) take arbitrary JSX in the native
 * pages today. A spec cannot express JSX, so it names a widget from the host
 * registry instead. The registry is closed and each entry is permission-aware
 * on the host side, so placing a widget can never grant capability a spec
 * author lacks.
 */
export interface WidgetRef {
  widget: string
  /**
   * Props may be literals OR field references, resolved against the CURRENT
   * scope. That matters inside `repeat`: a widget rendered per item has to read
   * that item, and baking literals in at spec-build time only works at page
   * level. Resolution is one level deep and is still just a field lookup — no
   * new power, the same indirection every other block uses.
   */
  props?: Record<string, unknown>
  /** Omit the widget entirely when this loader-resolved flag is false. */
  when?: FieldRef
}

/* -------------------------------------------------------------------------- */
/* Blocks                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Every block may carry `when`: a loader-resolved flag that omits the block
 * entirely when falsy.
 *
 * This is presence, not branching. A page showing one of two tables gives the
 * loader TWO independent flags (`isDetail`, `isSummary`) rather than the spec
 * gaining a negation — which keeps the language free of an operator that would
 * make the argument against arithmetic and comparisons much weaker.
 */
export interface BlockCommon {
  when?: FieldRef
}

export interface PageHeaderBlock extends BlockCommon {
  kind: 'page-header'
  title: Value
  description?: Value
  back?: { href: Value; label: Value }
  actions?: WidgetRef[]
  /**
   * Wrapper class for the actions slot. Pages that place more than one control
   * there wrap them in a flex row; without this the widgets render as bare
   * siblings and the layout differs from the native page.
   */
  actionsClassName?: string
}

/** Which controls the shared report filter bar shows. Mirrors its real props. */
export interface FilterBarControls {
  search?: boolean
  period?: boolean
  /** Always-visible explicit From/To fields rather than the period preset. */
  dateRange?: boolean
  /** Balance-style: custom period collapses to a single "as of" date. */
  asOf?: boolean
  breakout?: boolean
  compare?: boolean
  basis?: boolean
  dimensions?: boolean
  subsidiary?: boolean
  showZero?: boolean
  scale?: boolean
  sections?: boolean
}

export interface FilterBarBlock extends BlockCommon {
  kind: 'filter-bar'
  controls: FilterBarControls
  searchPlaceholder?: Value
  /** Toggle chips rendered before the controls (the payable/receivable idiom). */
  leading?: ToggleLinkGroup
  actions?: WidgetRef[]
  /**
   * Loader-resolved inputs, named ONE BY ONE rather than a single object the
   * renderer spreads. A spread would let a spec set any prop on the underlying
   * component — including ones the block was never meant to expose — which is
   * precisely the escape hatch the closed vocabulary exists to prevent. Each
   * field below is passed to exactly one known prop.
   */
  dimensions?: FieldRef
  subsidiaries?: FieldRef
  customers?: FieldRef
  dateRange?: FieldRef
  primaryFilter?: FieldRef
  periodPresets?: FieldRef
  defaultPeriod?: Value
}

export interface ToggleLinkGroup {
  kind: 'toggle-links'
  links: Array<{ href: Value; label: Value; activeWhen: FieldRef }>
  /** Render the standard hairline separator after the links. */
  divider?: boolean
}

/** A one-line summary above the content ("Total outstanding: $X"). */
export interface SummaryLineBlock extends BlockCommon {
  kind: 'summary-line'
  label: Value
  value: CellSpec
}

/** The printable report sheet wrapper. */
export interface PaperBlock extends BlockCommon {
  kind: 'paper'
  company?: Value
  title: Value
  periodPhrase?: Value
  note?: Value
  wide?: Value<boolean>
  blocks: Block[]
}

export interface Column {
  header: Value
  align?: Align
  cell: CellSpec
  /** Sort key; presence renders the sortable header control. */
  sort?: string
  /** Applied to body cells. */
  className?: string
  /** Applied to the header cell — column widths live here, not on the body. */
  headerClassName?: string
}

/**
 * A row whose first cell spans several columns: the opening/closing balances
 * and totals that accounting tables put above and below their lines.
 *
 * Named rather than left to a bespoke widget because it is an idiom, not a
 * one-off — ledgers, registers, aging and trial balance all use it. These rows
 * resolve against the TABLE's scope, not a row scope, since they summarise the
 * whole table rather than belonging to its collection.
 */
export interface TableSpanRow {
  label: Value
  /** 1 renders a plain cell with no colspan attribute, matching a normal row. */
  labelColSpan: number
  labelClassName?: string
  className?: string
  cells: Array<{ cell: CellSpec; align?: Align; className?: string }>
}

/**
 * Which table primitives render the block. The app has two genuinely
 * different tables and conflating them would lose pixel parity: `report`
 * primitives carry statement typography with no card, hover, or row dividers;
 * `app` primitives are the list-page table with card chrome and hover states.
 */
export type TableVariant = 'report' | 'app'

/**
 * Sortable-header configuration for a table.
 *
 * Columns opt in individually via `Column.sort`; this supplies the shared
 * inputs the sort links need. Present as a first-class concern because
 * sortable headers appear on ~39 list pages — too common to leave to a widget.
 */
export interface TableSorting {
  basePath: Value
  /** The active sort column and direction, resolved by the loader. */
  sort: FieldRef
  dir: FieldRef
}

export interface TableBlock extends BlockCommon {
  kind: 'table'
  variant?: TableVariant
  sorting?: TableSorting
  /** Rows rendered before the collection (opening balances). */
  leading?: TableSpanRow[]
  /** Rows rendered after it (closing balances, totals). */
  trailing?: TableSpanRow[]
  /** Field on ViewData holding the row array. Each row becomes the cell scope. */
  rows: FieldRef
  /** Stable React key per row. */
  rowKey: FieldRef
  columns: Column[]
  /** Replaces the whole table when the collection is empty. */
  empty?: { title: Value; description?: Value }
  /**
   * Alternative empty treatment: a single spanning row INSIDE the table, so
   * the column headers stay visible. Several admin lists prefer this to the
   * table vanishing. When both are set, this wins.
   */
  emptyRow?: { text: Value; colSpan: number; className?: string }
}

export interface PaginationBlock extends BlockCommon {
  kind: 'pagination'
  basePath: Value
  total: FieldRef
  page: FieldRef
  perPage: FieldRef
  /**
   * Most list pages wrap the pager in a `mt-3` spacer; a few place it flush.
   * Rendering the spacer unconditionally would be markup those pages lack.
   */
  bare?: boolean
}

export interface TextBlock {
  kind: 'text'
  content: Value
  tone?: Value<Tone>
  /** Spacing and other presentational extras, appended after the tone. */
  className?: string
  /** Omit the block entirely when this loader-resolved flag is false. */
  when?: FieldRef
}

/**
 * Layout containers.
 *
 * `className` is a deliberate, bounded concession. Cockpit pages use bespoke
 * responsive grids (`grid-cols-2 sm:grid-cols-3 lg:grid-cols-5`), and encoding
 * every such arrangement as a named layout would grow the vocabulary one page
 * at a time without ever converging. A class string is presentational only: it
 * cannot execute, cannot reach data, and cannot mount a component. It is also
 * naturally bounded — Tailwind compiles a fixed set of utilities, so a spec can
 * only name classes the bundle already contains and cannot invent new CSS.
 */
export interface GridBlock extends BlockCommon {
  kind: 'grid'
  className?: string
  blocks: Block[]
}

export interface PanelBlock extends BlockCommon {
  kind: 'panel'
  title: Value
  iconKey?: Value
  hint?: Value
  className?: string
  bodyClassName?: string
  blocks: Block[]
}

/** A compact metric tile. Values arrive already formatted by the loader. */
export interface StatTileBlock {
  kind: 'stat-tile'
  iconKey: Value
  accent: Value
  label: Value
  value: Value
  sub?: Value
  tone?: Value<'default' | 'positive' | 'warning' | 'negative'>
  when?: FieldRef
}

/**
 * Render a block subtree once per item in a loader-provided collection.
 *
 * This is the same iteration `table` already performs over its rows, lifted to
 * arbitrary blocks — the journal groups entries, each with its own heading and
 * line table. It adds no new power: the collection comes from the loader, the
 * subtree is fixed, and each item becomes the scope exactly as a table row
 * does, with the page still reachable at `$root`.
 *
 * `empty` exists so a page can show "nothing here" without the language
 * needing a negated conditional — the same reason `table` has one.
 *
 * Scope note: blocks inside a repeat resolve against the ITEM, so page-level
 * values must go through `$root`. `$root` always means the PAGE at any depth —
 * nesting preserves it rather than re-pointing it — so a table's headers
 * resolve the same whether or not the table sits inside a repeat.
 */
export interface RepeatBlock extends BlockCommon {
  kind: 'repeat'
  items: FieldRef
  itemKey: FieldRef
  /** Wrapper around the whole list (spacing between groups). */
  className?: string
  /** Wrapper around each rendered item. */
  itemClassName?: string
  blocks: Block[]
  empty?: { text: Value; className?: string }
}

/**
 * A host-registered domain component placed as a block.
 *
 * The escape valve for components that own real presentation logic — the
 * statement matrix, a trend chart, a live directory. Decomposing those into
 * generic blocks would reimplement them badly; ViewSpec composes pages, it
 * does not re-derive components. Still closed: the widget name must exist in
 * the host registry, and `props` reach exactly one known component.
 */
export interface WidgetBlock {
  kind: 'widget'
  widget: string
  props?: Record<string, unknown>
  /** Omit the block entirely when this loader-resolved flag is false. */
  when?: FieldRef
}

export type Block =
  | PageHeaderBlock
  | FilterBarBlock
  | SummaryLineBlock
  | PaperBlock
  | TableBlock
  | PaginationBlock
  | TextBlock
  | WidgetBlock
  | GridBlock
  | PanelBlock
  | StatTileBlock
  | RepeatBlock

export const BLOCK_KINDS = [
  'page-header',
  'filter-bar',
  'summary-line',
  'paper',
  'table',
  'pagination',
  'text',
  'widget',
  'grid',
  'panel',
  'stat-tile',
  'repeat',
] as const

/* -------------------------------------------------------------------------- */
/* Page                                                                        */
/* -------------------------------------------------------------------------- */

/** Which shared page shell wraps the blocks. Mirrors the existing layouts. */
export type PageLayout = 'list' | 'detail'

export interface PageSpec {
  specVersion: typeof SPEC_VERSION
  layout: PageLayout
  /** Override for the layout's body wrapper — cockpit pages pass a flex
   *  column so the content fits the viewport and scrolls inside panels. */
  bodyClassName?: string
  /** Blocks rendered into the layout's sticky header region. */
  header: Block[]
  /** Blocks rendered into the scrolling body. */
  body: Block[]
}

/**
 * The loader's output.
 *
 * Any object will do: field references are resolved by dot path at render
 * time, not matched structurally at compile time, because a tenant-authored
 * spec is data and its references cannot be checked against a type. Native
 * pages get their compile-time safety from `ref<T>()` in the builders
 * instead, which is where it is actually enforceable — so this stays `object`
 * rather than an index signature that every loader interface would have to
 * carry for no benefit.
 */
export type ViewData = object
