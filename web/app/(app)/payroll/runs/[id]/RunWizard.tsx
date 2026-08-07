'use client'

import { Fragment, useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import {
  AlertTriangle,
  ArrowRight,
  Beaker,
  BookOpenCheck,
  Calculator,
  Check,
  CheckCircle2,
  ChevronRight,
  FileDown,
  Loader2,
  RefreshCw,
  Send,
} from 'lucide-react'
import {
  Badge,
  Button,
  Drawer,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  cn,
} from '@openbooks/ui'
import { useMoney } from '../../../../../components/money-provider'
import { PagedTable, type PagedColumn } from '../../../../../components/paged-table'
import { RunStatusBadge, runDisplayStatus } from '../../_ui/run-status'

export type WizardStep = 'period' | 'readiness' | 'review' | 'gl' | 'finish'

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

export interface RunHeader {
  document_id: string
  document_number: string
  document_status: string
  currency: string
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
}

export interface StubRow {
  id: string
  employee_party_id: string
  employee_name: string
  province: string
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
}

export interface RosterRow {
  employee_party_id: string
  name: string
  pay_basis: 'hourly' | 'salary'
  approved_hours: string
  has_wage: boolean
  department: string | null
  terminated_on: string | null
  hired_on: string | null
  /** Another committed run's period already covers this one — double-pay risk. */
  paid_in_period: boolean
}

export interface RemittanceRow {
  account_label: string
  amount: string
}

interface GlLeg {
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

/** Net-pay variance beyond this (either direction) flags a stub for review. */
const VARIANCE_FLAG_PERCENT = 15

/**
 * Human names for the statutory trace factors (CRA T4127 notation + the US
 * Pub 15-T trace). Domain constants, not UI copy — the CRA/IRS letter codes
 * stay visible beside them so the trace still maps to the guides.
 */
const FACTOR_LABELS: Record<string, string> = {
  // Inputs
  I: 'Periodic income this period',
  B: 'Bonus / non-periodic pay this period',
  PI: 'Pensionable earnings this period',
  IE: 'Insurable earnings this period',
  PROT_SHORT: 'Protected-earnings shortfall (unpaid this period)',
  // CRA T4127
  A: 'Annual taxable income',
  A_step2: 'Annual taxable income excluding this bonus',
  C: 'CPP/QPP contribution',
  C2: 'Second additional CPP/QPP (CPP2)',
  EI: 'EI premium',
  EI_ER: 'EI premium (employer)',
  QPIP: 'QPIP premium',
  QPIP_ER: 'QPIP premium (employer)',
  WCB: "Workers' compensation premium (employer)",
  WCB_EARN: "Workers' compensation assessable earnings",
  EHT: 'Employer Health Tax',
  EHT_EARN: 'EHT remuneration (Ontario)',
  F5: 'Enhanced-CPP tax deduction',
  F5A: 'Enhanced-CPP deduction on periodic pay',
  F5B: 'Enhanced-CPP deduction on the bonus',
  TC: 'Federal TD1 claim amount',
  TCP: 'Provincial TD1 claim amount',
  K1: 'Federal personal credit',
  K2: 'Federal CPP/EI credit',
  K4: 'Canada employment amount credit',
  K1P: 'Provincial personal credit',
  K2P: 'Provincial CPP/EI credit',
  K4P: 'Provincial employment amount credit',
  K5P: 'Provincial supplemental credit',
  T3: 'Basic federal tax (annual)',
  T1: 'Federal tax (annual)',
  T4: 'Basic provincial tax (annual)',
  V1: 'Ontario surtax',
  V2: 'Ontario Health Premium',
  S: 'Provincial tax reduction',
  T2: 'Provincial tax (annual)',
  T: 'Income tax this period',
  TB: 'Tax on the bonus (payable now)',
  // IRS Pub 15-T
  AAWA: 'Annual adjusted wage amount',
  FIT: 'Federal income tax this period',
  FIT_S: 'Federal tax on supplemental wages',
  SS: 'Social Security tax',
  SS_TAXABLE: 'Social Security taxable wages',
  MED: 'Medicare tax',
  MED2: 'Additional Medicare tax',
  FUTA: 'Federal unemployment (employer)',
  SUTA: 'State unemployment (employer)',
  TW: 'Taxable wages this period',
  TWP: 'Projected annual taxable wages',
}

/** Statutory splits surfaced as stub-roster columns, read off the factors trace. */
function statutory(stub: StubRow) {
  const f = stub.factors ?? {}
  // C/C2 = employee CPP, EI = employee EI, T/TB = periodic + bonus tax.
  return { cpp: add(f.C, f.C2), ei: f.EI ?? '0', tax: add(f.T, f.TB) }
}

function add(a?: string, b?: string): string {
  const n = (Number(a ?? 0) || 0) + (Number(b ?? 0) || 0)
  return n.toFixed(2)
}

/**
 * The pay-run wizard: four steps rendered as freely-navigable chips (no forced
 * linear march) — Period & employees → Review stubs → GL preview & commit →
 * Post & finish. Completion derives from run_status + the document's posted
 * state; the GL step shows the exact journal BEFORE anything posts.
 */
export function RunWizard(props: {
  run: RunHeader
  stubs: StubRow[]
  roster: RosterRow[]
  adjustments: AdjustmentRow[]
  adjustableComponents: ComponentOption[]
  /** employee_party_id → net pay on the employee's previous committed stub. */
  previousNet: Record<string, string>
  /** Credit legs by account from the committed document lines (negative). */
  remittance: RemittanceRow[]
  bankAccounts: { id: string; label: string }[]
  /** The seeded 'payroll-register' report definition (full report engine). */
  registerReportId: string | null
  /** Engine-computed pre-flight: what blocks the run, what to look at. */
  readiness: Readiness
  /** Whether the stubs still reflect the inputs they were built from. */
  staleness: Staleness
  /** Cash required for the payday, against each bank account's balance. */
  funding: Funding
  /** Per-employee change since the previous committed stub. */
  changes: StubChange[]
  canRun: boolean
  initialStep: WizardStep
}) {
  const t = useTranslations('payroll')
  const router = useRouter()
  const { money } = useMoney()
  const run = props.run
  const currency = run.currency
  const fmt = useCallback(
    (value: string | number | null | undefined) => money(value ?? '0', { currency }),
    [money, currency],
  )

  const [step, setStep] = useState<WizardStep>(props.initialStep)
  const [busy, setBusy] = useState(false)
  const [calcErrors, setCalcErrors] = useState<{ employee: string; message: string }[]>([])
  const [dry, setDry] = useState<{
    employees: number
    gross: string
    net: string
    employerCost: string
    errors: { employee: string; message: string }[]
  } | null>(null)
  const [gl, setGl] = useState<{
    state: 'idle' | 'loading' | 'ready' | 'setup-error'
    legs: GlLeg[]
    debitTotal: string
    error: string
  }>({ state: 'idle', legs: [], debitTotal: '0', error: '' })

  const posted = run.document_status === 'posted'
  const voided = run.document_status === 'void' || run.document_status === 'voided'
  const docDraft = run.document_status === 'draft'
  const calculated = run.run_status !== 'draft'
  const committed = run.run_status === 'committed'

  const blocked = props.readiness.blockers > 0
  const canCalculate = props.canRun && docDraft && run.run_status !== 'committed' && !blocked
  // Stale stubs must never be committed: recalculate first, always.
  const canCommit =
    props.canRun && docDraft && run.run_status === 'calculated' && !props.staleness.stale
  const canPost =
    props.canRun && committed && (run.document_status === 'draft' || run.document_status === 'approved')

  /** Step completion, derived — never client-side bookkeeping. */
  const complete: Record<WizardStep, boolean> = {
    period: calculated,
    readiness: !blocked,
    review: calculated,
    gl: committed || posted,
    finish: posted,
  }

  const loadGlPreview = useCallback(async () => {
    setGl((g) => ({ ...g, state: 'loading' }))
    try {
      const res = await fetch(`/api/payroll/runs/${run.document_id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'preview-gl' }),
      })
      const j = await res.json()
      if (!res.ok) {
        setGl({ state: 'setup-error', legs: [], debitTotal: '0', error: j.error ?? 'failed' })
        return
      }
      setGl({ state: 'ready', legs: j.legs ?? [], debitTotal: j.debitTotal ?? '0', error: '' })
    } catch (e) {
      setGl({ state: 'setup-error', legs: [], debitTotal: '0', error: (e as Error).message })
    }
  }, [run.document_id])

  // The GL step self-loads whenever it becomes visible with calculated stubs.
  useEffect(() => {
    if (step === 'gl' && calculated && gl.state === 'idle') void loadGlPreview()
  }, [step, calculated, gl.state, loadGlPreview])

  async function act(action: 'calculate' | 'commit') {
    setBusy(true)
    try {
      const res = await fetch(`/api/payroll/runs/${run.document_id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error ?? 'failed')
      if (action === 'calculate') {
        setCalcErrors(Array.isArray(j.errors) ? j.errors : [])
        setGl({ state: 'idle', legs: [], debitTotal: '0', error: '' })
        setStep('review')
      } else {
        setStep('finish')
      }
      toast.success(t(`run.${action}Done`))
      router.refresh()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  /**
   * Test calculation: the engine does the whole run and rolls it back, so the
   * operator can see the totals and every exception without touching the run.
   */
  async function dryRun() {
    setBusy(true)
    try {
      const res = await fetch(`/api/payroll/runs/${run.document_id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'dry-run' }),
      })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error ?? 'failed')
      setDry({
        employees: j.employees ?? 0,
        gross: j.gross ?? '0',
        net: j.net ?? '0',
        employerCost: j.employerCost ?? '0',
        errors: Array.isArray(j.errors) ? j.errors : [],
      })
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  /** Apply an input adjustment, then recalculate so the stubs stay truthful. */
  /** Persist the run's employee scope, then recalculate if stubs exist. */
  async function setScope(includedPartyIds: string[], rosterPartyIds: string[]) {
    setBusy(true)
    try {
      const res = await fetch(`/api/payroll/runs/${run.document_id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-scope', employeePartyIds: includedPartyIds, rosterPartyIds }),
      })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error ?? 'failed')
      if (calculated) {
        const recalc = await fetch(`/api/payroll/runs/${run.document_id}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'calculate' }),
        })
        const rj = await recalc.json()
        if (!recalc.ok) throw new Error(rj.error ?? 'failed')
        setCalcErrors(Array.isArray(rj.errors) ? rj.errors : [])
        setGl({ state: 'idle', legs: [], debitTotal: '0', error: '' })
      }
      toast.success(t('wizard.period.scopeSaved', { count: includedPartyIds.length }))
      router.refresh()
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function adjust(body: Record<string, unknown>) {
    setBusy(true)
    try {
      const res = await fetch(`/api/payroll/runs/${run.document_id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error ?? 'failed')
      const recalc = await fetch(`/api/payroll/runs/${run.document_id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'calculate' }),
      })
      const rj = await recalc.json()
      if (!recalc.ok) throw new Error(rj.error ?? 'failed')
      setCalcErrors(Array.isArray(rj.errors) ? rj.errors : [])
      setGl({ state: 'idle', legs: [], debitTotal: '0', error: '' })
      toast.success(t('wizard.adjust.applied'))
      router.refresh()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function emailStubs() {
    setBusy(true)
    try {
      const res = await fetch(`/api/payroll/runs/${run.document_id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'email-stubs' }),
      })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error ?? 'failed')
      const skipped = [...(j.noEmail ?? []), ...(j.failed ?? []).map((f: { name: string }) => f.name)]
      if (skipped.length > 0) {
        toast.warning(t('wizard.finish.stubsEmailedPartial', { sent: j.sent, skipped: skipped.join(', ') }))
      } else {
        toast.success(t('wizard.finish.stubsEmailed', { sent: j.sent }))
      }
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function recordPayment(bankAccountId: string) {
    setBusy(true)
    try {
      const res = await fetch(`/api/payroll/runs/${run.document_id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'record-payment', bankAccountId }),
      })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error ?? 'failed')
      toast.success(t('wizard.finish.paymentRecorded'))
      router.refresh()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function post() {
    setBusy(true)
    try {
      const res = await fetch('/api/documents/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'post', documentId: run.document_id }),
      })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error ?? 'failed')
      toast.success(t('run.postDone'))
      router.refresh()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const steps: { key: WizardStep; label: string }[] = [
    { key: 'period', label: t('wizard.steps.period') },
    { key: 'readiness', label: t('wizard.steps.readiness') },
    { key: 'review', label: t('wizard.steps.review') },
    { key: 'gl', label: t('wizard.steps.gl') },
    { key: 'finish', label: t('wizard.steps.finish') },
  ]

  return (
    <div className="space-y-4">
      {/* Run vitals strip */}
      <div className="flex flex-wrap items-center gap-4 text-sm text-slate-600 dark:text-slate-300">
        <RunStatusBadge status={runDisplayStatus(run)} />
        {run.run_type !== 'regular' && (
          <Badge variant="secondary">{t(`runType.${run.run_type}`)}</Badge>
        )}
        <span>
          {t('columns.payDate')}: <span className="font-medium tabular-nums">{run.pay_date}</span>
        </span>
        <span>
          {t('columns.gross')}: <span className="font-medium tabular-nums">{fmt(run.gross_total)}</span>
        </span>
        <span>
          {t('columns.net')}: <span className="font-medium tabular-nums">{fmt(run.net_total)}</span>
        </span>
        <span>
          {t('run.employerCost')}: <span className="font-medium tabular-nums">{fmt(run.employer_cost_total)}</span>
        </span>
        <span>
          {t('columns.employees')}: <span className="font-medium tabular-nums">{run.employee_count}</span>
        </span>
      </div>

      {voided && (
        <div className="flex items-center gap-3 rounded-xl border border-red-200/80 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-800/60 dark:bg-red-950/40 dark:text-red-300">
          <AlertTriangle size={16} aria-hidden />
          {t('wizard.voided')}
        </div>
      )}

      {/* Stale stubs: an input moved after the last calculation. Commit is
          disabled until the run is recalculated — the figures on screen are
          not the figures the inputs now produce. */}
      {props.staleness.stale && !committed && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200/80 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-300">
          <span className="flex items-center gap-2">
            <RefreshCw size={16} aria-hidden />
            {t('wizard.stale.title', {
              reasons: props.staleness.reasons.map((r) => t(`wizard.stale.reason.${r}`)).join(', '),
            })}
          </span>
          {canCalculate && (
            <Button size="sm" disabled={busy} onClick={() => act('calculate')}>
              {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Calculator size={14} aria-hidden />}
              {t('wizard.period.recalculate')}
            </Button>
          )}
        </div>
      )}

      {/* Step chips — every step stays clickable (unlike a forced-linear wizard). */}
      <ol className="flex flex-wrap items-center gap-2" aria-label={t('wizard.stepsAria')}>
        {steps.map((item, index) => {
          const isCurrent = step === item.key
          const isDone = complete[item.key]
          return (
            <li key={item.key} className="flex items-center gap-2">
              {index > 0 && <ChevronRight size={14} aria-hidden className="text-slate-300 dark:text-slate-700" />}
              <button
                type="button"
                onClick={() => setStep(item.key)}
                aria-current={isCurrent ? 'step' : undefined}
                className={cn(
                  'inline-flex items-center gap-2 rounded-full border py-1.5 pr-3.5 pl-1.5 text-sm font-medium transition-colors',
                  isCurrent
                    ? 'border-teal-600 bg-teal-600 text-white shadow-sm dark:border-teal-500 dark:bg-teal-600'
                    : 'border-slate-200 bg-white text-slate-600 hover:border-teal-300 hover:text-teal-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300 dark:hover:border-teal-700 dark:hover:text-teal-300',
                )}
              >
                <span
                  className={cn(
                    'grid h-6 w-6 place-items-center rounded-full text-xs font-semibold',
                    isCurrent
                      ? 'bg-white/20 text-white'
                      : isDone
                        ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300'
                        : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400',
                  )}
                >
                  {isDone && !isCurrent ? <Check size={13} aria-hidden /> : index + 1}
                </span>
                {item.label}
              </button>
            </li>
          )
        })}
      </ol>

      {step === 'period' && (
        <PeriodStep
          run={run}
          roster={props.roster}
          stubs={props.stubs}
          adjustments={props.adjustments}
          canEditScope={props.canRun && docDraft && run.run_status !== 'committed'}
          calculated={calculated}
          busy={busy}
          onContinue={() => setStep('readiness')}
          onSetScope={setScope}
          fmt={fmt}
        />
      )}
      {step === 'readiness' && (
        <ReadinessStep
          readiness={props.readiness}
          canCalculate={canCalculate}
          calculated={calculated}
          busy={busy}
          dry={dry}
          onDryRun={dryRun}
          onCalculate={() => act('calculate')}
          fmt={fmt}
        />
      )}
      {step === 'review' && (
        <ReviewStep
          stubs={props.stubs}
          adjustments={props.adjustments}
          components={props.adjustableComponents}
          canAdjust={props.canRun && docDraft && run.run_status !== 'committed'}
          onAdjust={adjust}
          previousNet={props.previousNet}
          changes={props.changes}
          calcErrors={calcErrors}
          calculated={calculated}
          registerReportId={props.registerReportId}
          fmt={fmt}
        />
      )}
      {step === 'gl' && (
        <GlStep
          gl={gl}
          calculated={calculated}
          committed={committed || posted}
          canCommit={canCommit}
          stale={props.staleness.stale}
          funding={props.funding}
          busy={busy}
          onRetry={loadGlPreview}
          onCommit={() => act('commit')}
          fmt={fmt}
        />
      )}
      {step === 'finish' && (
        <FinishStep
          run={run}
          remittance={props.remittance}
          posted={posted}
          committed={committed}
          canPost={canPost}
          busy={busy}
          onPost={post}
          onEmailStubs={emailStubs}
          onRecordPayment={recordPayment}
          registerReportId={props.registerReportId}
          bankAccounts={props.bankAccounts}
          funding={props.funding}
          canRun={props.canRun}
          fmt={fmt}
        />
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Step 1 — Period & employees                                         */
/* ------------------------------------------------------------------ */

function PeriodStep({
  run,
  roster,
  stubs,
  adjustments,
  canEditScope,
  calculated,
  busy,
  onContinue,
  onSetScope,
  fmt,
}: {
  run: RunHeader
  roster: RosterRow[]
  stubs: StubRow[]
  adjustments: AdjustmentRow[]
  onSetScope: (includedPartyIds: string[], rosterPartyIds: string[]) => Promise<void>
  canEditScope: boolean
  calculated: boolean
  busy: boolean
  onContinue: () => void
  fmt: (v: string | number | null | undefined) => string
}) {
  const t = useTranslations('payroll')
  const tCommon = useTranslations('common')

  // Once calculated, hours come from the stubs themselves; before that, the
  // cheap approved-time summary previews what Calculate will pick up.
  const stubHours = new Map<string, number>()
  const stubByEmployee = new Map<string, StubRow>()
  for (const stub of stubs) {
    stubByEmployee.set(stub.employee_party_id, stub)
    stubHours.set(
      stub.employee_party_id,
      stub.lines.reduce((sum, line) => (line.kind === 'earning' && line.hours ? sum + Number(line.hours) : sum), 0),
    )
  }

  // The run's scope IS its exclusion rows — no parallel selection state.
  const excluded = new Set(
    adjustments.filter((a) => a.adjustment_type === 'exclude').map((a) => a.employee_party_id),
  )
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(roster.filter((r) => !excluded.has(r.employee_party_id)).map((r) => r.employee_party_id)),
  )
  const [department, setDepartment] = useState('')
  const [basis, setBasis] = useState('')
  const [onlyWithHours, setOnlyWithHours] = useState(false)
  const [hideIneligible, setHideIneligible] = useState(false)

  const hoursOf = (row: RosterRow) =>
    calculated ? (stubHours.get(row.employee_party_id) ?? 0) : Number(row.approved_hours)
  /** Blocking (no wage) vs advisory (zero hours, terminated, already paid). */
  const flagsOf = (row: RosterRow) => {
    const hours = hoursOf(row)
    return {
      noWage: !row.has_wage,
      zeroHours: row.pay_basis === 'hourly' && hours === 0,
      terminated: !!row.terminated_on && row.terminated_on <= run.period_end,
      paidInPeriod: row.paid_in_period,
    }
  }

  const departments = [...new Set(roster.map((r) => r.department).filter(Boolean))].sort() as string[]
  const visible = roster.filter((row) => {
    const f = flagsOf(row)
    if (department && row.department !== department) return false
    if (basis && row.pay_basis !== basis) return false
    if (onlyWithHours && hoursOf(row) <= 0) return false
    if (hideIneligible && (f.noWage || f.terminated || f.paidInPeriod)) return false
    return true
  })
  const visibleIds = visible.map((r) => r.employee_party_id)
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id))

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const toggleAllVisible = () =>
    setSelected((current) => {
      const next = new Set(current)
      if (allVisibleSelected) for (const id of visibleIds) next.delete(id)
      else for (const id of visibleIds) next.add(id)
      return next
    })

  const storedIncluded = roster
    .filter((r) => !excluded.has(r.employee_party_id))
    .map((r) => r.employee_party_id)
  const dirty =
    storedIncluded.length !== selected.size || storedIncluded.some((id) => !selected.has(id))
  const selectedRows = roster.filter((r) => selected.has(r.employee_party_id))
  const estimatedHours = selectedRows.reduce((sum, r) => sum + hoursOf(r), 0)
  const blocked = selectedRows.filter((r) => flagsOf(r).noWage).length

  const CONTROL =
    'h-8 rounded-md border border-slate-200 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-950'

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <dl className="grid grid-cols-2 gap-x-10 gap-y-2 text-sm sm:grid-cols-4">
            <HeaderFact label={t('columns.schedule')}>{run.schedule_name ?? '—'}</HeaderFact>
            <HeaderFact label={t('columns.period')}>
              {run.period_start} – {run.period_end}
            </HeaderFact>
            <HeaderFact label={t('columns.payDate')}>{run.pay_date}</HeaderFact>
            <HeaderFact label={t('wizard.period.taxYear')}>{String(run.tax_year)}</HeaderFact>
            <HeaderFact label={t('wizard.period.runType')}>{t(`runType.${run.run_type}`)}</HeaderFact>
          </dl>
          <Button onClick={onContinue} disabled={busy || dirty}>
            {t('wizard.period.continue')}
            <ArrowRight size={14} aria-hidden />
          </Button>
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-4 py-3 dark:border-slate-800">
          <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
            {t('wizard.period.employeesTitle', { count: roster.length })}
          </h3>
          <div className="flex flex-wrap items-center gap-2">
            {departments.length > 0 && (
              <select
                value={department}
                onChange={(e) => setDepartment(e.target.value)}
                className={CONTROL}
                aria-label={t('wizard.period.filterDepartment')}
              >
                <option value="">{t('wizard.period.allDepartments')}</option>
                {departments.map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
            )}
            <select
              value={basis}
              onChange={(e) => setBasis(e.target.value)}
              className={CONTROL}
              aria-label={t('profiles.columns.basis')}
            >
              <option value="">{t('wizard.period.allBases')}</option>
              <option value="hourly">{t('profiles.basis.hourly')}</option>
              <option value="salary">{t('profiles.basis.salary')}</option>
            </select>
            <label className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300">
              <input
                type="checkbox"
                className="h-4 w-4 accent-teal-600"
                checked={onlyWithHours}
                onChange={(e) => setOnlyWithHours(e.target.checked)}
              />
              {t('wizard.period.onlyWithHours')}
            </label>
            <label className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300">
              <input
                type="checkbox"
                className="h-4 w-4 accent-teal-600"
                checked={hideIneligible}
                onChange={(e) => setHideIneligible(e.target.checked)}
              />
              {t('wizard.period.hideIneligible')}
            </label>
          </div>
        </div>

        {canEditScope && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 bg-slate-50/60 px-4 py-2.5 text-sm dark:border-slate-800 dark:bg-slate-900/40">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <span className="font-medium text-slate-800 dark:text-slate-100">
                {t('wizard.period.selectedCount', { selected: selected.size, total: roster.length })}
              </span>
              <span className="text-slate-500 dark:text-slate-400">
                {t('wizard.period.selectedHours', { hours: estimatedHours.toFixed(2) })}
              </span>
              {blocked > 0 && (
                <span className="text-amber-600 dark:text-amber-400">
                  {t('wizard.period.selectedBlocked', { count: blocked })}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {dirty && (
                <button
                  type="button"
                  className="text-xs text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
                  onClick={() => setSelected(new Set(storedIncluded))}
                >
                  {tCommon('actions.cancel')}
                </button>
              )}
              <Button
                size="sm"
                variant={dirty ? 'default' : 'outline'}
                disabled={busy || !dirty}
                onClick={() => void onSetScope([...selected], roster.map((r) => r.employee_party_id))}
              >
                {t('wizard.period.applyScope')}
              </Button>
            </div>
          </div>
        )}

        <div className="p-3">
          <PagedTable
            rows={visible}
            columns={([
              ...(canEditScope ? [{
                key: 'select',
                header: (
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-teal-600"
                    checked={allVisibleSelected}
                    onChange={toggleAllVisible}
                    aria-label={t('wizard.period.selectAll')}
                  />
                ) as unknown as string,
                cell: (row: RosterRow) => (
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-teal-600"
                    checked={selected.has(row.employee_party_id)}
                    onChange={() => toggle(row.employee_party_id)}
                    aria-label={t('wizard.period.selectEmployee', { name: row.name })}
                  />
                ),
              }] : []),
              {
                key: 'employee', header: t('run.stub.employee'),
                search: (row: RosterRow) => row.name,
                cell: (row: RosterRow) => (
                  <span className={cn('font-medium', !selected.has(row.employee_party_id) && 'text-slate-400 dark:text-slate-500')}>
                    {row.name}
                  </span>
                ),
              },
              {
                key: 'department', header: t('wizard.period.department'),
                search: (row: RosterRow) => row.department ?? '',
                cell: (row: RosterRow) => row.department ?? '—',
              },
              {
                key: 'basis', header: t('profiles.columns.basis'),
                cell: (row: RosterRow) => t(`profiles.basis.${row.pay_basis}`),
              },
              {
                key: 'hours', header: t('wizard.period.approvedHours'), align: 'right' as const,
                cell: (row: RosterRow) => {
                  const hours = hoursOf(row)
                  return row.pay_basis === 'hourly' || hours > 0 ? hours.toFixed(2) : '—'
                },
              },
              {
                key: 'gross', header: calculated ? t('columns.gross') : '', align: 'right' as const,
                cell: (row: RosterRow) => {
                  const stub = stubByEmployee.get(row.employee_party_id)
                  return calculated && stub ? fmt(stub.gross) : ''
                },
              },
              {
                key: 'status', header: t('columns.status'),
                cell: (row: RosterRow) => {
                  const f = flagsOf(row)
                  if (f.noWage) return <Badge variant="outline">{t('wizard.period.noWage')}</Badge>
                  if (f.paidInPeriod) return <Badge variant="warning">{t('wizard.period.paidInPeriod')}</Badge>
                  if (f.terminated) return <Badge variant="warning">{t('wizard.period.terminated')}</Badge>
                  if (f.zeroHours) return <Badge variant="secondary">{t('wizard.period.zeroHours')}</Badge>
                  if (!selected.has(row.employee_party_id)) return <Badge variant="secondary">{t('wizard.period.excluded')}</Badge>
                  return <Badge variant="success">{t('wizard.period.included')}</Badge>
                },
              },
            ] as PagedColumn<RosterRow>[])}
            pageSize={25}
            searchable
            rowKey={(row: RosterRow) => row.employee_party_id}
            empty={t('wizard.period.noneMatch')}
          />
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Step 2 — Readiness                                                  */
/* ------------------------------------------------------------------ */

/**
 * The pre-flight. Blockers stop the calculation and each one links to where it
 * is fixed; warnings are acknowledged, not enforced — payroll teams do pay
 * someone with no hours, and the product's job is to make sure they saw it.
 * A test calculation runs the whole engine and rolls it back, so the totals
 * can be checked before anything is written.
 */
function ReadinessStep({
  readiness,
  canCalculate,
  calculated,
  busy,
  dry,
  onDryRun,
  onCalculate,
  fmt,
}: {
  readiness: Readiness
  canCalculate: boolean
  calculated: boolean
  busy: boolean
  dry: {
    employees: number
    gross: string
    net: string
    employerCost: string
    errors: { employee: string; message: string }[]
  } | null
  onDryRun: () => void
  onCalculate: () => void
  fmt: (v: string | number | null | undefined) => string
}) {
  const t = useTranslations('payroll')
  const [acknowledged, setAcknowledged] = useState(false)

  const blockers = readiness.items.filter((i) => i.severity === 'blocker')
  const warnings = readiness.items.filter((i) => i.severity === 'warning')
  const needsAck = warnings.length > 0 && !acknowledged
  const label = (item: ReadinessItem) =>
    t(`wizard.readiness.codes.${item.code}`, {
      count: item.employees.length,
      detail: item.detail ?? '',
    })

  const list = (items: ReadinessItem[], severity: 'blocker' | 'warning') => (
    <ul className="divide-y divide-slate-100 dark:divide-slate-800">
      {items.map((item, index) => (
        <li key={`${item.code}-${index}`} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <p
              className={cn(
                'text-sm font-medium',
                severity === 'blocker'
                  ? 'text-red-700 dark:text-red-300'
                  : 'text-amber-700 dark:text-amber-300',
              )}
            >
              {label(item)}
            </p>
            {item.employees.length > 0 && (
              <p className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">
                {item.employees.slice(0, 8).map((e) => e.name).join(', ')}
                {item.employees.length > 8
                  ? t('wizard.readiness.andMore', { count: item.employees.length - 8 })
                  : ''}
              </p>
            )}
          </div>
          {item.href && (
            <Button asChild size="sm" variant="outline">
              <Link href={item.href as never}>{t('wizard.readiness.fix')}</Link>
            </Button>
          )}
        </li>
      ))}
    </ul>
  )

  return (
    <div className="space-y-4">
      <div
        className={cn(
          'flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3.5',
          blockers.length > 0
            ? 'border-red-200/80 bg-red-50 dark:border-red-800/60 dark:bg-red-950/40'
            : 'border-emerald-200/80 bg-emerald-50 dark:border-emerald-800/60 dark:bg-emerald-950/40',
        )}
      >
        <div className="flex items-center gap-3">
          {blockers.length > 0 ? (
            <AlertTriangle size={20} className="text-red-600 dark:text-red-400" aria-hidden />
          ) : (
            <CheckCircle2 size={20} className="text-emerald-600 dark:text-emerald-400" aria-hidden />
          )}
          <div>
            <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              {blockers.length > 0
                ? t('wizard.readiness.blockedTitle', { count: blockers.length })
                : t('wizard.readiness.readyTitle', { count: readiness.included })}
            </p>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {blockers.length > 0
                ? t('wizard.readiness.blockedHint')
                : warnings.length > 0
                  ? t('wizard.readiness.warningsHint', { count: warnings.length })
                  : t('wizard.readiness.readyHint')}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={onDryRun}>
            {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Beaker size={14} aria-hidden />}
            {t('wizard.readiness.dryRun')}
          </Button>
          {canCalculate && (
            <Button onClick={onCalculate} disabled={busy || needsAck}>
              {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Calculator size={14} aria-hidden />}
              {calculated ? t('wizard.period.recalculate') : t('run.calculate')}
            </Button>
          )}
        </div>
      </div>

      {dry && (
        <div className="rounded-xl border border-sky-200/80 bg-sky-50 px-4 py-3 dark:border-sky-800/60 dark:bg-sky-950/40">
          <p className="mb-2 text-sm font-semibold text-sky-900 dark:text-sky-200">
            {t('wizard.readiness.dryRunTitle')}
          </p>
          <dl className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm sm:grid-cols-4">
            <HeaderFact label={t('columns.employees')}>{String(dry.employees)}</HeaderFact>
            <HeaderFact label={t('columns.gross')}>{fmt(dry.gross)}</HeaderFact>
            <HeaderFact label={t('columns.net')}>{fmt(dry.net)}</HeaderFact>
            <HeaderFact label={t('run.employerCost')}>{fmt(dry.employerCost)}</HeaderFact>
          </dl>
          {dry.errors.length > 0 && (
            <ul className="mt-3 ml-5 list-disc space-y-0.5 text-sm text-sky-900 dark:text-sky-200">
              {dry.errors.map((item, index) => (
                <li key={index}>
                  <span className="font-medium">{item.employee}</span>: {item.message}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs text-sky-700 dark:text-sky-300">{t('wizard.readiness.dryRunHint')}</p>
        </div>
      )}

      {blockers.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <h3 className="border-b border-slate-100 px-4 py-3 text-sm font-semibold text-slate-800 dark:border-slate-800 dark:text-slate-100">
            {t('wizard.readiness.blockersTitle')}
          </h3>
          {list(blockers, 'blocker')}
        </div>
      )}

      {warnings.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <h3 className="border-b border-slate-100 px-4 py-3 text-sm font-semibold text-slate-800 dark:border-slate-800 dark:text-slate-100">
            {t('wizard.readiness.warningsTitle')}
          </h3>
          {list(warnings, 'warning')}
          {canCalculate && (
            <label className="flex items-center gap-2 border-t border-slate-100 bg-slate-50/60 px-4 py-3 text-sm text-slate-600 dark:border-slate-800 dark:bg-slate-900/40 dark:text-slate-300">
              <input
                type="checkbox"
                className="h-4 w-4 accent-teal-600"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
              />
              {t('wizard.readiness.acknowledge')}
            </label>
          )}
        </div>
      )}

      {blockers.length === 0 && warnings.length === 0 && (
        <div className="rounded-xl border border-slate-200 bg-white px-4 py-10 text-center text-sm text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
          {t('wizard.readiness.allClear')}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Step 3 — Review stubs                                               */
/* ------------------------------------------------------------------ */

function ReviewStep({
  stubs,
  previousNet,
  changes,
  calcErrors,
  calculated,
  registerReportId,
  fmt,
  adjustments,
  components,
  canAdjust,
  onAdjust,
}: {
  stubs: StubRow[]
  previousNet: Record<string, string>
  changes: StubChange[]
  calcErrors: { employee: string; message: string }[]
  calculated: boolean
  registerReportId: string | null
  fmt: (v: string | number | null | undefined) => string
  adjustments: AdjustmentRow[]
  components: ComponentOption[]
  canAdjust: boolean
  onAdjust: (body: Record<string, unknown>) => Promise<void>
}) {
  const t = useTranslations('payroll')
  const [openStub, setOpenStub] = useState<StubRow | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkOpen, setBulkOpen] = useState(false)

  const changeByEmployee = new Map(changes.map((c) => [c.employeePartyId, c]))

  const variance = (stub: StubRow): { percent: number; flagged: boolean } | null => {
    const prev = Number(previousNet[stub.employee_party_id] ?? NaN)
    if (!Number.isFinite(prev) || prev === 0) return null
    const percent = ((Number(stub.net_pay) - prev) / prev) * 100
    return { percent, flagged: Math.abs(percent) > VARIANCE_FLAG_PERCENT }
  }

  const flagged = stubs.filter((stub) => variance(stub)?.flagged)
  const excludedRows = adjustments.filter((a) => a.adjustment_type === 'exclude')
  // An unpaid garnishment balance is a real obligation the creditor still
  // expects, so it can never be a silent difference between two stubs.
  const protectionShortfalls = stubs
    .map((stub) => ({ stub, amount: stub.factors?.PROT_SHORT ?? '0' }))
    .filter((entry) => Number(entry.amount) > 0)
  const allSelected = stubs.length > 0 && stubs.every((s) => selected.has(s.employee_party_id))
  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <div className="space-y-4">
      {excludedRows.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm dark:border-slate-800 dark:bg-slate-900">
          <span className="text-slate-500 dark:text-slate-400">{t('wizard.adjust.excludedLabel')}</span>
          {excludedRows.map((row) => (
            <span key={row.id} className="inline-flex items-center gap-1.5 rounded-full border border-slate-300 px-2.5 py-0.5 dark:border-slate-700">
              {row.employee_name}
              {canAdjust && (
                <button
                  className="text-xs font-medium text-teal-700 hover:underline dark:text-teal-300"
                  onClick={() => void onAdjust({ action: 'include-employee', employeePartyId: row.employee_party_id })}
                >
                  {t('wizard.adjust.include')}
                </button>
              )}
            </span>
          ))}
        </div>
      )}
      {calcErrors.length > 0 && (
        <div className="rounded-xl border border-amber-200/80 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-300">
          <p className="mb-1 flex items-center gap-2 font-semibold">
            <AlertTriangle size={15} aria-hidden />
            {t('wizard.review.exceptionsTitle', { count: calcErrors.length })}
          </p>
          <ul className="ml-6 list-disc space-y-0.5">
            {calcErrors.map((item, index) => (
              <li key={index}>
                <span className="font-medium">{item.employee}</span>: {item.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      {protectionShortfalls.length > 0 && (
        <div className="rounded-xl border border-amber-200/80 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-300">
          <p className="mb-1 flex items-center gap-2 font-semibold">
            <AlertTriangle size={15} aria-hidden />
            {t('wizard.review.protectionShortfallTitle', { count: protectionShortfalls.length })}
          </p>
          <p className="mb-1">{t('wizard.review.protectionShortfallHint')}</p>
          <ul className="ml-6 list-disc space-y-0.5">
            {protectionShortfalls.map(({ stub, amount }) => (
              <li key={stub.id}>
                <span className="font-medium">{stub.employee_name}</span>: {fmt(amount)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {flagged.length > 0 && (
        <div className="flex items-center gap-2 rounded-xl border border-sky-200/80 bg-sky-50 px-4 py-3 text-sm text-sky-800 dark:border-sky-800/60 dark:bg-sky-950/40 dark:text-sky-300">
          <AlertTriangle size={15} aria-hidden />
          {t('wizard.review.varianceFlag', { count: flagged.length, percent: VARIANCE_FLAG_PERCENT })}
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-4 py-3 dark:border-slate-800">
          <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
            {t('wizard.review.registerTitle')}
          </h3>
          <div className="flex items-center gap-2">
            {canAdjust && selected.size > 0 && (
              <>
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  {t('wizard.review.selectedCount', { count: selected.size })}
                </span>
                <Button size="sm" variant="outline" onClick={() => setBulkOpen(true)}>
                  {t('wizard.review.bulkEdit')}
                </Button>
              </>
            )}
            {registerReportId && (
              <Button asChild size="sm" variant="outline">
                <Link href={`/reports/custom/run/${registerReportId}` as never}>
                  {t('wizard.finish.register')}
                </Link>
              </Button>
            )}
          </div>
        </div>
<div className="p-3">
          <PagedTable
            rows={stubs}
            columns={([
              ...(canAdjust ? [{
                key: 'select',
                header: (
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-teal-600"
                    checked={allSelected}
                    onChange={() =>
                      setSelected(allSelected ? new Set() : new Set(stubs.map((s) => s.employee_party_id)))
                    }
                    aria-label={t('wizard.review.selectAll')}
                  />
                ) as unknown as string,
                cell: (stub: StubRow) => (
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-teal-600"
                    checked={selected.has(stub.employee_party_id)}
                    onChange={() => toggle(stub.employee_party_id)}
                    onClick={(e) => e.stopPropagation()}
                    aria-label={t('wizard.period.selectEmployee', { name: stub.employee_name })}
                  />
                ),
              }] : []),
              {
                key: 'employee', header: t('run.stub.employee'),
                search: (stub) => `${stub.employee_name} ${stub.province}`,
                cell: (stub) => (
                  <span className="font-medium text-teal-700 dark:text-teal-300">{stub.employee_name}</span>
                ),
              },
              { key: 'province', header: t('run.stub.province'), cell: (stub) => stub.province },
              { key: 'gross', header: t('columns.gross'), align: 'right', cell: (stub) => fmt(stub.gross) },
              { key: 'cpp', header: t('run.stub.cpp'), align: 'right', cell: (stub) => fmt(statutory(stub).cpp) },
              { key: 'ei', header: t('run.stub.ei'), align: 'right', cell: (stub) => fmt(statutory(stub).ei) },
              { key: 'tax', header: t('run.stub.tax'), align: 'right', cell: (stub) => fmt(statutory(stub).tax) },
              {
                key: 'net', header: t('columns.net'), align: 'right',
                cell: (stub) => <span className="font-medium">{fmt(stub.net_pay)}</span>,
              },
              {
                key: 'variance', header: t('wizard.review.varianceColumn'), align: 'right',
                cell: (stub) => {
                  const delta = variance(stub)
                  return delta === null ? (
                    <span className="text-xs text-slate-400">{t('wizard.review.newEmployee')}</span>
                  ) : (
                    <span
                      className={cn(
                        delta.flagged
                          ? 'font-semibold text-amber-600 dark:text-amber-400'
                          : 'text-slate-500 dark:text-slate-400',
                      )}
                    >
                      {delta.percent > 0 ? '+' : ''}
                      {delta.percent.toFixed(1)}%
                    </span>
                  )
                },
              },
              {
                key: 'employerCost', header: t('run.employerCost'), align: 'right',
                cell: (stub) => fmt(stub.employer_cost),
              },
              // What actually moved since this employee's last pay — the
              // component-level answer to "why is this number different?".
              {
                key: 'changed', header: t('wizard.review.changedColumn'),
                cell: (stub) => {
                  const diff = changeByEmployee.get(stub.employee_party_id)
                  if (!diff || !diff.previousPayDate) {
                    return <span className="text-xs text-slate-400">{t('wizard.review.newEmployee')}</span>
                  }
                  if (diff.changes.length === 0) {
                    return <span className="text-xs text-slate-400">{t('wizard.review.noChange')}</span>
                  }
                  return (
                    <span className="flex flex-wrap gap-1">
                      {diff.changes.slice(0, 3).map((c, index) => (
                        <Badge
                          key={index}
                          variant={c.kind === 'removed' ? 'outline' : c.kind === 'added' ? 'success' : 'secondary'}
                        >
                          {c.component}
                        </Badge>
                      ))}
                      {diff.changes.length > 3 && (
                        <Badge variant="outline">
                          {t('wizard.readiness.andMore', { count: diff.changes.length - 3 })}
                        </Badge>
                      )}
                    </span>
                  )
                },
              },
            ] as PagedColumn<StubRow>[])}
            pageSize={20}
            searchable
            empty={
              <p className="p-2 text-sm text-slate-500 dark:text-slate-400">
                {calculated ? t('run.empty') : t('wizard.review.needsCalculation')}
              </p>
            }
            rowKey={(stub) => stub.id}
            onRowClick={(stub) => setOpenStub(stub)}
          />
        </div>
      </div>

      {openStub && (
        <StubDrawer
          stub={openStub}
          variance={variance(openStub)}
          change={changeByEmployee.get(openStub.employee_party_id) ?? null}
          onClose={() => setOpenStub(null)}
          fmt={fmt}
          adjustments={adjustments.filter(
            (a) => a.adjustment_type === 'line' && a.employee_party_id === openStub.employee_party_id,
          )}
          components={components}
          canAdjust={canAdjust}
          onAdjust={onAdjust}
        />
      )}

      {bulkOpen && (
        <BulkEditDrawer
          count={selected.size}
          components={components}
          onClose={() => setBulkOpen(false)}
          onApply={async (body) => {
            await onAdjust({ ...body, action: 'bulk-adjustment', employeePartyIds: [...selected] })
            setBulkOpen(false)
            setSelected(new Set())
          }}
        />
      )}
    </div>
  )
}

/** One component amount applied across every selected employee at once. */
function BulkEditDrawer({
  count,
  components,
  onClose,
  onApply,
}: {
  count: number
  components: ComponentOption[]
  onClose: () => void
  onApply: (body: Record<string, unknown>) => Promise<void>
}) {
  const t = useTranslations('payroll')
  const tCommon = useTranslations('common')
  const [componentId, setComponentId] = useState('')
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [replace, setReplace] = useState(false)
  const valid = componentId !== '' && /^-?\d+(\.\d{1,2})?$/.test(amount)
  return (
    <Drawer
      open
      onClose={onClose}
      size="sm"
      title={t('wizard.review.bulkEdit')}
      description={t('wizard.review.bulkDescription', { count })}
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>{tCommon('actions.cancel')}</Button>
          <Button
            disabled={!valid}
            onClick={() => void onApply({ componentId, amount, note: note || undefined, replaceComponent: replace })}
          >
            {t('wizard.review.bulkApply', { count })}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <select
          aria-label={t('wizard.adjust.component')}
          value={componentId}
          onChange={(e) => setComponentId(e.target.value)}
          className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
        >
          <option value="">{t('wizard.adjust.component')}</option>
          <optgroup label={t('wizard.adjust.earnings')}>
            {components.filter((c) => c.kind === 'earning').map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </optgroup>
          <optgroup label={t('wizard.adjust.deductions')}>
            {components.filter((c) => c.kind === 'deduction').map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </optgroup>
        </select>
        <input
          aria-label={t('wizard.adjust.amount')}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder={t('wizard.adjust.amount')}
          inputMode="decimal"
          className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-right text-sm tabular-nums dark:border-slate-700 dark:bg-slate-900"
        />
        <input
          aria-label={t('wizard.adjust.note')}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={t('wizard.adjust.note')}
          className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
        />
        <label className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
          <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
          {t('wizard.adjust.replaceHelp')}
        </label>
      </div>
    </Drawer>
  )
}

/** One employee's stub — the house flyout: header facts, pay lines, the T4127
 * factor trace, and the variance flag, with the paystub PDF one click away. */
function StubDrawer({
  stub,
  variance,
  change,
  onClose,
  fmt,
  adjustments,
  components,
  canAdjust,
  onAdjust,
}: {
  stub: StubRow
  variance: { percent: number; flagged: boolean } | null
  change: StubChange | null
  onClose: () => void
  fmt: (v: string | number | null | undefined) => string
  adjustments: AdjustmentRow[]
  components: ComponentOption[]
  canAdjust: boolean
  onAdjust: (body: Record<string, unknown>) => Promise<void>
}) {
  const t = useTranslations('payroll')
  const s = statutory(stub)
  const factorEntries = Object.entries(stub.factors ?? {}).sort(([a], [b]) => a.localeCompare(b))
  const factorLabel = (key: string) => FACTOR_LABELS[key] ?? key
  const [adjComponent, setAdjComponent] = useState('')
  const [adjAmount, setAdjAmount] = useState('')
  const [adjNote, setAdjNote] = useState('')
  const [adjReplace, setAdjReplace] = useState(false)
  return (
    <Drawer
      open
      onClose={onClose}
      title={stub.employee_name}
      description={t('wizard.review.drawerDescription')}
      footer={
        <div className="flex justify-between gap-2">
          <Button variant="outline" asChild>
            <a href={`/api/record-pdf/pay_stub/${stub.id}`} target="_blank" rel="noreferrer">
              <FileDown size={14} aria-hidden />
              {t('wizard.review.downloadPdf')}
            </a>
          </Button>
          <span className="flex items-center gap-2">
            {canAdjust && (
              <Button
                variant="outline"
                onClick={() => void onAdjust({ action: 'exclude-employee', employeePartyId: stub.employee_party_id }).then(onClose)}
              >
                {t('wizard.adjust.exclude')}
              </Button>
            )}
            <Button variant="ghost" onClick={onClose}>
              {t('wizard.review.close')}
            </Button>
          </span>
        </div>
      }
    >
      <div className="space-y-5">
        {variance?.flagged && (
          <div className="flex items-center gap-2 rounded-lg border border-amber-200/80 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-300">
            <AlertTriangle size={14} aria-hidden />
            {t('wizard.review.drawerVariance', {
              percent: `${variance.percent > 0 ? '+' : ''}${variance.percent.toFixed(1)}`,
            })}
          </div>
        )}

        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
          <HeaderFact label={t('run.stub.province')}>{stub.province}</HeaderFact>
          <HeaderFact label={t('columns.gross')}>{fmt(stub.gross)}</HeaderFact>
          <HeaderFact label={t('columns.net')}>{fmt(stub.net_pay)}</HeaderFact>
          <HeaderFact label={t('run.stub.cpp')}>{fmt(s.cpp)}</HeaderFact>
          <HeaderFact label={t('run.stub.ei')}>{fmt(s.ei)}</HeaderFact>
          <HeaderFact label={t('run.stub.tax')}>{fmt(s.tax)}</HeaderFact>
          {variance !== null && (
            <HeaderFact label={t('wizard.review.varianceColumn')}>
              {`${variance.percent > 0 ? '+' : ''}${variance.percent.toFixed(1)}%`}
            </HeaderFact>
          )}
          <HeaderFact label={t('run.employerCost')}>{fmt(stub.employer_cost)}</HeaderFact>
        </dl>

        <div>
          <h4 className="mb-2 text-xs font-semibold tracking-wider text-slate-400 uppercase dark:text-slate-500">
            {t('run.stub.lines')}
          </h4>
          <table className="w-full text-sm">
            <tbody>
              {stub.lines.map((line, index) => (
                <tr key={index} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
                  <td className="py-1 pr-2 text-slate-500 dark:text-slate-400">
                    {t(`run.lineKind.${line.kind}`)}
                  </td>
                  <td className="py-1 pr-2">
                    {line.description}
                    {(line.project_name || line.department_name) && (
                      <span className="ml-1 text-xs text-slate-400">
                        {[line.project_name, line.department_name].filter(Boolean).join(' · ')}
                      </span>
                    )}
                  </td>
                  <td className="py-1 pr-2 text-right tabular-nums text-slate-500 dark:text-slate-400">
                    {line.hours ? `${line.hours} × ${fmt(line.rate)}` : ''}
                  </td>
                  <td
                    className={cn(
                      'py-1 text-right tabular-nums',
                      line.kind === 'deduction' && 'text-red-600 dark:text-red-400',
                    )}
                  >
                    {line.kind === 'deduction' ? `−${fmt(line.amount)}` : fmt(line.amount)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {change?.previousPayDate && (
          <div>
            <h4 className="mb-2 text-xs font-semibold tracking-wider text-slate-400 uppercase dark:text-slate-500">
              {t('wizard.review.changedTitle', { date: change.previousPayDate })}
            </h4>
            {change.changes.length === 0 ? (
              <p className="text-sm text-slate-500 dark:text-slate-400">{t('wizard.review.noChangeDetail')}</p>
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {change.changes.map((row, index) => (
                    <tr key={index} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
                      <td className="py-1 pr-2 text-slate-500 dark:text-slate-400">
                        {t(`wizard.review.changeKind.${row.kind}`)}
                      </td>
                      <td className="py-1 pr-2">{row.component}</td>
                      <td className="py-1 pr-2 text-right tabular-nums text-slate-500 dark:text-slate-400">
                        {row.from === null ? '—' : fmt(row.from)}
                      </td>
                      <td className="py-1 text-right tabular-nums">
                        {row.to === null ? '—' : fmt(row.to)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="mt-2 text-xs text-slate-400 dark:text-slate-500">
              {t('wizard.review.changedTotals', {
                net: fmt(change.netDelta),
                hours: Number(change.hoursDelta).toFixed(2),
              })}
            </p>
          </div>
        )}

        <div>
          <h4 className="mb-2 text-xs font-semibold tracking-wider text-slate-400 uppercase dark:text-slate-500">
            {t('run.stub.trace')}
          </h4>
          <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-0.5 text-sm">
            {factorEntries.map(([key, value]) => (
              <Fragment key={key}>
                <dt className="text-slate-600 dark:text-slate-300">
                  {factorLabel(key)}
                  <span className="ml-1.5 font-mono text-[10px] text-slate-400 dark:text-slate-500">{key}</span>
                </dt>
                <dd className="text-right tabular-nums">{value}</dd>
              </Fragment>
            ))}
          </dl>
        </div>

        {(canAdjust || adjustments.length > 0) && (
          <div>
            <h4 className="mb-2 text-xs font-semibold tracking-wider text-slate-400 uppercase dark:text-slate-500">
              {t('wizard.adjust.title')}
            </h4>
            {adjustments.length > 0 && (
              <ul className="mb-3 space-y-1 text-sm">
                {adjustments.map((row) => (
                  <li key={row.id} className="flex items-center justify-between gap-2">
                    <span>
                      {row.component_name}
                      {row.replace_component ? ` · ${t('wizard.adjust.replaces')}` : ''}
                      {row.note ? <span className="ml-1.5 text-xs text-slate-400">{row.note}</span> : null}
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="tabular-nums">{fmt(row.amount)}</span>
                      {canAdjust && (
                        <button
                          className="text-xs font-medium text-rose-600 hover:underline dark:text-rose-400"
                          onClick={() => void onAdjust({ action: 'delete-adjustment', adjustmentId: row.id })}
                        >
                          {t('wizard.adjust.remove')}
                        </button>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {canAdjust && (
              <div className="space-y-2 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
                <div className="grid grid-cols-2 gap-2">
                  <select
                    aria-label={t('wizard.adjust.component')}
                    value={adjComponent}
                    onChange={(e) => setAdjComponent(e.target.value)}
                    className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
                  >
                    <option value="">{t('wizard.adjust.component')}</option>
                    <optgroup label={t('wizard.adjust.earnings')}>
                      {components.filter((c) => c.kind === 'earning').map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </optgroup>
                    <optgroup label={t('wizard.adjust.deductions')}>
                      {components.filter((c) => c.kind === 'deduction').map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </optgroup>
                  </select>
                  <input
                    aria-label={t('wizard.adjust.amount')}
                    value={adjAmount}
                    onChange={(e) => setAdjAmount(e.target.value)}
                    placeholder={t('wizard.adjust.amount')}
                    inputMode="decimal"
                    className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-right text-sm tabular-nums dark:border-slate-700 dark:bg-slate-900"
                  />
                </div>
                <input
                  aria-label={t('wizard.adjust.note')}
                  value={adjNote}
                  onChange={(e) => setAdjNote(e.target.value)}
                  placeholder={t('wizard.adjust.note')}
                  className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
                />
                <label className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                  <input type="checkbox" checked={adjReplace} onChange={(e) => setAdjReplace(e.target.checked)} />
                  {t('wizard.adjust.replaceHelp')}
                </label>
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    disabled={!adjComponent || !/^-?\d+(\.\d{1,2})?$/.test(adjAmount)}
                    onClick={() => {
                      void onAdjust({
                        action: 'add-adjustment',
                        employeePartyId: stub.employee_party_id,
                        componentId: adjComponent,
                        amount: adjAmount,
                        note: adjNote || undefined,
                        replaceComponent: adjReplace,
                      }).then(() => {
                        setAdjComponent(''); setAdjAmount(''); setAdjNote(''); setAdjReplace(false)
                      })
                    }}
                  >
                    {t('wizard.adjust.add')}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </Drawer>
  )
}

/* ------------------------------------------------------------------ */
/* Step 3 — GL preview & commit                                        */
/* ------------------------------------------------------------------ */

function GlStep({
  gl,
  calculated,
  committed,
  canCommit,
  stale,
  funding,
  busy,
  onRetry,
  onCommit,
  fmt,
}: {
  gl: { state: 'idle' | 'loading' | 'ready' | 'setup-error'; legs: GlLeg[]; debitTotal: string; error: string }
  calculated: boolean
  committed: boolean
  canCommit: boolean
  stale: boolean
  funding: Funding
  busy: boolean
  onRetry: () => void
  onCommit: () => void
  fmt: (v: string | number | null | undefined) => string
}) {
  const t = useTranslations('payroll')

  if (!calculated) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white px-4 py-10 text-center text-sm text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
        {t('wizard.gl.needsCalculation')}
      </div>
    )
  }

  if (gl.state === 'setup-error') {
    return (
      <div className="rounded-xl border border-amber-200/80 bg-amber-50 px-4 py-4 text-sm text-amber-800 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-300">
        <p className="mb-1 flex items-center gap-2 font-semibold">
          <AlertTriangle size={15} aria-hidden />
          {t('wizard.gl.setupIncomplete')}
        </p>
        <p className="mb-3">{gl.error}</p>
        <div className="flex items-center gap-2">
          <Button asChild size="sm" variant="outline">
            <Link href={'/admin/setup/payroll?tab=accounts' as never}>{t('wizard.gl.openSetup')}</Link>
          </Button>
          <Button size="sm" variant="ghost" onClick={onRetry}>
            {t('wizard.gl.retry')}
          </Button>
        </div>
      </div>
    )
  }

  if (gl.state !== 'ready') {
    return (
      <div className="flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-10 text-sm text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
        <Loader2 size={15} className="animate-spin" aria-hidden />
        {t('wizard.gl.loading')}
      </div>
    )
  }

  const debits = gl.legs.filter((leg) => Number(leg.amount) > 0)
  const credits = gl.legs.filter((leg) => Number(leg.amount) < 0)
  const creditTotal = credits.reduce((sum, leg) => sum + Math.abs(Number(leg.amount)), 0)

  const legRows = (legs: GlLeg[], negate: boolean) =>
    legs.map((leg, index) => (
      <TableRow key={index}>
        <TableCell className="font-medium">{leg.accountLabel}</TableCell>
        <TableCell className="text-slate-600 dark:text-slate-300">
          {leg.description}
          {(leg.partyName || leg.projectName) && (
            <span className="ml-1.5 text-xs text-slate-400">
              {[leg.partyName, leg.projectName].filter(Boolean).join(' · ')}
            </span>
          )}
        </TableCell>
        <TableCell className="text-right tabular-nums">
          {negate ? '' : fmt(leg.amount)}
        </TableCell>
        <TableCell className="text-right tabular-nums">
          {negate ? fmt(Math.abs(Number(leg.amount))) : ''}
        </TableCell>
      </TableRow>
    ))

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-500 dark:text-slate-400">{t('wizard.gl.hint')}</p>
        {canCommit ? (
          <Button onClick={onCommit} disabled={busy}>
            {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <CheckCircle2 size={14} aria-hidden />}
            {t('run.commit')}
          </Button>
        ) : stale && !committed ? (
          <span className="text-sm text-amber-600 dark:text-amber-400">{t('wizard.gl.staleBlocked')}</span>
        ) : null}
        {committed && (
          <Badge variant="default">{t('status.committed')}</Badge>
        )}
      </div>

      <FundingPanel funding={funding} fmt={fmt} />

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
<div className="p-3">
          <PagedTable
            rows={[...debits, ...credits]}
            columns={([
              {
                key: 'account', header: t('wizard.gl.account'),
                search: (leg) => `${leg.accountLabel} ${leg.partyName ?? ''} ${leg.projectName ?? ''}`,
                cell: (leg) => (
                  <span>
                    {leg.accountLabel}
                    {leg.partyName ? <span className="ml-1.5 text-xs text-slate-400">{leg.partyName}</span> : null}
                    {leg.projectName ? <span className="ml-1.5 text-xs text-slate-400">{leg.projectName}</span> : null}
                  </span>
                ),
              },
              { key: 'description', header: t('wizard.gl.description'), cell: (leg) => leg.description },
              {
                key: 'debit', header: t('wizard.gl.debits'), align: 'right',
                cell: (leg) => (Number(leg.amount) > 0 ? fmt(leg.amount) : ''),
              },
              {
                key: 'credit', header: t('wizard.gl.credits'), align: 'right',
                cell: (leg) => (Number(leg.amount) < 0 ? fmt(Math.abs(Number(leg.amount))) : ''),
              },
            ] as PagedColumn<GlLeg>[])}
            pageSize={25}
            searchable
            empty={<p className="p-2 text-sm text-slate-500 dark:text-slate-400">{t('wizard.gl.hint')}</p>}
            rowKey={(leg, index) => `${leg.accountId}-${index}`}
            footer={
              <TableRow className="border-t-2 border-slate-200 bg-slate-50 font-semibold dark:border-slate-700 dark:bg-slate-950/40">
                <TableCell colSpan={2}>{t('wizard.gl.balanced')}</TableCell>
                <TableCell className="text-right tabular-nums">{fmt(gl.debitTotal)}</TableCell>
                <TableCell className="text-right tabular-nums">{fmt(creditTotal)}</TableCell>
              </TableRow>
            }
          />
        </div>
      </div>

      {canCommit && (
        <p className="text-xs text-slate-400 dark:text-slate-500">{t('wizard.gl.commitHint')}</p>
      )}
    </div>
  )
}

/**
 * Cash required to fund the payday, beside what each bank account actually
 * holds — the question every controller asks at commit and no ledger preview
 * answers. Lead time is business days to the pay date, because a bank file
 * submitted the morning of payday does not land on payday.
 */
function FundingPanel({
  funding,
  fmt,
}: {
  funding: Funding
  fmt: (v: string | number | null | undefined) => string
}) {
  const t = useTranslations('payroll')
  const days = funding.businessDaysToPayDate
  const short = funding.accounts.length > 0 && funding.accounts.every((a) => !a.sufficient)

  return (
    <div className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-4 py-3 dark:border-slate-800">
        <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
          {t('wizard.funding.title')}
        </h3>
        <span
          className={cn(
            'text-xs',
            days < 0
              ? 'text-amber-600 dark:text-amber-400'
              : days <= 2
                ? 'text-amber-600 dark:text-amber-400'
                : 'text-slate-500 dark:text-slate-400',
          )}
        >
          {days < 0
            ? t('wizard.funding.payDatePast', { date: funding.payDate })
            : t('wizard.funding.leadTime', { days, date: funding.payDate })}
        </span>
      </div>
      <div className="grid gap-4 px-4 py-3 sm:grid-cols-3">
        <HeaderFact label={t('wizard.funding.netPay')}>{fmt(funding.netPay)}</HeaderFact>
        <HeaderFact label={t('wizard.funding.liabilities')}>{fmt(funding.liabilities)}</HeaderFact>
        <HeaderFact label={t('wizard.funding.totalCost')}>{fmt(funding.totalCost)}</HeaderFact>
      </div>
      {funding.accounts.length > 0 && (
        <div className="border-t border-slate-100 px-4 py-3 dark:border-slate-800">
          <p className="mb-2 text-xs font-medium tracking-wide text-slate-400 uppercase dark:text-slate-500">
            {t('wizard.funding.accounts')}
          </p>
          <ul className="space-y-1 text-sm">
            {funding.accounts.map((account) => (
              <li key={account.id} className="flex items-center justify-between gap-3">
                <span className="truncate text-slate-700 dark:text-slate-200">{account.label}</span>
                <span
                  className={cn(
                    'tabular-nums',
                    account.sufficient
                      ? 'text-slate-700 dark:text-slate-200'
                      : 'font-medium text-amber-600 dark:text-amber-400',
                  )}
                >
                  {fmt(account.balance)}
                </span>
              </li>
            ))}
          </ul>
          {short && (
            <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
              {t('wizard.funding.short', { amount: fmt(funding.netPay) })}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Step 5 — Post & finish                                              */
/* ------------------------------------------------------------------ */

function FinishStep({
  run,
  remittance,
  posted,
  committed,
  canPost,
  busy,
  onPost,
  onEmailStubs,
  onRecordPayment,
  registerReportId,
  bankAccounts,
  funding,
  canRun,
  fmt,
}: {
  run: RunHeader
  remittance: RemittanceRow[]
  posted: boolean
  committed: boolean
  canPost: boolean
  busy: boolean
  onPost: () => void
  onEmailStubs: () => void
  onRecordPayment: (bankAccountId: string) => void
  registerReportId: string | null
  bankAccounts: { id: string; label: string }[]
  funding: Funding
  canRun: boolean
  fmt: (v: string | number | null | undefined) => string
}) {
  const t = useTranslations('payroll')
  if (!committed && !posted) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white px-4 py-10 text-center text-sm text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
        {t('wizard.finish.notCommitted')}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div
        className={cn(
          'flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3.5',
          posted
            ? 'border-emerald-200/80 bg-emerald-50 dark:border-emerald-800/60 dark:bg-emerald-950/40'
            : 'border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900',
        )}
      >
        <div className="flex items-center gap-3">
          {posted ? (
            <CheckCircle2 size={20} className="text-emerald-600 dark:text-emerald-400" aria-hidden />
          ) : (
            <Send size={18} className="text-slate-400" aria-hidden />
          )}
          <div>
            <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              {posted ? t('wizard.finish.postedTitle') : t('wizard.finish.postTitle')}
            </p>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {posted
                ? t('wizard.finish.postedHint', { number: run.document_number })
                : t('wizard.finish.postHint')}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {posted && run.posted_entry_id && (
            <Button asChild size="sm" variant="outline">
              <Link href={`/journal?entry=${run.posted_entry_id}` as never}>
                <BookOpenCheck size={14} aria-hidden />
                {t('wizard.finish.viewJournal')}
              </Link>
            </Button>
          )}
          {posted && run.paid_at && (
            <Badge variant="success">{t('wizard.finish.paid')}</Badge>
          )}
          {posted && run.paid_entry_id && (
            <Button asChild size="sm" variant="ghost">
              <Link href={`/journal?entry=${run.paid_entry_id}` as never}>
                {t('wizard.finish.viewPayment')}
              </Link>
            </Button>
          )}
          {posted && !run.paid_at && canRun && (
            <RecordPaymentControl
              bankAccounts={bankAccounts}
              busy={busy}
              onRecord={onRecordPayment}
            />
          )}
          {committed && (
            <>
              <Button asChild size="sm" variant="outline">
                <a href={`/api/payroll/runs/${run.document_id}/stubs-pdf`} target="_blank" rel="noreferrer">
                  <FileDown size={14} aria-hidden />
                  {t('wizard.finish.printStubs')}
                </a>
              </Button>
              {registerReportId && (
                <Button asChild size="sm" variant="outline">
                  <Link href={`/reports/custom/run/${registerReportId}` as never}>
                    {t('wizard.finish.register')}
                  </Link>
                </Button>
              )}
              {canRun && (
                <Button size="sm" variant="outline" disabled={busy} onClick={onEmailStubs}>
                  <Send size={14} aria-hidden />
                  {t('wizard.finish.emailStubs')}
                </Button>
              )}
            </>
          )}
          {!posted && canPost && (
            <Button onClick={onPost} disabled={busy}>
              {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Send size={14} aria-hidden />}
              {t('run.post')}
            </Button>
          )}
        </div>
      </div>

      {!run.paid_at && <FundingPanel funding={funding} fmt={fmt} />}

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <div className="border-b border-slate-100 px-4 py-3 dark:border-slate-800">
            <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
              {t('wizard.finish.remittanceTitle')}
            </h3>
            <p className="text-xs text-slate-400 dark:text-slate-500">{t('wizard.finish.remittanceHint')}</p>
          </div>
<div className="p-3">
            <PagedTable
              rows={remittance}
              columns={([
                {
                  key: 'account', header: t('wizard.gl.account'),
                  search: (row) => row.account_label,
                  cell: (row) => <span className="font-medium">{row.account_label}</span>,
                },
                {
                  key: 'amount', header: t('wizard.finish.amount'), align: 'right',
                  cell: (row) => fmt(Math.abs(Number(row.amount))),
                },
              ] as PagedColumn<RemittanceRow>[])}
              pageSize={15}
              empty={<p className="p-2 text-sm text-slate-500 dark:text-slate-400">{t('wizard.finish.remittanceHint')}</p>}
              rowKey={(row, index) => `${row.account_label}-${index}`}
              footer={
                <TableRow className="border-t-2 border-slate-200 bg-slate-50 font-semibold dark:border-slate-700 dark:bg-slate-950/40">
                  <TableCell>{t('wizard.finish.netPay')}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(run.net_total)}</TableCell>
                </TableRow>
              }
            />
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <h3 className="mb-2 text-sm font-semibold text-slate-800 dark:text-slate-100">
            {t('wizard.finish.nextTitle')}
          </h3>
          <ul className="space-y-2 text-sm text-slate-600 dark:text-slate-300">
            <li className="flex items-start gap-2">
              <ArrowRight size={14} aria-hidden className="mt-0.5 shrink-0 text-teal-600 dark:text-teal-400" />
              {t('wizard.finish.nextRemit')}
            </li>
            <li className="flex items-start gap-2">
              <ArrowRight size={14} aria-hidden className="mt-0.5 shrink-0 text-teal-600 dark:text-teal-400" />
              {t('wizard.finish.nextPay')}
            </li>
          </ul>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */

function HeaderFact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[11px] font-medium tracking-wide text-slate-400 uppercase dark:text-slate-500">
        {label}
      </dt>
      <dd className="font-medium whitespace-nowrap text-slate-800 tabular-nums dark:text-slate-100">
        {children}
      </dd>
    </div>
  )
}

/** Bank pick + one-click settlement of the run's net-pay open items. */
function RecordPaymentControl({
  bankAccounts,
  busy,
  onRecord,
}: {
  bankAccounts: { id: string; label: string }[]
  busy: boolean
  onRecord: (bankAccountId: string) => void
}) {
  const t = useTranslations('payroll')
  const [bankAccountId, setBankAccountId] = useState(bankAccounts[0]?.id ?? '')
  return (
    <span className="flex items-center gap-2">
      <select
        aria-label={t('wizard.finish.bankAccount')}
        value={bankAccountId}
        onChange={(e) => setBankAccountId(e.target.value)}
        className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
      >
        {bankAccounts.map((account) => (
          <option key={account.id} value={account.id}>{account.label}</option>
        ))}
      </select>
      <Button size="sm" disabled={busy || !bankAccountId} onClick={() => onRecord(bankAccountId)}>
        {t('wizard.finish.recordPayment')}
      </Button>
    </span>
  )
}
