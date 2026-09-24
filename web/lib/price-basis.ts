import { canonicalDecimal } from './exact-decimal'

/**
 * Pricing provenance for a priced document line (0336). When a line's price
 * comes from the item-pricing resolver, the caller records the basis it
 * resolved from; replay and audit read the recorded basis, never a
 * re-resolution — so a price agreed at 10am still reads 100 after an 11am
 * revoke. Lines priced by hand carry no basis (null): replay then reads the
 * stored unit price, as before.
 */
export interface PriceBasis {
  kind: 'customer_item' | 'customer_level' | 'base_level' | 'simple'
  scheduleId: string | null
  levelId: string | null
  assignmentId: string | null
  unitPrice: string
  resolvedAt: string
}

const KINDS = new Set(['customer_item', 'customer_level', 'base_level', 'simple'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function uuidOrNull(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null
  return typeof value === 'string' && UUID.test(value) ? value : undefined
}

/**
 * Validate a client-supplied price basis. Returns the normalized basis, or
 * null when the line carries none (a hand-priced line). Anything else is a
 * refusal: lineage that does not parse is not stored.
 */
export function parsePriceBasis(raw: unknown): PriceBasis | null | { error: string } {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'Line price basis must be an object or null' }
  }
  const basis = raw as Record<string, unknown>
  if (!KINDS.has(basis.kind as string)) {
    return { error: 'Line price basis kind must be customer_item, customer_level, base_level or simple' }
  }
  const scheduleId = uuidOrNull(basis.scheduleId)
  const levelId = uuidOrNull(basis.levelId)
  const assignmentId = uuidOrNull(basis.assignmentId)
  if (scheduleId === undefined || levelId === undefined || assignmentId === undefined) {
    return { error: 'Line price basis ids must be UUIDs or null' }
  }
  if ((basis.kind === 'customer_level' && (levelId === null || assignmentId === null)) ||
      ((basis.kind === 'customer_item' || basis.kind === 'base_level') && scheduleId === null)) {
    return { error: 'Line price basis is missing the id its kind resolves from' }
  }
  const unitPrice = canonicalDecimal(basis.unitPrice, 8)
  if (unitPrice === null) return { error: 'Line price basis unit price must be a decimal' }
  if (typeof basis.resolvedAt !== 'string' || Number.isNaN(Date.parse(basis.resolvedAt))) {
    return { error: 'Line price basis resolved time must be an ISO-8601 instant' }
  }
  return {
    kind: basis.kind as PriceBasis['kind'],
    scheduleId,
    levelId,
    assignmentId,
    unitPrice,
    resolvedAt: basis.resolvedAt,
  }
}

/**
 * Build the basis the drawer echoes from a preview response: only when the
 * row still shows exactly what the preview resolved (same item and price).
 * Anything the operator touched after resolving prices by hand (null).
 */
export function basisForResolvedRow(args: {
  row: { itemId: string | null; unitPrice: string }
  resolved: { itemId: string; unitPrice: string; basis: PriceBasis } | undefined
}): PriceBasis | null {
  if (!args.resolved) return null
  if (args.row.itemId !== args.resolved.itemId || args.row.unitPrice !== args.resolved.unitPrice) return null
  return args.resolved.basis
}
