import { fromUnits, toUnits } from '../../../../../../engine/src/money.ts'
import { canonicalDecimal, compareDecimal, isPositiveDecimal } from '../../../../../lib/exact-decimal'
import {
  blankDefinitionForm,
  type DefinitionForm,
} from './rule-drawer-form.ts'

/** Same slug contract the rules API enforces (`allocation_rules.key`). */
export const RULE_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/

export const WIZARD_STEPS = ['when', 'source', 'split', 'targets', 'policy', 'review'] as const
export type WizardStep = (typeof WIZARD_STEPS)[number]

export type AllocationWizardMode = 'entry' | 'post' | 'period'
export type WizardSplitKind = 'ratio' | 'percent' | 'driver'
export type SourceDepartmentMode = 'any' | 'untagged' | 'specific'
export type TargetDimension = 'department' | 'location' | 'class' | 'project'

export const TARGET_DIMENSIONS: readonly TargetDimension[] = [
  'department',
  'location',
  'class',
  'project',
]

/**
 * Document kinds the wizard offers as "transaction type". The values are the
 * stored `documents.kind` slugs; labels come from `common.transactionTypes`.
 */
export const WIZARD_DOCUMENT_KINDS = [
  { kind: 'vendor_bill', labelKey: 'vendorBill' },
  { kind: 'vendor_credit', labelKey: 'vendorCredit' },
  { kind: 'customer_invoice', labelKey: 'customerInvoice' },
  { kind: 'customer_credit', labelKey: 'customerCredit' },
  { kind: 'journal', labelKey: 'journal' },
  { kind: 'check', labelKey: 'check' },
  { kind: 'card_charge', labelKey: 'cardCharge' },
  { kind: 'expense_report', labelKey: 'expenseReport' },
] as const

export type WizardDocumentKind = (typeof WIZARD_DOCUMENT_KINDS)[number]['kind']

export interface WizardTargetRow {
  valueId: string
  weight: string
}

export interface WizardDriver {
  id: string
  key: string
  name: string
  dimension: string
  isActive: boolean
}

/** Draft answers the wizard writes through the existing rule APIs. */
export interface WizardDraft {
  mode: AllocationWizardMode
  name: string
  key: string
  description: string
  documentKinds: WizardDocumentKind[]
  sourceDepartmentMode: SourceDepartmentMode
  sourceDepartmentIds: string[]
  splitKind: WizardSplitKind
  driverId: string
  targetDimension: TargetDimension
  targets: WizardTargetRow[]
  applyPolicy: 'automatic' | 'suggest' | 'manual'
  impact: 'reclass' | 'net_zero_pair'
  sourceMeasure: 'period_activity' | 'period_end_balance'
  runPolicy: 'manual' | 'auto_preview'
  publishNow: boolean
}

const HUNDRED_UNITS = toUnits('100')

export function defaultWizardDraft(): WizardDraft {
  return {
    mode: 'entry',
    name: '',
    key: '',
    description: '',
    documentKinds: [],
    sourceDepartmentMode: 'specific',
    sourceDepartmentIds: [],
    splitKind: 'ratio',
    driverId: '',
    targetDimension: 'department',
    targets: [
      { valueId: '', weight: '1' },
      { valueId: '', weight: '2' },
      { valueId: '', weight: '3' },
      { valueId: '', weight: '4' },
    ],
    applyPolicy: 'automatic',
    impact: 'reclass',
    sourceMeasure: 'period_activity',
    runPolicy: 'manual',
    publishNow: true,
  }
}

/** Lowercase slug matching `RULE_KEY_PATTERN`, or `allocation` when the name has no usable characters. */
export function keyFromName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return RULE_KEY_PATTERN.test(slug) ? slug : 'allocation'
}

export function isRuleKey(value: string): boolean {
  return RULE_KEY_PATTERN.test(value)
}

/** Strip trailing zeros without crossing a float: "10.0000" → "10", "33.3330" → "33.333". */
export function trimDecimal(value: string): string {
  if (!value.includes('.')) return value
  const trimmed = value.replace(/\.?0+$/, '')
  return trimmed === '' || trimmed === '-' ? '0' : trimmed
}

function weightUnits(value: string): bigint | null {
  const canonical = canonicalDecimal(value, 4)
  if (canonical === null || !isPositiveDecimal(canonical)) return null
  try {
    return toUnits(canonical)
  } catch {
    return null
  }
}

/**
 * Turn relative weights (1, 2, 3, 4) into fixed percents that sum to 100
 * exactly. Floor every share and place the leftover on the last positive
 * weight so a 1:1:1 split becomes 33.3333 / 33.3333 / 33.3334, never a float.
 */
export function ratioToFixedPercents(weights: string[]): string[] {
  const units = weights.map((weight) => weightUnits(weight))
  if (units.some((unit) => unit === null)) {
    throw new Error('every share needs a positive decimal weight')
  }
  const parsed = units as bigint[]
  const total = parsed.reduce((sum, unit) => sum + unit, 0n)
  if (total <= 0n) throw new Error('weights must sum to more than zero')
  const floors = parsed.map((unit) => (unit * HUNDRED_UNITS) / total)
  const used = floors.reduce((sum, unit) => sum + unit, 0n)
  floors[floors.length - 1] = (floors[floors.length - 1] ?? 0n) + (HUNDRED_UNITS - used)
  return floors.map((unit) => fromUnits(unit))
}

/** Sum of canonical 4dp percents, or null when any input is not a positive decimal. */
export function percentInputsSum(values: string[]): string | null {
  const units = values.map((value) => weightUnits(value))
  if (units.some((unit) => unit === null) || units.length === 0) return null
  return fromUnits((units as bigint[]).reduce((sum, unit) => sum + unit, 0n))
}

export function percentsSumToHundred(values: string[]): boolean {
  const total = percentInputsSum(values)
  return total !== null && compareDecimal(total, '100') === 0
}

/** Preview a 1,000.00 line split — leftover units land on the last share. */
export function previewSplitAmounts(total: string, weights: string[]): string[] {
  const units = weights.map((weight) => weightUnits(weight))
  if (units.some((unit) => unit === null)) return []
  const parsed = units as bigint[]
  const weightTotal = parsed.reduce((sum, unit) => sum + unit, 0n)
  if (weightTotal <= 0n) return []
  let totalUnits: bigint
  try {
    totalUnits = toUnits(total)
  } catch {
    return []
  }
  const floors = parsed.map((unit) => (totalUnits * unit) / weightTotal)
  const used = floors.reduce((sum, unit) => sum + unit, 0n)
  floors[floors.length - 1] = (floors[floors.length - 1] ?? 0n) + (totalUnits - used)
  return floors.map((unit) => fromUnits(unit))
}

export function hrefWithRule(closeHref: string, ruleId: string): string {
  const qIndex = closeHref.indexOf('?')
  const path = qIndex < 0 ? closeHref : closeHref.slice(0, qIndex)
  const query = qIndex < 0 ? '' : closeHref.slice(qIndex + 1)
  const params = new URLSearchParams(query)
  params.set('rule', ruleId)
  const serialized = params.toString()
  return serialized === '' ? path : `${path}?${serialized}`
}

export function filledTargets(draft: WizardDraft): WizardTargetRow[] {
  return draft.targets.filter((row) => row.valueId !== '' && weightUnits(row.weight) !== null)
}

export function nextTargetWeight(draft: WizardDraft): string {
  return String(draft.targets.length + 1)
}

export function defaultSourceDepartmentMode(mode: AllocationWizardMode): SourceDepartmentMode {
  if (mode === 'period') return 'untagged'
  if (mode === 'post') return 'any'
  return 'specific'
}

export function wizardUsesExplicitTargets(draft: WizardDraft): boolean {
  return draft.splitKind !== 'driver'
}

/** Whether the current step has enough answers to advance. */
export function wizardStepComplete(step: WizardStep, draft: WizardDraft): boolean {
  switch (step) {
    case 'when':
      return draft.mode === 'entry' || draft.mode === 'post' || draft.mode === 'period'
    case 'source':
      if (draft.name.trim() === '' || !isRuleKey(draft.key)) return false
      if (draft.sourceDepartmentMode === 'specific') return draft.sourceDepartmentIds.length > 0
      return true
    case 'split':
      if (draft.splitKind === 'driver') return draft.driverId !== ''
      return draft.splitKind === 'ratio' || draft.splitKind === 'percent'
    case 'targets':
      if (!wizardUsesExplicitTargets(draft)) return draft.driverId !== ''
      {
        const rows = filledTargets(draft)
        if (rows.length < 2) return false
        if (draft.splitKind === 'percent') return percentsSumToHundred(rows.map((row) => row.weight))
        return true
      }
    case 'policy':
    case 'review':
      return wizardStepComplete('source', draft) && wizardStepComplete('split', draft) && wizardStepComplete('targets', draft)
  }
}

function targetDimensionField(dimension: TargetDimension): 'departmentId' | 'locationId' | 'classId' | 'projectId' {
  switch (dimension) {
    case 'department':
      return 'departmentId'
    case 'location':
      return 'locationId'
    case 'class':
      return 'classId'
    case 'project':
      return 'projectId'
  }
}

export function wizardTargetPercents(draft: WizardDraft): string[] {
  const rows = filledTargets(draft)
  if (draft.splitKind === 'percent') return rows.map((row) => fromUnits(weightUnits(row.weight)!))
  return ratioToFixedPercents(rows.map((row) => row.weight))
}

/** Draft version fields — same shape the Definition tab PATCHes. */
export function wizardDefinitionForm(draft: WizardDraft, effectiveFrom: string, driver: WizardDriver | null): DefinitionForm {
  const form = blankDefinitionForm()
  form.effectiveFrom = effectiveFrom
  form.documentKinds = [...draft.documentKinds]
  form.applyPolicy = draft.mode === 'entry' ? draft.applyPolicy : 'manual'
  form.sourceMeasure = draft.sourceMeasure
  form.impact = draft.impact
  form.residualPolicy = 'largest_share'
  form.solveMethod = 'sequential'
  form.runPolicy = draft.mode === 'period' ? draft.runPolicy : 'manual'
  form.runOffsetDays = '0'
  if (draft.sourceDepartmentMode === 'specific') {
    form.filterDepartmentIds = [...draft.sourceDepartmentIds]
  } else if (draft.sourceDepartmentMode === 'untagged') {
    form.requireUntagged = ['department']
  }
  if (draft.splitKind === 'driver' && driver) {
    form.basisKind = 'driver'
    form.driverId = driver.id
    form.driverAsOf = draft.mode === 'period' ? 'period' : 'document_date'
    form.targetKind = 'dynamic'
    form.dynamicDimension = knownDriverDimension(driver.dimension) ? driver.dimension : ''
    form.dynamicMinWeight = '0'
  } else {
    form.basisKind = 'fixed_percent'
    form.driverId = ''
    form.targetKind = 'explicit'
  }
  return form
}

/** Explicit targets PUT body — percents always, so entry/post/period share one basis. */
export function wizardTargetPayload(draft: WizardDraft): Record<string, unknown>[] {
  const rows = filledTargets(draft)
  const percents = wizardTargetPercents(draft)
  const field = targetDimensionField(draft.targetDimension)
  return rows.map((row, index) => ({
    sequence: index,
    targetAccountId: null,
    departmentId: field === 'departmentId' ? row.valueId : null,
    locationId: field === 'locationId' ? row.valueId : null,
    classId: field === 'classId' ? row.valueId : null,
    projectId: field === 'projectId' ? row.valueId : null,
    subsidiaryId: null,
    extraDims: {},
    fixedPercent: percents[index] ?? null,
    weight: null,
    isRemainder: false,
    label: null,
  }))
}

export function knownDriverDimension(dimension: string): dimension is TargetDimension | 'subsidiary' {
  return (
    dimension === 'department'
    || dimension === 'location'
    || dimension === 'class'
    || dimension === 'project'
    || dimension === 'subsidiary'
  )
}
