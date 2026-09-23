import { cmp, normalizeMoney } from '@openbooks/engine/src/money/money.ts'
import { canonicalDecimal } from '@/lib/exact-decimal'
import { isUuid } from '@/lib/list-params'

const POLICIES = new Set(['capped_ladder', 'lowest_cost'])
const PRESENTATIONS = new Set(['rate_components', 'summary'])

export interface RateBookInputLine {
  itemId?: unknown
  unitCode?: unknown
  unitName?: unknown
  baseQuantity?: unknown
  costRate?: unknown
  billRate?: unknown
  baseUnit?: unknown
  pricingPolicy?: unknown
  invoicePresentation?: unknown
  timeTypeBillRates?: unknown
}

export interface ValidRateBookLine {
  itemId: string
  unitCode: string
  unitName: string
  baseQuantity: string
  costRate: string
  billRate: string
  baseUnit: string
  pricingPolicy: string
  invoicePresentation: string
  timeTypeBillRates: Record<string, string>
}

function wholeDigits(value: string): number {
  return value.replace(/^[+-]/, '').split('.')[0]!.replace(/^0+/, '').length
}

function isBlankField(value: unknown): boolean {
  return value == null || String(value).trim() === ''
}

/**
 * A placeholder row is blank only when EVERY field is empty. A row with an
 * unset item picker but filled quantities or rates is partly filled, never
 * blank: skipping it would silently drop rates the operator typed, so it is
 * refused by index naming the missing field instead.
 */
export function isBlankRateBookLine(raw: RateBookInputLine): boolean {
  if (
    !isBlankField(raw.itemId) || !isBlankField(raw.unitCode) || !isBlankField(raw.unitName)
    || !isBlankField(raw.baseQuantity) || !isBlankField(raw.costRate) || !isBlankField(raw.billRate)
    || !isBlankField(raw.baseUnit) || !isBlankField(raw.pricingPolicy) || !isBlankField(raw.invoicePresentation)
  ) return false
  const premiums = raw.timeTypeBillRates
  if (premiums == null) return true
  return typeof premiums === 'object' && !Array.isArray(premiums) && Object.keys(premiums).length === 0
}

export function validateRateBookLines(input: unknown): { lines: ValidRateBookLine[] } | { error: string } {
  if (!Array.isArray(input)) return { error: 'Rate lines must be an array.' }
  const lines: ValidRateBookLine[] = []
  const keys = new Set<string>()
  const profiles = new Map<string, string>()
  let position = 0
  for (const raw of input as RateBookInputLine[]) {
    position += 1
    const row = `Row ${position}`
    if (isBlankRateBookLine(raw)) continue
    const itemId = String(raw.itemId ?? '').trim()
    const unitCode = String(raw.unitCode ?? '').trim().toLowerCase()
    const unitName = String(raw.unitName ?? '').trim()
    if (!isUuid(itemId)) return { error: `${row}: choose an item for every rate line.` }
    if (!unitCode || !unitName) return { error: `${row}: every rate line needs a unit code and unit name.` }
    const key = `${itemId}:${unitCode}`
    if (keys.has(key)) return { error: `${row}: each item and unit code combination may appear only once.` }
    keys.add(key)

    const baseQuantity = canonicalDecimal(String(raw.baseQuantity ?? ''), 4)
    const costRate = canonicalDecimal(String(raw.costRate ?? ''), 4)
    const billRate = canonicalDecimal(String(raw.billRate ?? ''), 4)
    if (baseQuantity === null || costRate === null || billRate === null) {
      return { error: `${row}: base quantities and rates must be exact numbers with no more than four decimal places.` }
    }
    if ([baseQuantity, costRate, billRate].some((value) => wholeDigits(value) > 15)) {
      return { error: `${row}: rate amounts may contain at most 15 whole-number digits.` }
    }
    if (cmp(baseQuantity, '0') <= 0 || cmp(costRate, '0') < 0 || cmp(billRate, '0') < 0) {
      return { error: `${row}: base quantities must be positive and rates must be non-negative.` }
    }

    const baseUnit = String(raw.baseUnit ?? '').trim().toLowerCase()
    const pricingPolicy = String(raw.pricingPolicy ?? '')
    const invoicePresentation = String(raw.invoicePresentation ?? '')
    if (!baseUnit) return { error: `${row}: every rate line needs a base unit.` }
    if (!POLICIES.has(pricingPolicy)) return { error: `${row}: choose a valid pricing policy for every rate line.` }
    if (!PRESENTATIONS.has(invoicePresentation)) return { error: `${row}: choose a valid invoice presentation for every rate line.` }
    const profile = `${baseUnit}:${pricingPolicy}:${invoicePresentation}`
    if (profiles.has(itemId) && profiles.get(itemId) !== profile) {
      return { error: `${row}: all units for an item must use the same base unit, pricing policy, and invoice presentation.` }
    }
    profiles.set(itemId, profile)

    const premiums: Record<string, string> = {}
    if (raw.timeTypeBillRates != null) {
      if (typeof raw.timeTypeBillRates !== 'object' || Array.isArray(raw.timeTypeBillRates)) {
        return { error: `${row}: labor premiums must map time types to rates.` }
      }
      for (const [timeTypeId, supplied] of Object.entries(raw.timeTypeBillRates as Record<string, unknown>)) {
        if (!isUuid(timeTypeId)) return { error: `${row}: labor premium "${timeTypeId}" is not a valid time type.` }
        const rate = canonicalDecimal(String(supplied), 4)
        if (rate === null || cmp(rate, '0') < 0 || wholeDigits(rate) > 15) {
          return { error: `${row}: labor premium rates must be non-negative exact numbers with no more than four decimal places.` }
        }
        premiums[timeTypeId] = normalizeMoney(rate)
      }
    }
    lines.push({
      itemId, unitCode, unitName, baseQuantity,
      costRate: normalizeMoney(costRate), billRate: normalizeMoney(billRate),
      baseUnit, pricingPolicy, invoicePresentation, timeTypeBillRates: premiums,
    })
  }
  return { lines }
}
