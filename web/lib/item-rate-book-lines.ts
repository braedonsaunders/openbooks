import { cmp, normalizeMoney } from '@openbooks/engine/src/money/money.ts'
import { parseItemRateDecimal } from './item-rate-numerics'
import { isUuid } from './list-params'

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
  /** 1-based position in the submitted array, for refusal labels. */
  rowNumber: number
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
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return { error: `${row}: rate line must be an object.` }
    }
    if (isBlankRateBookLine(raw)) continue
    const itemId = String(raw.itemId ?? '').trim()
    const unitCode = String(raw.unitCode ?? '').trim().toLowerCase()
    const unitName = String(raw.unitName ?? '').trim()
    if (!isUuid(itemId)) return { error: `${row}: choose an item for every rate line.` }
    if (!unitCode || !unitName) return { error: `${row}: every rate line needs a unit code and unit name.` }
    const key = `${itemId}:${unitCode}`
    if (keys.has(key)) return { error: `${row}: each item and unit code combination may appear only once.` }
    keys.add(key)

    const parsedQuantity = parseItemRateDecimal(raw.baseQuantity)
    const parsedCost = parseItemRateDecimal(raw.costRate)
    const parsedBill = parseItemRateDecimal(raw.billRate)
    const entries = [parsedQuantity, parsedCost, parsedBill]
    if (entries.some((entry) => 'error' in entry && entry.error !== 'too-wide')) {
      return { error: `${row}: base quantities and rates must be exact numbers with no more than four decimal places.` }
    }
    if (entries.some((entry) => 'error' in entry)) {
      return { error: `${row}: rate amounts may contain at most 15 whole-number digits.` }
    }
    // Every error returned above, so each entry holds a value; the check
    // below only narrows the union for the compiler.
    if ('error' in parsedQuantity || 'error' in parsedCost || 'error' in parsedBill) {
      return { error: `${row}: rate amounts may contain at most 15 whole-number digits.` }
    }
    const baseQuantity = parsedQuantity.value
    const costRate = parsedCost.value
    const billRate = parsedBill.value
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

    // Premium CONTENT (org membership, values) validates through the shared
    // validator in the route, which overwrites timeTypeBillRates below. The
    // structural checks stay here so malformed maps refuse by row early.
    if (raw.timeTypeBillRates != null) {
      if (typeof raw.timeTypeBillRates !== 'object' || Array.isArray(raw.timeTypeBillRates)) {
        return { error: `${row}: labor premiums must map time types to rates.` }
      }
      for (const timeTypeId of Object.keys(raw.timeTypeBillRates)) {
        if (!isUuid(timeTypeId)) return { error: `${row}: labor premium "${timeTypeId}" is not a valid time type.` }
      }
    }
    lines.push({
      rowNumber: position, itemId, unitCode, unitName, baseQuantity,
      costRate: normalizeMoney(costRate), billRate: normalizeMoney(billRate),
      baseUnit, pricingPolicy, invoicePresentation, timeTypeBillRates: {},
    })
  }
  return { lines }
}
