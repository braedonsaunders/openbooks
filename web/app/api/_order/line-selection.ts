import { normalizeDecimal } from '@openbooks/engine/src/money/money.ts'
import { cmp, toUnits } from '@openbooks/engine/src/money/money.ts'
import { canonicalDecimal, compareDecimal } from '../../../lib/exact-decimal'
import type { PriceBasis } from '../../../lib/price-basis'
import { resolveItemPrice } from '../../../lib/item-pricing'

export interface OrderLineInput {
  itemId?: string | null
  accountId?: string | null
  description?: string | null
  quantity?: string | null
  unit?: string | null
  unitPrice?: string | null
  taxCodeId?: string | null
  taxGroupId?: string | null
  departmentId?: string | null
  projectId?: string | null
  /** Warehouse relieve/fulfil effects use for a stocked line. */
  stockLocationId?: string | null
  extraDims?: Record<string, string | null>
  /**
   * Non-null signals that the line came from a catalog price preview. Save
   * re-resolves the price server-side and persists only that authoritative
   * basis; null marks a hand-priced line. Excluded from idempotency matching
   * because the preview instant can change on an otherwise identical retry.
   */
  priceBasis?: unknown
}

/** Quantity columns are numeric(28,8); do not force ledger money scale. */
export function exactOrderQuantity(v: unknown): string | 'invalid' {
  const exact = canonicalDecimal(v, 8)
  if (exact === null) return 'invalid'
  try {
    return normalizeDecimal(exact, 8)
  } catch {
    return 'invalid'
  }
}

/** unit_price columns are numeric(28,8): a saved line reads back at storage
 * scale, so validation must accept it — otherwise no saved order can ever be
 * re-saved. Ledger totals stay 4dp (exactOrderMoney in ./lib). */
export function exactOrderUnitPrice(v: unknown): string | 'invalid' {
  const exact = canonicalDecimal(v, 8)
  if (exact === null) return 'invalid'
  try {
    return normalizeDecimal(exact, 8)
  } catch {
    return 'invalid'
  }
}

/**
 * Split drawer grid rows into postable lines. Only a truly blank row (no
 * item, no account, no description) is grid filler and omitted; anything
 * the drawer sent must either post or refuse by name. A populated row with
 * a non-positive quantity or a negative price used to vanish while the
 * totals recomputed, so the operator saw 200/201 for an order missing
 * lines they typed — every such row is now a 422 naming its line number.
 *
 * Pure decimal validation: no database, no session. Both the unsaved-create
 * POST and the draft PATCH share it so the two surfaces can never disagree
 * on which rows persist. It lives here — not in ./lib — because the route
 * suites double ./lib while this validation must always run real.
 */
export function selectPostableOrderLines(lines: OrderLineInput[]): { valid: OrderLineInput[] } | { error: string } {
  const valid: OrderLineInput[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const n = i + 1
    const hasPosting = Boolean(line.itemId || line.accountId)
    const hasText = typeof line.description === 'string' && line.description.trim() !== ''
    if (!hasPosting && !hasText) continue
    if (!hasPosting) {
      return { error: `Order line ${n}: add an item or an account, or clear the row — a description alone cannot post` }
    }
    const quantity = exactOrderQuantity(line.quantity ?? '0')
    const unitPrice = exactOrderUnitPrice(line.unitPrice ?? '0')
    if (quantity === 'invalid' || unitPrice === 'invalid') {
      return { error: `Order line ${n}: quantity and unit price must be valid numbers` }
    }
    try {
      toUnits(quantity)
    } catch {
      return { error: `Order line ${n}: quantity and unit price must be valid numbers` }
    }
    if (compareDecimal(quantity, '0') <= 0) {
      return { error: `Order line ${n}: quantity must be greater than zero — remove the line or correct its quantity` }
    }
    if (cmp(unitPrice, '0') < 0) {
      return { error: `Order line ${n}: unit price cannot be negative — remove the line or correct its price` }
    }
    valid.push({ ...line, quantity, unitPrice })
  }
  return { valid }
}

/**
 * Resolve pricing provenance on the server. A supplied client basis is only
 * an indication that the line came from a catalog preview; none of its
 * claims are persisted. The catalog resolver is the sole authority for the
 * kind, ids, amount and resolution instant.
 */
export async function resolveLinePriceBasis(input: {
  lineNumber: number
  orgId: string
  customerId: string | null
  currency: string
  documentDate: string
  line: OrderLineInput
  overallItemQuantity: string
}): Promise<PriceBasis | null | { error: string }> {
  if (input.line.priceBasis == null) return null
  if (!input.line.itemId) {
    return { error: `Order line ${input.lineNumber}: price provenance requires an item — remove the catalog price basis` }
  }
  const resolved = await resolveItemPrice({
    orgId: input.orgId,
    itemId: input.line.itemId,
    customerId: input.customerId,
    currency: input.currency,
    lineQuantity: input.line.quantity ?? '0',
    overallItemQuantity: input.overallItemQuantity,
    onDate: input.documentDate,
  })
  if (!resolved || canonicalDecimal(input.line.unitPrice ?? '0', 8) !== canonicalDecimal(resolved.unitPrice, 8)) {
    return { error: `Order line ${input.lineNumber}: the catalog price changed or does not match this line — re-resolve the price or remove the catalog price basis` }
  }
  return {
    kind: resolved.source,
    scheduleId: resolved.scheduleId,
    levelId: resolved.priceLevelId,
    assignmentId: resolved.assignmentId,
    unitPrice: canonicalDecimal(resolved.unitPrice, 8)!,
    resolvedAt: resolved.resolvedAt,
  }
}

/** Sum an item's line quantities without converting them through Number. */
export function overallItemQuantities(lines: OrderLineInput[]): Map<string, string> {
  const totals = new Map<string, bigint>()
  for (const line of lines) {
    if (!line.itemId) continue
    const quantity = canonicalDecimal(line.quantity ?? '0', 8)
    if (quantity === null) continue
    const negative = quantity.startsWith('-')
    const [whole, fraction = ''] = (negative ? quantity.slice(1) : quantity).split('.')
    const units = BigInt(whole!) * 100_000_000n + BigInt(fraction.padEnd(8, '0'))
    totals.set(line.itemId, (totals.get(line.itemId) ?? 0n) + (negative ? -units : units))
  }
  return new Map([...totals].map(([itemId, units]) => {
    const whole = units / 100_000_000n
    const fraction = (units < 0n ? -units : units) % 100_000_000n
    const text = `${whole}.${fraction.toString().padStart(8, '0')}`.replace(/\.?0+$/, '')
    return [itemId, text]
  }))
}
