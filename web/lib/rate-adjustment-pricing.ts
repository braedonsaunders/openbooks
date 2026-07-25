/**
 * Pricing for a rate card's commercial adjustments — pure, no data access.
 *
 * Split from the resolver so the arithmetic deciding what a customer is charged
 * can be tested directly, mirroring item-rate-currency alongside item-rates.
 */
import { add, mulPercent, sum } from '@openbooks/engine/src/money.ts'

export type AdjustmentCategory = 'markup' | 'travel' | 'allowance' | 'minimum' | 'surcharge' | 'other'
export type AdjustmentCalculation = 'percent' | 'fixed' | 'per_hour' | 'per_day' | 'distance' | 'time' | 'text'
export type AdjustmentPresentation = 'included' | 'separate' | 'informational'

export interface AdjustmentTarget {
  targetType: string
  targetValueId: string | null
  targetValueText: string | null
}

export interface ResolvedAdjustment {
  id: string
  code: string
  name: string
  category: AdjustmentCategory
  calculation: AdjustmentCalculation
  /** A percent value is a percentage: `3.75` means 3.75%. */
  value: string | null
  presentation: AdjustmentPresentation
  threshold: string | null
  itemId: string | null
  appliesRegular: boolean
  appliesOvertime: boolean
  appliesDoubleTime: boolean
  sortOrder: number
  targets: AdjustmentTarget[]
}

/** A line the adjustments are measured against. */
export interface AdjustableLine {
  amount: string
  itemId?: string | null
  itemKind?: string | null
  departmentId?: string | null
  /** True when the charge came from billable time rather than a cost document. */
  isLabor?: boolean
  /** Time-type bucket, when the line came from labor. */
  timeKind?: 'regular' | 'overtime' | 'double_time' | null
}

/**
 * Multiple targets are inclusive alternatives. With NO target the adjustment
 * measures the labor on the card it belongs to — a labor rate card's negotiated
 * terms are terms on labor — so an untargeted surcharge can never silently
 * sweep in materials. Widening to materials is an explicit `material` target.
 */
export function lineMatchesAdjustment(line: AdjustableLine, adjustment: ResolvedAdjustment): boolean {
  if (line.timeKind === 'regular' && !adjustment.appliesRegular) return false
  if (line.timeKind === 'overtime' && !adjustment.appliesOvertime) return false
  if (line.timeKind === 'double_time' && !adjustment.appliesDoubleTime) return false
  if (!adjustment.targets.length) return line.isLabor === true
  return adjustment.targets.some((t) => {
    switch (t.targetType) {
      case 'labor': return line.isLabor === true
      case 'material': return line.isLabor !== true
      case 'item': return !!line.itemId && line.itemId === t.targetValueId
      case 'item_kind': return !!line.itemKind && line.itemKind === (t.targetValueText ?? '')
      case 'department': return !!line.departmentId && line.departmentId === t.targetValueId
      // Customer/project/subsidiary targets are already satisfied by the card
      // assignment that selected this adjustment, so they match every line.
      case 'customer': case 'project': case 'subsidiary': case 'location': case 'class': return true
      default: return false
    }
  })
}

export interface AdjustmentCharge {
  adjustment: ResolvedAdjustment
  basis: string
  amount: string
}

/**
 * Price the adjustments that bill as their own invoice line. `included`
 * adjustments are already inside the resolved rates and `informational` ones
 * are display-only, so neither adds an amount here.
 */
export function priceAdjustments(lines: AdjustableLine[], adjustments: ResolvedAdjustment[]): AdjustmentCharge[] {
  const charges: AdjustmentCharge[] = []
  for (const adjustment of adjustments) {
    if (adjustment.presentation !== 'separate') continue
    if (adjustment.calculation !== 'percent' && adjustment.calculation !== 'fixed') continue
    if (!adjustment.value || Number(adjustment.value) === 0) continue

    const matched = lines.filter((l) => lineMatchesAdjustment(l, adjustment))
    if (!matched.length) continue
    const basis = sum(matched.map((l) => l.amount))
    // A threshold is a floor on the basis, not on the charge: below it the
    // negotiated term simply does not trigger.
    if (adjustment.threshold && Number(basis) < Number(adjustment.threshold)) continue

    const amount = adjustment.calculation === 'fixed' ? adjustment.value : mulPercent(basis, adjustment.value, 2)
    if (Number(amount) === 0) continue
    charges.push({ adjustment, basis, amount })
  }
  return charges
}

/**
 * Fold charges for the same adjustment into one invoice line. Departments are
 * resolved separately so each can carry its own agreement, but when they land
 * on the same negotiated term the customer should see a single charge.
 */
export function mergeCharges(charges: AdjustmentCharge[]): AdjustmentCharge[] {
  const byAdjustment = new Map<string, AdjustmentCharge>()
  for (const c of charges) {
    const prior = byAdjustment.get(c.adjustment.id)
    if (!prior) byAdjustment.set(c.adjustment.id, { ...c })
    else prior.basis = add(prior.basis, c.basis)
  }
  for (const c of byAdjustment.values()) {
    // Price ONCE off the combined basis. Adding per-department amounts that were
    // each rounded to cents drifts by a cent per group, and a fixed charge would
    // be billed once per department rather than once.
    if (c.adjustment.calculation === 'percent' && c.adjustment.value) {
      c.amount = mulPercent(c.basis, c.adjustment.value, 2)
    }
  }
  return [...byAdjustment.values()].sort((a, b) => a.adjustment.sortOrder - b.adjustment.sortOrder)
}
