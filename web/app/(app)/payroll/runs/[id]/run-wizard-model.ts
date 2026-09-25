/** Split from RunWizard.tsx (ARCH-FILE-SPLIT; pure moves only). */
import type { useTranslations } from 'next-intl'
import { decimalSum } from '../../../../../lib/statement-format'
import { bucketAmounts, type RegisterBucket } from '../../../../../lib/payroll-register-buckets'

export type WizardStep = 'period' | 'readiness' | 'review' | 'gl' | 'finish'

/**
 * English fallbacks for codes whose message has not landed in web/messages yet.
 * This screen decides whether a payday is safe to run; a raw message key in
 * place of a blocker or a warning is not an acceptable degradation. Delete an
 * entry the moment its real key exists — `t.has` prefers the translation, so a
 * stale entry is unreachable code that still has to be read and maintained.
 *
 * Empty is the correct steady state: every readiness code the engine emits now
 * has a message under `payroll.wizard.readiness.codes`.
 */
export const READINESS_CODE_FALLBACK: Record<string, (count: number, detail: string) => string> = {}

export const STALE_REASON_FALLBACK: Record<string, string> = {
  missing: 'the run itself',
  components: 'employee pay components',
  componentDefinitions: 'pay component setup',
  derivedRules: 'derived earnings rules',
  entitlements: 'pay banks',
  workerComp: "workers' compensation rates",
  settings: 'payroll settings',
  ytd: "another run's year-to-date",
}

export interface ReadinessItem {
  severity: 'blocker' | 'warning'
  code: string
  employees: { partyId: string; name: string }[]
  detail?: string
  href?: string
}

export interface Readiness {
  items: ReadinessItem[]
  blockers: number
  warnings: number
  included: number
}

export interface Staleness {
  stale: boolean
  reasons: string[]
  calculatedAt: string | null
}

export interface Funding {
  netPay: string
  /** Net pay split by how it leaves the bank — a controller funds each rail differently. */
  rails: { method: 'eft' | 'cheque'; netPay: string; employees: number }[]
  liabilities: string
  totalCost: string
  payDate: string
  businessDaysToPayDate: number
  accounts: { id: string; label: string; balance: string; sufficient: boolean }[]
}

export interface StubChange {
  employeePartyId: string
  employeeName: string
  previousPayDate: string | null
  netDelta: string
  grossDelta: string
  hoursDelta: string
  changes: {
    kind: 'added' | 'removed' | 'changed'
    component: string
    from: string | null
    to: string | null
  }[]
}

export type RunHeader = {
  document_id: string
  document_number: string
  document_status: string
  currency: string
  /** Legal entity the run books into; null on legacy entityless runs. */
  subsidiary_id: string | null
  posted_entry_id: string | null
  paid_at: string | null
  paid_entry_id: string | null
  schedule_name: string | null
  period_start: string
  period_end: string
  pay_date: string
  tax_year: number
  run_status: 'draft' | 'calculated' | 'committed'
  run_type: 'regular' | 'bonus' | 'termination'
  pay_schedule_id: string
  gross_total: string
  net_total: string
  employer_cost_total: string
  employee_count: number
};

export type StubRow = {
  id: string
  employee_party_id: string
  employee_name: string
  province: string
  /** Employee payroll-profile country (CA/US), for pack-driven presentation. */
  country: string | null
  gross: string
  net_pay: string
  employer_cost: string
  vacation_accrued: string
  pensionable_earnings: string
  insurable_earnings: string
  factors: Record<string, string>
  lines: {
    stub_id: string
    kind: 'earning' | 'deduction' | 'employer_contribution'
    description: string
    hours: string | null
    rate: string | null
    amount: string
    sequence: number
    component_code: string | null
    project_name: string | null
    department_name: string | null
  }[]
};

export type RosterRow = {
  employee_party_id: string
  name: string
  pay_basis: 'hourly' | 'salary'
  approved_hours: string
  has_wage: boolean
  department: string | null
  trade: string | null
  job_title: string | null
  subsidiary: string | null
  /** Resolved by the engine's one ladder — how this pay will leave the bank. */
  payment_method: 'eft' | 'cheque'
  terminated_on: string | null
  hired_on: string | null
  /** Another committed run's period already covers this one — double-pay risk. */
  paid_in_period: boolean
};

export type RemittanceRow = {
  account_label: string
  amount: string
};

export interface GlLeg {
  accountId: string
  accountLabel: string
  amount: string
  partyId: string | null
  partyName: string | null
  projectId: string | null
  projectName: string | null
  departmentId: string | null
  description: string
}

export interface AdjustmentRow {
  id: string
  employee_party_id: string
  adjustment_type: 'line' | 'exclude'
  component_id: string | null
  amount: string | null
  hours: string | null
  replace_component: boolean
  note: string | null
  employee_name: string
  component_name: string | null
}

export interface ComponentOption {
  id: string
  code: string
  name: string
  kind: string
}

/**
 * The dimensions the Scope step filters on. These are the axes the roster
 * genuinely carries — department was never "dimensions", and a schedule where
 * nobody has one is not a schedule with no way to slice its people.
 */
export const ROSTER_DIMENSIONS = ['department', 'trade', 'job_title', 'subsidiary', 'payment_method'] as const
export type RosterDimension = (typeof ROSTER_DIMENSIONS)[number]

/** Distinct values of one axis, with how many people carry each. */
export function dimensionOptions(
  roster: RosterRow[],
  axis: RosterDimension,
  label: (value: string) => string,
): { value: string; label: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const row of roster) {
    const value = row[axis]
    if (!value) continue
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([value, count]) => ({ value, label: label(value), count }))
}

/** Net-pay variance beyond this (either direction) flags a stub for review. */
export const VARIANCE_FLAG_PERCENT = 15

/**
 * The only trace factors NO pack declares: the deduction-protection
 * shortfall keys stamped by the generic pay-run engine itself
 * (engine/src/payroll/run.ts), not by any country's statutory engine.
 * Everything else resolves through the run's pack-declared `factorLabels`
 * prop — a flat web-layer map keyed by short codes could not tell
 * California's CA_TAX from Canada's CA, so it is gone.
 */
export const GENERIC_FACTOR_LABELS: Record<string, string> = {
  PROT_SHORT: 'Protected-earnings shortfall (unpaid this period)',
}

/**
 * Withholding splits surfaced as stub-roster columns, read off the stub's
 * own deduction lines through the pack-declared buckets (F-t08-012) — never
 * off hardcoded CA factor keys, which read zero on a US run while the money
 * hides in the pay lines. Returns per-bucket amounts plus their total, the
 * TAX column: total withholding for the stub.
 */
export function withholding(stub: StubRow, buckets: readonly RegisterBucket[]) {
  const amounts = bucketAmounts(
    stub.lines.map((line) => ({ componentCode: line.component_code, kind: line.kind, amount: line.amount })),
    buckets,
  )
  return { amounts, total: decimalSum(amounts) }
}

/**
 * The run type's label, or the raw type when a locale has not caught up.
 *
 * A run type is added by the engine and translated afterwards (retro pay is the
 * current example). next-intl renders a missing key as its own dotted PATH, and
 * "payroll.runType.retro" on the one screen that decides whether a payday is
 * safe to run is worse than the bare word.
 */
export function runTypeLabel(
  t: ReturnType<typeof useTranslations<'payroll'>>,
  runType: string,
): string {
  const key = `runType.${runType}`
  return t.has(key as never) ? t(key as never) : runType
}
