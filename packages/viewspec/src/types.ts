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
  tone?: Value<Tone>
  /** Render as monospace tabular figures (the `tabular-nums` treatment). */
  numeric?: boolean
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
  variant?: Value<'default' | 'outline' | 'secondary' | 'destructive'>
}

/** An ordinary link. `href` is resolved by the loader, not built by the spec. */
export interface LinkCell {
  kind: 'link'
  field: FieldRef
  href: FieldRef
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

export type CellSpec = LeafCell | DrillCell

export const LEAF_CELL_KINDS = [
  'text',
  'money',
  'number',
  'date',
  'badge',
  'link',
  'record-link',
] as const

export const CELL_KINDS = [...LEAF_CELL_KINDS, 'drill'] as const

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
  props?: Record<string, unknown>
  /** Omit the widget entirely when this loader-resolved flag is false. */
  when?: FieldRef
}

/* -------------------------------------------------------------------------- */
/* Blocks                                                                      */
/* -------------------------------------------------------------------------- */

export interface PageHeaderBlock {
  kind: 'page-header'
  title: Value
  description?: Value
  back?: { href: Value; label: Value }
  actions?: WidgetRef[]
}

/** Which controls the shared report filter bar shows. Mirrors its real props. */
export interface FilterBarControls {
  search?: boolean
  period?: boolean
  breakout?: boolean
  compare?: boolean
  basis?: boolean
  dimensions?: boolean
  subsidiary?: boolean
  showZero?: boolean
  scale?: boolean
  sections?: boolean
}

export interface FilterBarBlock {
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
}

/** A one-line summary above the content ("Total outstanding: $X"). */
export interface SummaryLineBlock {
  kind: 'summary-line'
  label: Value
  value: CellSpec
}

/** The printable report sheet wrapper. */
export interface PaperBlock {
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
  className?: string
}

/**
 * Which table primitives render the block. The app has two genuinely
 * different tables and conflating them would lose pixel parity: `report`
 * primitives carry statement typography with no card, hover, or row dividers;
 * `app` primitives are the list-page table with card chrome and hover states.
 */
export type TableVariant = 'report' | 'app'

export interface TableBlock {
  kind: 'table'
  variant?: TableVariant
  /** Field on ViewData holding the row array. Each row becomes the cell scope. */
  rows: FieldRef
  /** Stable React key per row. */
  rowKey: FieldRef
  columns: Column[]
  empty?: { title: Value; description?: Value }
}

export interface PaginationBlock {
  kind: 'pagination'
  basePath: Value
  total: FieldRef
  page: FieldRef
  perPage: FieldRef
}

export interface TextBlock {
  kind: 'text'
  content: Value
  tone?: Value<Tone>
  /** Omit the block entirely when this loader-resolved flag is false. */
  when?: FieldRef
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

export const BLOCK_KINDS = [
  'page-header',
  'filter-bar',
  'summary-line',
  'paper',
  'table',
  'pagination',
  'text',
  'widget',
] as const

/* -------------------------------------------------------------------------- */
/* Page                                                                        */
/* -------------------------------------------------------------------------- */

/** Which shared page shell wraps the blocks. Mirrors the existing layouts. */
export type PageLayout = 'list' | 'detail'

export interface PageSpec {
  specVersion: typeof SPEC_VERSION
  layout: PageLayout
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
