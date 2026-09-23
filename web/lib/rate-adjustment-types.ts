/**
 * The ONE definition of a rate card's commercial-adjustment vocabulary,
 * shared by the card save route, the card UI, and the pricing engine.
 *
 * The three surfaces must never drift: a type the save accepts but pricing
 * cannot match bills zero forever, and a type the UI offers but the save
 * refuses is a dead control. Import these lists instead of redeclaring
 * them; `rate-adjustment-types.test.ts` derives that every accepted target
 * type has a matcher case and every accepted calculation has a pricing case.
 *
 * Pure — no data access, no server-only marker — so the client UI can
 * import it directly.
 */

/**
 * Dimensions of an invoice line an adjustment can select. Every entry here
 * must have a matcher case in `lineMatchesAdjustment`: a saved type with no
 * case bills zero forever, so unmatchable dimensions (`transaction_type`,
 * `other`) are not listed and the save refuses them by name.
 */
export const ADJUSTMENT_TARGET_TYPES = [
  'labor',
  'material',
  'item',
  'item_kind',
  'item_category',
  'department',
  'subsidiary',
  'location',
  'class',
  'trade',
  'job_title',
  'project',
  'customer',
] as const
export type AdjustmentTargetType = (typeof ADJUSTMENT_TARGET_TYPES)[number]

/**
 * How an adjustment turns into money. Every entry here must have a pricing
 * case in `priceAdjustments`. `distance` and `time` name no quantity the
 * bill line carries — no mileage source exists and `time` is undefined —
 * so they are not listed and the save refuses them by name.
 */
export const ADJUSTMENT_CALCULATIONS = [
  'percent',
  'fixed',
  'per_hour',
  'per_day',
  'text',
] as const
export type AdjustmentCalculationType = (typeof ADJUSTMENT_CALCULATIONS)[number]

/** What kind of commercial term the adjustment is. */
export const ADJUSTMENT_CATEGORIES = [
  'markup',
  'travel',
  'allowance',
  'minimum',
  'surcharge',
  'other',
] as const

/** How the charge reaches the invoice. */
export const ADJUSTMENT_PRESENTATIONS = ['included', 'separate', 'informational'] as const

/**
 * Targets addressed by free text rather than a UUID reference. Everything
 * else names a row by id.
 */
export const ADJUSTMENT_TEXT_TARGETS: ReadonlySet<string> = new Set([
  'item_kind',
  'item_category',
  'job_title',
])
