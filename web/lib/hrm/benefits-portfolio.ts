/**
 * Employer-defined benefits portfolio — client-safe contract shared by the
 * Benefits cockpit builders, drawers, and their tests.
 *
 * Client vocabulary imports the public engine contracts as types only.
 * Builders send exact decimal text through the authorized domain routes.
 *
 * Existing insured benefit plans (health, retirement) stay authoritative
 * in hrm_benefit_plans. These families describe the separate
 * employer-defined program model delivered through payroll inputs or a
 * recorded external reference — never a manual net-pay edit.
 */

export const BENEFIT_PROGRAMS_API = '/api/hrm/benefit-programs'
export const BENEFIT_AWARDS_API = '/api/hrm/benefit-awards'

/**
 * Lifecycle verbs, matching the landed routes. Creation posts the
 * collection; activation, closure, and updates patch the program id route;
 * membership writes post the program id route; every award move patches
 * the award id route. The domain zod bodies own the shapes — these helpers
 * only place the id in the path.
 */
export function programResourceUrl(programId: string): string {
  return `${BENEFIT_PROGRAMS_API}/${encodeURIComponent(programId)}`
}

export function awardResourceUrl(awardId: string): string {
  return `${BENEFIT_AWARDS_API}/${encodeURIComponent(awardId)}`
}

export const PROGRAM_ACTIONS = ['create', 'update', 'activate', 'close', 'addMember', 'removeMember'] as const
export type ProgramAction = (typeof PROGRAM_ACTIONS)[number]

export const AWARD_ACTIONS = [
  'create',
  'submit',
  'queue',
  'payrollDelivery',
  'externalDelivery',
  'void',
] as const
export type AwardAction = (typeof AWARD_ACTIONS)[number]

import type {
  BenefitProgramFamily as ProgramFamily,
  BenefitProgramStatus as ProgramStatus,
  BenefitDeliveryMethod as DeliveryMethod,
  BenefitValuation as Valuation,
  BenefitMetric,
  BenefitMetricScope as MetricScope,
  BenefitAllocation as Allocation,
  BenefitFrequency as Frequency,
  BenefitPeriodBasis as PeriodBasis,
  BenefitAwardStatus as AwardStatus,
} from '@openbooks/engine/hrm/benefits/calculation'
export type { ProgramFamily, ProgramStatus, DeliveryMethod, Valuation, BenefitMetric, MetricScope, Allocation, Frequency, PeriodBasis, AwardStatus }
import { parseCivilDate } from '@openbooks/engine/hrm/benefits/calculation'
import { canonicalDecimal } from '@openbooks/engine/money/decimal'
import { decimalNullCause, suppliedValue } from '../payroll-decimal-refusal'

/** Benefits destinations separate the program catalog, employee relationships and delivery work. */
export const PORTFOLIO_VIEWS = ['overview', 'programs', 'employees', 'delivery'] as const
export type PortfolioView = (typeof PORTFOLIO_VIEWS)[number]

export function parsePortfolioView(value: string | undefined): PortfolioView {
  return value === 'programs' || value === 'employees' || value === 'delivery' ? value : 'overview'
}

/** One portfolio card: title, destination, and an optional live count. */
export interface OverviewCard {
  key: string
  title: string
  description: string
  href: string
  iconKey: string
  countLabel: string | null
}

/** Every vitals label the overview renders, resolved from the catalog. */
export interface VitalsLabels {
  activePrograms: string
  openWindows: string
  pendingApprovals: string
  queuedPayouts: string
  deliveredTitle: string
  awaitingTitle: string
  deliveredEmpty: string
  awaitingEmpty: string
  reportsTitle: string
  reportsEmpty: string
  attentionTitle: string
  attentionEmpty: string
  cardsTitle: string
}

/** Each program type opens its own native configuration form from the shared catalog. */
export interface ProgramTypeCard {
  key: 'health' | 'retirement' | 'time_off' | 'allowance' | 'reward' | 'incentive' | 'custom'
  family: ProgramFamily | null
  iconKey: string
}

export const PROGRAM_TYPE_CARDS: readonly ProgramTypeCard[] = [
  { key: 'health', family: null, iconKey: 'heart-pulse' },
  { key: 'retirement', family: null, iconKey: 'piggy-bank' },
  { key: 'time_off', family: null, iconKey: 'calendar' },
  { key: 'allowance', family: 'allowance', iconKey: 'wallet' },
  { key: 'reward', family: 'reward', iconKey: 'gift' },
  { key: 'incentive', family: 'incentive', iconKey: 'chart-line' },
  { key: 'custom', family: 'custom', iconKey: 'shapes' },
]

/**
 * The builder draft. Scalars stay strings until the server reads them;
 * scoped selections (departments, projects, source accounts) are id arrays
 * chosen from loader-resolved option lists — never hand-typed UUID text.
 */
export interface ProgramDraft {
  code: string
  name: string
  family: ProgramFamily
  description: string
  legalEntityId: string
  currency: string
  effectiveFrom: string
  effectiveTo: string
  payComponentId: string
  deliveryMethod: DeliveryMethod
  approvalMode: 'none' | 'flows'
  valuation: Valuation
  metric: '' | BenefitMetric
  metricScope: MetricScope
  scopeIds: string[]
  allocation: Allocation
  percentRate: string
  fixedAmount: string
  capAmount: string
  budgetAmount: string
  thresholdAmount: string
  frequency: Frequency
  periodBasis: '' | PeriodBasis
  paymentDelayDays: string
  sourceAccountIds: string[]
}

export function emptyProgramDraft(family: ProgramFamily): ProgramDraft {
  return {
    code: '',
    name: '',
    family,
    description: '',
    legalEntityId: '',
    currency: '',
    effectiveFrom: '',
    effectiveTo: '',
    payComponentId: '',
    deliveryMethod: 'payroll',
    approvalMode: 'none',
    valuation: family === 'incentive' ? 'pool' : 'fixed',
    metric: family === 'incentive' ? 'revenue' : '',
    metricScope: 'company',
    scopeIds: [],
    allocation: 'equal',
    percentRate: '',
    fixedAmount: '',
    capAmount: '',
    budgetAmount: '',
    thresholdAmount: '',
    frequency: 'manual',
    periodBasis: '',
    paymentDelayDays: '0',
    sourceAccountIds: [],
  }
}

function isCivilDate(value: string): boolean {
  try { parseCivilDate(value); return true } catch { return false }
}
const ISO_CURRENCY_RE = /^[A-Z]{3}$/

export type FieldErrors = Partial<Record<keyof ProgramDraft | 'form', string>>

/**
 * Client-side presence and shape checks with field-level remedies. The
 * domain service re-validates everything; these messages only stop a
 * request the server would refuse, naming the field to fix first.
 */
export function validateProgramDraft(draft: ProgramDraft): FieldErrors {
  const errors: FieldErrors = {}
  if (draft.code.trim() === '') errors.code = 'portfolio.validation.programCode'
  if (draft.legalEntityId === '') errors.legalEntityId = 'portfolio.validation.legalEntity'
  if (draft.name.trim() === '') errors.name = 'portfolio.validation.programName'
  if (!ISO_CURRENCY_RE.test(draft.currency.trim())) {
    errors.currency = 'portfolio.validation.currency'
  }
  if (!isCivilDate(draft.effectiveFrom)) {
    errors.effectiveFrom = 'portfolio.validation.effectiveFrom'
  }
  if (draft.effectiveTo.trim() !== '' && !isCivilDate(draft.effectiveTo)) {
    errors.effectiveTo = 'portfolio.validation.effectiveTo'
  }
  if (
    draft.effectiveTo.trim() !== '' &&
    isCivilDate(draft.effectiveFrom) &&
    draft.effectiveTo < draft.effectiveFrom
  ) {
    errors.effectiveTo = 'portfolio.validation.dateOrder'
  }
  if (draft.valuation === 'fixed' && draft.fixedAmount.trim() === '') {
    errors.fixedAmount = 'portfolio.validation.fixedAmount'
  }
  if (draft.valuation === 'percent' && draft.percentRate.trim() === '') {
    errors.percentRate = 'portfolio.validation.percentRate'
  }
  if (draft.valuation === 'pool' && draft.budgetAmount.trim() === '') {
    errors.budgetAmount = 'portfolio.validation.budgetAmount'
  }
  if (draft.family === 'incentive' && draft.metric === '') {
    errors.metric = 'portfolio.validation.metric'
  }
  if (draft.family === 'incentive' && draft.metricScope !== 'company' && draft.scopeIds.length === 0) {
    errors.scopeIds = 'portfolio.validation.scopeIds'
  }
  if (
    draft.family === 'incentive' &&
    draft.metric !== '' &&
    draft.metric !== 'approved_hours' &&
    draft.sourceAccountIds.length === 0
  ) {
    errors.sourceAccountIds = 'portfolio.validation.sourceAccounts'
  }
  if ((draft.frequency === 'quarterly' || draft.frequency === 'annual') && draft.periodBasis === '') {
    errors.periodBasis = 'portfolio.validation.periodBasis'
  }
  if (draft.payComponentId.trim() === '') {
    errors.payComponentId = 'portfolio.validation.payComponent'
  }
  const delay = draft.paymentDelayDays.trim()
  if (delay !== '' && !/^\d+$/.test(delay)) {
    errors.paymentDelayDays = 'portfolio.validation.paymentDelay'
  }
  return errors
}

/**
 * A draft program for edits: the loader resolves it from the authoritative
 * program row, so the builder edits server state — never a client echo.
 */
export interface ProgramEditSeed {
  id: string
  code: string
  name: string
  family: ProgramFamily
  description: string | null
  legalEntityId: string | null
  currency: string
  effectiveFrom: string
  effectiveTo: string | null
  payComponentId: string | null
  deliveryMethod: ProgramDraft['deliveryMethod']
  approvalMode: ProgramDraft['approvalMode']
  valuation: ProgramDraft['valuation']
  metric: ProgramDraft['metric']
  metricScope: ProgramDraft['metricScope']
  scopeIds: readonly string[]
  allocation: ProgramDraft['allocation']
  percentRate: string | null
  fixedAmount: string | null
  capAmount: string | null
  budgetAmount: string | null
  thresholdAmount: string | null
  frequency: ProgramDraft['frequency']
  periodBasis: PeriodBasis | null
  paymentDelayDays: number
  sourceAccountIds: readonly string[]
}

import { sum } from '@openbooks/engine/money'

/** One currency line: amounts in different currencies never merge. */
export interface CurrencyTotal {
  currency: string
  amount: string
  /** Locale-formatted in the currency's minor units. */
  display: string
}

/** Native attention-list shape (tone/text/href) plus a stable key. */
export interface AttentionItem {
  key: string
  tone: 'warning' | 'negative'
  text: string
  href: string
}

/** Sum canonical decimal values within one currency; one line per currency. */
export function totalsByCurrency(
  rows: { value: string; currency: string }[],
  amount: (value: string, currency: string) => string,
): CurrencyTotal[] {
  const byCurrency = new Map<string, string[]>()
  for (const row of rows) {
    const list = byCurrency.get(row.currency) ?? []
    list.push(row.value)
    byCurrency.set(row.currency, list)
  }
  return [...byCurrency.entries()]
    .map(([currency, values]) => {
      const total = sum(values)
      return { currency, amount: total, display: amount(total, currency) }
    })
    .sort((a, b) => (a.currency < b.currency ? -1 : 1))
}

export function portfolioHref(basePath: string, view: string | undefined, extra: Record<string, string>): string {
  const params = new URLSearchParams()
  if (view && view !== 'overview') params.set('view', view)
  for (const [key, value] of Object.entries(extra)) params.set(key, value)
  const query = params.toString()
  return query ? `${basePath}?${query}` : basePath
}

/**
 * The attention queue from loader-resolved counts. Every item names its
 * destination: an item without an operable link is a dead end, not a queue.
 */
export function buildAttentionQueue(input: {
  pendingEnrollments: number
  pendingAwards: number
  queuedAwards: number
  draftPrograms: number
  programsMissingComponent: { id: string; code: string }[]
  format: (key: string, params?: Record<string, string | number>) => string
  basePath: string
}): AttentionItem[] {
  const items: AttentionItem[] = []
  if (input.pendingEnrollments > 0) {
    items.push({
      key: 'pending-enrollments',
      tone: 'warning',
      text: input.format('portfolio.attention.pendingEnrollments', { count: input.pendingEnrollments }),
      href: portfolioHref(input.basePath, 'employees', {}),
    })
  }
  if (input.pendingAwards > 0) {
    items.push({
      key: 'pending-awards',
      tone: 'warning',
      text: input.format('portfolio.attention.pendingAwards', { count: input.pendingAwards }),
      href: '/approvals',
    })
  }
  if (input.queuedAwards > 0) {
    items.push({
      key: 'queued-awards',
      tone: 'warning',
      text: input.format('portfolio.attention.queuedAwards', { count: input.queuedAwards }),
      href: portfolioHref(input.basePath, 'delivery', {}),
    })
  }
  if (input.draftPrograms > 0) {
    items.push({
      key: 'draft-programs',
      tone: 'warning',
      text: input.format('portfolio.attention.draftPrograms', { count: input.draftPrograms }),
      href: portfolioHref(input.basePath, 'programs', {}),
    })
  }
  for (const program of input.programsMissingComponent) {
    items.push({
      key: `missing-component-${program.id}`,
      tone: 'negative',
      text: input.format('portfolio.attention.missingComponent', { code: program.code }),
      href: portfolioHref(input.basePath, 'programs', { program: program.id }),
    })
  }
  return items
}

/** A loader-resolved pick: selections are ids the service authorized. */
export interface BuilderOption {
  value: string
  label: string
}

/** Native earnings with an explicit cash or non-cash payroll representation. */
export interface BenefitPayComponentOption extends BuilderOption {
  paymentKind: 'cash' | 'non_cash'
}

export function componentsForDelivery(options: BenefitPayComponentOption[], delivery: DeliveryMethod): BenefitPayComponentOption[] {
  return options.filter((option) => option.paymentKind === (delivery === 'external' ? 'non_cash' : 'cash'))
}

/** Loader-resolved text for the program portfolio table. */
export interface UnifiedProgramRow {
  id: string
  code: string
  name: string
  family: ProgramFamily | 'health' | 'retirement' | 'time_off' | 'recovery'
  familyLabel: string
  valueLabel: string
  effectiveFrom: string | null
  effectiveTo: string | null
  statusLabel: string
  statusVariant: 'default' | 'secondary' | 'outline' | 'destructive' | 'warning' | 'success'
  programHref: string
}

export interface ProgramTableText {
  program: string
  family: string
  value: string
  effective: string
  status: string
  emptyTitle: string
  emptyDescription: string
  totalLabel: string
  truncatedLabel: string
}

/** Loader-resolved text for the award portfolio table. */
export interface AwardTableText {
  program: string
  recipient: string
  period: string
  value: string
  status: string
  emptyTitle: string
  emptyDescription: string
  totalLabel: string
  truncatedLabel: string
}

/** A recorded award: value and currency cross as typed, read by the server. */
export interface AwardDraft {
  programId: string
  employmentId: string
  periodFrom: string
  periodTo: string
  value: string
  currency: string
  reason: string
  recipientNote: string
  recordReference: string
}

export type AwardFieldErrors = Partial<Record<keyof AwardDraft | 'form', string>>

export function validateAwardDraft(draft: AwardDraft): AwardFieldErrors {
  const errors: AwardFieldErrors = {}
  if (draft.programId.trim() === '') errors.programId = 'portfolio.validation.awardProgram'
  if (draft.employmentId.trim() === '') errors.employmentId = 'portfolio.validation.awardRecipient'
  if (!isCivilDate(draft.periodFrom)) errors.periodFrom = 'portfolio.validation.periodFrom'
  if (draft.periodTo.trim() !== '' && !isCivilDate(draft.periodTo)) {
    errors.periodTo = 'portfolio.validation.periodTo'
  }
  if (isCivilDate(draft.periodFrom) && isCivilDate(draft.periodTo) && draft.periodTo < draft.periodFrom) errors.periodTo = 'portfolio.validation.dateOrder'
  if (draft.value.trim() === '') errors.value = 'portfolio.validation.awardValue'
  if (!ISO_CURRENCY_RE.test(draft.currency.trim())) {
    errors.currency = 'portfolio.validation.currency'
  }
  if (draft.reason.trim() === '') errors.reason = 'portfolio.validation.awardReason'
  return errors
}

export interface MembershipDraft {
  employmentId: string
  effectiveFrom: string
  effectiveTo: string
  weight: string
  role: string
}

export type MembershipFieldErrors = Partial<Record<keyof MembershipDraft | 'form', string>>

export function validateMembershipDraft(draft: MembershipDraft): MembershipFieldErrors {
  const errors: MembershipFieldErrors = {}
  if (draft.employmentId.trim() === '') errors.employmentId = 'portfolio.validation.memberEmployment'
  if (!isCivilDate(draft.effectiveFrom)) errors.effectiveFrom = 'portfolio.validation.membershipFrom'
  if (draft.effectiveTo.trim() !== '' && !isCivilDate(draft.effectiveTo)) {
    errors.effectiveTo = 'portfolio.validation.effectiveTo'
  }
  if (isCivilDate(draft.effectiveFrom) && isCivilDate(draft.effectiveTo) && draft.effectiveTo < draft.effectiveFrom) errors.effectiveTo = 'portfolio.validation.dateOrder'
  if (draft.weight.trim() !== '' && (canonicalDecimal(draft.weight.trim(), 4) === null || draft.weight.trim().startsWith('-') || /^0(?:\.0*)?$/.test(draft.weight.trim()))) errors.weight = 'portfolio.validation.weight'
  return errors
}

/** Translate the shared decimal classifier's remedy without changing its interpretation. */
export function decimalFieldRefusal(
  raw: string,
  field: string,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  const detail = decimalNullCause(raw)
  const params: Record<string, string | number> = { field, value: suppliedValue(raw), places: 4 }
  if ('dotted' in detail) params.dotted = detail.dotted
  if ('grouped' in detail) params.grouped = detail.grouped
  if ('symbol' in detail) params.symbol = detail.symbol
  if ('separator' in detail) params.separator = detail.separator
  return t(`portfolio.decimal.${detail.cause}`, params)
}

export function translatedFieldErrors<T extends Record<string, string | undefined>>(
  errors: T,
  t: (key: string) => string,
): T {
  return Object.fromEntries(Object.entries(errors).map(([field, key]) => [field, key ? t(key) : key])) as T
}

/** One delivery row retains its governing program and native downstream record. */
export interface BenefitDeliveryRow {
  id: string
  programName: string
  programHref: string
  employeeName: string
  employeeHref: string
  onDate: string
  valueLabel: string
  statusLabel: string
  statusVariant: 'default' | 'secondary' | 'outline' | 'destructive' | 'warning' | 'success'
  recordHref: string | null
  recordLabel: string
}
