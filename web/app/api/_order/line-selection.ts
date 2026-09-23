import { normalizeDecimal } from '@openbooks/engine/src/money/money.ts'
import { cmp, toUnits } from '@openbooks/engine/src/money/money.ts'
import { canonicalDecimal, compareDecimal } from '../../../lib/exact-decimal'

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
