/**
 * Runtime validation for a ViewSpec.
 *
 * Native pages author specs through the typed builders and are checked by the
 * compiler. A tenant- or agent-authored spec arrives as untrusted JSON, so it
 * must pass through here before anything renders it. The two paths share this
 * schema so they can never disagree — the same rule the customization package
 * already follows for form layouts and list views.
 *
 * Validation is deliberately CLOSED: `z.strictObject` everywhere and literal
 * unions for every kind. An unknown block kind, an unknown cell renderer, or a
 * stray property is a rejection, not something we render best-effort. Failing
 * closed is the whole point — a spec is only safe because it cannot express
 * anything the block registry does not already implement.
 *
 * Widget names are NOT validated here (this module stays host-agnostic). The
 * renderer resolves them against the host's widget registry and rejects
 * unknown names there, where the registry actually lives.
 */

import { z } from 'zod'
import { SPEC_VERSION } from './types.ts'

const fieldRefSchema = z.strictObject({ $: z.string().min(1).max(200) })

/** A literal string or a field reference. */
const value = z.union([z.string(), fieldRefSchema])
const boolValue = z.union([z.boolean(), fieldRefSchema])

const toneSchema = z.union([
  z.enum(['default', 'negative', 'positive', 'warning', 'muted', 'strong']),
  fieldRefSchema,
])

const alignSchema = z.enum(['left', 'right', 'center'])

/* ----------------------------- cell renderers ----------------------------- */

const textCell = z.strictObject({
  kind: z.literal('text'),
  field: fieldRefSchema,
  fallback: value.optional(),
  tone: toneSchema.optional(),
  numeric: z.boolean().optional(),
  fallbackClassName: z.string().max(200).optional(),
  prefix: z
    .strictObject({ field: fieldRefSchema, className: z.string().max(200).optional() })
    .optional(),
  suffix: z
    .strictObject({ field: fieldRefSchema, className: z.string().max(200).optional() })
    .optional(),
})

const moneyCell = z.strictObject({
  kind: z.literal('money'),
  field: fieldRefSchema,
  tone: toneSchema.optional(),
})

const numberCell = z.strictObject({
  kind: z.literal('number'),
  field: fieldRefSchema,
  tone: toneSchema.optional(),
})

const dateCell = z.strictObject({
  kind: z.literal('date'),
  field: fieldRefSchema,
})

const badgeCell = z.strictObject({
  kind: z.literal('badge'),
  field: fieldRefSchema,
  variant: z
    .union([z.enum(['default', 'secondary', 'outline', 'destructive', 'warning', 'success']), fieldRefSchema])
    .optional(),
})

const linkCell = z.strictObject({
  kind: z.literal('link'),
  field: fieldRefSchema,
  href: fieldRefSchema,
  className: z.string().max(200).optional(),
})

const recordLinkCell = z.strictObject({
  kind: z.literal('record-link'),
  field: fieldRefSchema,
  recordType: value,
  id: fieldRefSchema,
})

const leafCell = z.discriminatedUnion('kind', [
  textCell,
  moneyCell,
  numberCell,
  dateCell,
  badgeCell,
  linkCell,
  recordLinkCell,
])

/** `drill` wraps a leaf, and only a leaf — drills cannot nest. Bounding the
 *  depth here is what keeps the renderer non-recursive in practice. */
const drillCell = z.strictObject({
  kind: z.literal('drill'),
  target: fieldRefSchema,
  inner: leafCell,
})

/** Sibling of `drillCell`; wraps a leaf in a transaction drawer link. */
const txnCell = z.strictObject({
  kind: z.literal('txn'),
  target: fieldRefSchema,
  inner: leafCell,
})

/** A host-registered component inside a cell; name checked by the renderer. */
const widgetCell = z.strictObject({
  kind: z.literal('widget'),
  widget: z.string().min(1).max(64).regex(/^[a-z][a-z0-9-]*$/, 'widget must be a slug'),
  props: z.record(z.string(), z.unknown()).optional(),
})

export const cellSchema = z.union([leafCell, drillCell, txnCell, widgetCell])

/* --------------------------------- widgets -------------------------------- */

const widgetRefSchema = z.strictObject({
  widget: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9-]*$/, 'widget must be a slug'),
  props: z.record(z.string(), z.unknown()).optional(),
  when: fieldRefSchema.optional(),
})

/* --------------------------------- blocks --------------------------------- */

const pageHeaderBlock = z.strictObject({
  kind: z.literal('page-header'),
  when: fieldRefSchema.optional(),
  title: value,
  description: value.optional(),
  back: z.strictObject({ href: value, label: value }).optional(),
  actions: z.array(widgetRefSchema).max(12).optional(),
  actionsClassName: z.string().max(300).optional(),
})

const filterBarBlock = z.strictObject({
  kind: z.literal('filter-bar'),
  when: fieldRefSchema.optional(),
  controls: z.strictObject({
    search: z.boolean().optional(),
    period: z.boolean().optional(),
    dateRange: z.boolean().optional(),
    asOf: z.boolean().optional(),
    breakout: z.boolean().optional(),
    compare: z.boolean().optional(),
    basis: z.boolean().optional(),
    dimensions: z.boolean().optional(),
    subsidiary: z.boolean().optional(),
    showZero: z.boolean().optional(),
    scale: z.boolean().optional(),
    sections: z.boolean().optional(),
  }),
  searchPlaceholder: value.optional(),
  leading: z
    .strictObject({
      kind: z.literal('toggle-links'),
      links: z
        .array(z.strictObject({ href: value, label: value, activeWhen: fieldRefSchema }))
        .max(8),
      divider: z.boolean().optional(),
    })
    .optional(),
  actions: z.array(widgetRefSchema).max(12).optional(),
  dimensions: fieldRefSchema.optional(),
  subsidiaries: fieldRefSchema.optional(),
  customers: fieldRefSchema.optional(),
  dateRange: fieldRefSchema.optional(),
  primaryFilter: fieldRefSchema.optional(),
  periodPresets: fieldRefSchema.optional(),
  defaultPeriod: value.optional(),
})

const summaryLineBlock = z.strictObject({
  kind: z.literal('summary-line'),
  when: fieldRefSchema.optional(),
  label: value,
  value: cellSchema,
})

const columnSchema = z.strictObject({
  header: value,
  align: alignSchema.optional(),
  cell: cellSchema,
  sort: z.string().max(60).optional(),
  className: z.string().max(200).optional(),
  headerClassName: z.string().max(200).optional(),
})

const spanRowSchema = z.strictObject({
  label: value,
  labelColSpan: z.number().int().min(1).max(60),
  labelClassName: z.string().max(200).optional(),
  className: z.string().max(200).optional(),
  cells: z
    .array(
      z.strictObject({
        cell: cellSchema,
        align: alignSchema.optional(),
        className: z.string().max(200).optional(),
      }),
    )
    .max(20),
})

const tableBlock = z.strictObject({
  kind: z.literal('table'),
  when: fieldRefSchema.optional(),
  variant: z.enum(['report', 'app']).optional(),
  leading: z.array(spanRowSchema).max(10).optional(),
  trailing: z.array(spanRowSchema).max(10).optional(),
  rows: fieldRefSchema,
  rowKey: fieldRefSchema,
  columns: z.array(columnSchema).min(1).max(60),
  empty: z.strictObject({ title: value, description: value.optional() }).optional(),
  emptyRow: z
    .strictObject({
      text: value,
      colSpan: z.number().int().min(1).max(60),
      className: z.string().max(200).optional(),
    })
    .optional(),
})

const paginationBlock = z.strictObject({
  kind: z.literal('pagination'),
  when: fieldRefSchema.optional(),
  basePath: value,
  total: fieldRefSchema,
  page: fieldRefSchema,
  perPage: fieldRefSchema,
})

const textBlock = z.strictObject({
  kind: z.literal('text'),
  content: value,
  tone: toneSchema.optional(),
  className: z.string().max(300).optional(),
  when: fieldRefSchema.optional(),
})

/** A host-registered domain component placed as a block. The name is checked
 *  against the host widget registry at render time, where the registry lives. */
const widgetBlock = z.strictObject({
  kind: z.literal('widget'),
  widget: z.string().min(1).max(64).regex(/^[a-z][a-z0-9-]*$/, 'widget must be a slug'),
  props: z.record(z.string(), z.unknown()).optional(),
  when: fieldRefSchema.optional(),
})

/**
 * `paper` nests blocks, so the union is recursive. Depth is capped by
 * MAX_BLOCK_DEPTH below rather than by the type, because zod's lazy recursion
 * would otherwise accept arbitrarily deep nesting from untrusted JSON.
 */
export const blockSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    pageHeaderBlock,
    filterBarBlock,
    summaryLineBlock,
    tableBlock,
    paginationBlock,
    textBlock,
    widgetBlock,
    z.strictObject({
      kind: z.literal('stat-tile'),
      iconKey: value,
      accent: value,
      label: value,
      value: value,
      sub: value.optional(),
      tone: z.union([z.enum(['default', 'positive', 'warning', 'negative']), fieldRefSchema]).optional(),
      when: fieldRefSchema.optional(),
    }),
    z.strictObject({
      kind: z.literal('repeat'),
  when: fieldRefSchema.optional(),
      items: fieldRefSchema,
      itemKey: fieldRefSchema,
      className: z.string().max(300).optional(),
      itemClassName: z.string().max(300).optional(),
      blocks: z.array(blockSchema).max(40),
      empty: z.strictObject({ text: value, className: z.string().max(300).optional() }).optional(),
    }),
    z.strictObject({
      kind: z.literal('grid'),
  when: fieldRefSchema.optional(),
      className: z.string().max(300).optional(),
      blocks: z.array(blockSchema).max(40),
    }),
    z.strictObject({
      kind: z.literal('panel'),
  when: fieldRefSchema.optional(),
      title: value,
      iconKey: value.optional(),
      hint: value.optional(),
      className: z.string().max(300).optional(),
      bodyClassName: z.string().max(300).optional(),
      blocks: z.array(blockSchema).max(40),
    }),
    z.strictObject({
      kind: z.literal('paper'),
  when: fieldRefSchema.optional(),
      company: value.optional(),
      title: value,
      periodPhrase: value.optional(),
      note: value.optional(),
      wide: boolValue.optional(),
      blocks: z.array(blockSchema).max(40),
    }),
  ]),
)

export const MAX_BLOCK_DEPTH = 6

export const pageSpecSchema = z.strictObject({
  specVersion: z.literal(SPEC_VERSION),
  layout: z.enum(['list', 'detail']),
  bodyClassName: z.string().max(300).optional(),
  header: z.array(blockSchema).max(20),
  body: z.array(blockSchema).max(40),
})

export interface SpecValidation {
  ok: boolean
  errors: string[]
}

/** Walk nested `paper` blocks and reject anything deeper than the cap. */
function assertDepth(blocks: unknown[], depth: number, errors: string[]): void {
  if (depth > MAX_BLOCK_DEPTH) {
    errors.push(`block nesting exceeds the maximum depth of ${MAX_BLOCK_DEPTH}`)
    return
  }
  for (const block of blocks) {
    const nested = (block as { blocks?: unknown }).blocks
    if (Array.isArray(nested)) assertDepth(nested, depth + 1, errors)
  }
}

/** Parse + validate an untrusted spec. Never throws. */
export function validateSpec(raw: unknown): SpecValidation {
  const parsed = pageSpecSchema.safeParse(raw)
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    }
  }
  const errors: string[] = []
  assertDepth(parsed.data.header, 1, errors)
  assertDepth(parsed.data.body, 1, errors)
  return { ok: errors.length === 0, errors }
}
