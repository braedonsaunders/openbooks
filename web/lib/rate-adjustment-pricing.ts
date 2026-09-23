/**
 * Pricing for a rate card's commercial adjustments — pure, no data access.
 *
 * Split from the resolver so the arithmetic deciding what a customer is charged
 * can be tested directly, mirroring item-rate-currency alongside item-rates.
 */
import { add, cmp, fromUnits, isZero, mulDecimal, roundDiv, sum, toUnits } from '@openbooks/engine/src/money/money.ts'

/** A percentage the pricing cannot read exactly — stored values are capped at
 * 10 decimals, so anything else is a caller bug, refused by name. */
export class RateAdjustmentPricingError extends Error {}

/** 10 decimals: the stored scale of an adjustment percent value. */
const PERCENT_SCALE = 10_000_000_000n

/**
 * Multiply money by a percentage stored at up to 10 decimal places. The save
 * accepts percents to numeric(19,10), but the house mulPercent reads its
 * percent at 4 decimals and throws past that — so a 3.123456% surcharge
 * made invoice generation throw. This parses the full 10dp exactly as
 * BigInt and rounds the RESULT once, halves away from zero.
 */
export function mulPercentExact(amount: string, percent: string, decimalPlaces: 2 | 4 = 2): string {
  const raw = String(percent).trim()
  const parsed = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))$/.exec(raw)
  if (!parsed) throw new RateAdjustmentPricingError(`not a percentage value: "${percent}"`)
  const [, sign, whole = '0', fraction = '', leadingFraction = ''] = parsed
  const digits = fraction || leadingFraction
  if (digits.length > 10) {
    throw new RateAdjustmentPricingError(`percentage loses precision beyond 10 decimal places: "${percent}"`)
  }
  const magnitude = BigInt(whole || '0') * PERCENT_SCALE + BigInt((digits + '0'.repeat(10)).slice(0, 10))
  const percentUnits = sign === '-' ? -magnitude : magnitude
  const quantum = 10n ** BigInt(4 - decimalPlaces)
  const roundedQuanta = roundDiv(
    toUnits(amount) * percentUnits,
    100n * PERCENT_SCALE * quantum,
  )
  return fromUnits(roundedQuanta * quantum)
}

/** Exact zero for a stored adjustment value at any supported scale. */
function isZeroValue(value: string): boolean {
  return /^-?0*(\.0*)?$/.test(String(value).trim().replace(/^\+/, ''))
}

/** How a percentage charge lands on the cent. */
export type AdjustmentRounding = 'half_up' | 'down'

/** Truncate toward zero at the cent — a charge rounded DOWN never overcharges. */
function floorToCents(amount: string): string {
  const units = toUnits(amount)
  const negative = units < 0n
  const magnitude = negative ? -units : units
  const floored = (magnitude / 100n) * 100n
  return fromUnits(negative ? -floored : floored)
}

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
  /** Unit for quantity-priced calculations (`hour`, `day`, …) — the snapshot
   * carried onto the invoice line. */
  unit?: string | null
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
  /** Billable quantity for per-hour pricing (hours) — the invoice line's own
   * quantity, snapshotted before presentation rewrites it. */
  quantity?: string | null
  /** Date the work happened — per-day pricing counts distinct dates. */
  workedOn?: string | null
  itemId?: string | null
  itemKind?: string | null
  itemCategory?: string | null
  /** Every active trade / job title held by the line's employee. */
  tradeIds?: string[] | null
  jobTitles?: string[] | null
  departmentId?: string | null
  /** Who the work is for and where it sits — the card assignment selects the
   * card, but an adjustment's own targets still constrain which lines it
   * measures. Missing context never matches: it fails closed. */
  customerId?: string | null
  projectId?: string | null
  subsidiaryId?: string | null
  locationId?: string | null
  classId?: string | null
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
      case 'item_category': return !!line.itemCategory && line.itemCategory === (t.targetValueText ?? '')
      case 'trade': return !!t.targetValueId && (line.tradeIds ?? []).includes(t.targetValueId)
      case 'job_title': return !!t.targetValueText && (line.jobTitles ?? []).includes(t.targetValueText)
      case 'department': return !!line.departmentId && line.departmentId === t.targetValueId
      // The card assignment selects WHICH adjustments apply; each
      // adjustment's own targets still select WHICH lines they measure. A
      // customer-A adjustment on shared work must not charge customer B.
      case 'customer': return !!line.customerId && line.customerId === t.targetValueId
      case 'project': return !!line.projectId && line.projectId === t.targetValueId
      case 'subsidiary': return !!line.subsidiaryId && line.subsidiaryId === t.targetValueId
      case 'location': return !!line.locationId && line.locationId === t.targetValueId
      case 'class': return !!line.classId && line.classId === t.targetValueId
      default: return false
    }
  })
}

export interface AdjustmentCharge {
  adjustment: ResolvedAdjustment
  basis: string
  amount: string
  /** Total units priced for per-hour/per-day charges — the quantity snapshot
   * carried onto the invoice line and re-priced on merge. */
  quantityBasis?: string | null
}

/** Quantities are not money: exact sum at 8 decimals, the widest billable
 * quantity scale. Anything wider or non-numeric is a caller bug. */
function sumQuantities(values: string[]): string {
  const SCALE = 100_000_000n
  let total = 0n
  for (const value of values) {
    const parsed = /^(-?)(\d+)(?:\.(\d*))?$/.exec(String(value).trim())
    if (!parsed || (parsed[3] ?? '').length > 8) {
      throw new RateAdjustmentPricingError(`not an exact billable quantity: "${value}"`)
    }
    const magnitude = BigInt(parsed[2]!) * SCALE + BigInt(((parsed[3] ?? '') + '0'.repeat(8)).slice(0, 8))
    total += parsed[1] === '-' ? -magnitude : magnitude
  }
  const negative = total < 0n
  const magnitude = negative ? -total : total
  const whole = magnitude / SCALE
  const fraction = (magnitude % SCALE).toString().padStart(8, '0').replace(/0+$/, '')
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`
}

/**
 * Price the adjustments that bill as their own invoice line. `included`
 * adjustments are already inside the resolved rates and `informational` ones
 * are display-only, so neither adds an amount here. The loop never silently
 * skips a priced calculation: an unknown one throws naming the adjustment.
 */
export function priceAdjustments(
  lines: AdjustableLine[],
  adjustments: ResolvedAdjustment[],
  rounding: AdjustmentRounding = 'half_up',
): AdjustmentCharge[] {
  const charges: AdjustmentCharge[] = []
  for (const adjustment of adjustments) {
    if (adjustment.presentation !== 'separate') continue
    const unitPriced = adjustment.calculation === 'per_hour' || adjustment.calculation === 'per_day'
    switch (adjustment.calculation) {
      case 'percent': case 'fixed': case 'per_hour': case 'per_day': case 'text': break
      default:
        throw new RateAdjustmentPricingError(
          `rate card adjustment "${adjustment.code}" uses unknown calculation "${adjustment.calculation}" — add a pricing case or remove it from the card before invoicing`,
        )
    }
    // Informational text never carries an amount by definition.
    if (adjustment.calculation === 'text') continue
    // The zero check reads the stored scale (up to 10dp for percents): the
    // house isZero caps at 4dp and would throw on a legal 10dp percent.
    if (!adjustment.value || isZeroValue(adjustment.value)) continue

    const matched = lines.filter((l) => lineMatchesAdjustment(l, adjustment))
    if (!matched.length) continue
    const basis = sum(matched.map((l) => l.amount))
    // A threshold is a floor on the basis, not on the charge: below it the
    // negotiated term simply does not trigger. Compared as exact decimals —
    // Number() collapses 4dp neighbors at numeric(19,4) magnitude and would
    // charge below the floor.
    if (adjustment.threshold && cmp(basis, adjustment.threshold) < 0) continue

    if (unitPriced) {
      // Hours sum from the lines; days count distinct work dates. A matched
      // set with no quantity is missing data, not a zero charge: refuse.
      const totalQty = adjustment.calculation === 'per_hour'
        ? sumQuantities(matched.map((l) => l.quantity ?? '0'))
        : String(new Set(matched.map((l) => l.workedOn).filter((d): d is string => !!d)).size)
      if (isZeroValue(totalQty)) {
        throw new RateAdjustmentPricingError(
          `rate card adjustment "${adjustment.code}" prices per ${adjustment.calculation === 'per_hour' ? 'hour' : 'day'} but its lines carry no ${adjustment.calculation === 'per_hour' ? 'hours' : 'work dates'} — correct the card or the source lines before invoicing`,
        )
      }
      const amount = mulDecimal(adjustment.value, totalQty)
      if (isZero(amount)) continue
      charges.push({ adjustment, basis, amount, quantityBasis: totalQty })
      continue
    }

    const amount = adjustment.calculation === 'fixed'
      ? adjustment.value
      : rounding === 'down'
        ? floorToCents(mulPercentExact(basis, adjustment.value, 4))
        : mulPercentExact(basis, adjustment.value, 2)
    if (isZero(amount)) continue
    charges.push({ adjustment, basis, amount })
  }
  return charges
}

/**
 * Fold charges for the same adjustment into one invoice line. Departments are
 * resolved separately so each can carry its own agreement, but when they land
 * on the same negotiated term the customer should see a single charge.
 */
export function mergeCharges(
  charges: AdjustmentCharge[],
  rounding: AdjustmentRounding = 'half_up',
): AdjustmentCharge[] {
  const byAdjustment = new Map<string, AdjustmentCharge>()
  for (const c of charges) {
    const prior = byAdjustment.get(c.adjustment.id)
    if (!prior) byAdjustment.set(c.adjustment.id, { ...c })
    else {
      prior.basis = add(prior.basis, c.basis)
      if (c.quantityBasis) {
        prior.quantityBasis = sumQuantities([prior.quantityBasis ?? '0', c.quantityBasis])
      }
    }
  }
  for (const c of byAdjustment.values()) {
    // Price ONCE off the combined basis. Adding per-department amounts that were
    // each rounded to cents drifts by a cent per group, and a fixed charge would
    // be billed once per department rather than once.
    if (c.adjustment.calculation === 'percent' && c.adjustment.value) {
      c.amount = rounding === 'down'
        ? floorToCents(mulPercentExact(c.basis, c.adjustment.value, 4))
        : mulPercentExact(c.basis, c.adjustment.value, 2)
    } else if (
      (c.adjustment.calculation === 'per_hour' || c.adjustment.calculation === 'per_day') &&
      c.adjustment.value && c.quantityBasis
    ) {
      // Quantity-priced charges re-price off the combined units for the same
      // reason: summing rounded per-partition amounts drifts.
      c.amount = mulDecimal(c.adjustment.value, c.quantityBasis)
    }
  }
  return [...byAdjustment.values()].sort((a, b) => a.adjustment.sortOrder - b.adjustment.sortOrder)
}
