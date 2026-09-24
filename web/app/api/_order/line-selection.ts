import { normalizeDecimal } from '@openbooks/engine/src/money/money.ts'
import { cmp, toUnits } from '@openbooks/engine/src/money/money.ts'
import { canonicalDecimal, compareDecimal } from '../../../lib/exact-decimal'
import { parsePriceBasis, type PriceBasis } from '../../../lib/price-basis'

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
   * Pricing provenance echoed from the price preview (0336). Validated and
   * persisted as document_lines.price_basis; null for hand-priced lines.
   * Deliberately excluded from the idempotency match: it carries the
   * preview instant, so a retry with a fresh preview must still replay.
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
 * Validate a line's echoed price basis (0336): it must parse, and its price
 * must equal the line price — a basis for a different price is stale
 * lineage (or forgery) and refuses instead of persisting. Null means the
 * line was priced by hand: no basis is stored and replay reads the price.
 * Pure (kept here, never doubled: route suites double the DB-bound lib).
 */
export function resolveLinePriceBasis(
  lineNumber: number,
  unitPrice: string | null | undefined,
  raw: unknown,
): PriceBasis | null | { error: string } {
  const parsed = parsePriceBasis(raw ?? null)
  if (parsed === null || 'error' in parsed) return parsed
  if (canonicalDecimal(unitPrice ?? '0', 8) !== parsed.unitPrice) {
    return { error: `Order line ${lineNumber}: price basis does not match the line price — re-resolve the price` }
  }
  return parsed
}
