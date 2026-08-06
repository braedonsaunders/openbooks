'use client'

import { Fragment, useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import {
  AlertTriangle,
  ArrowRight,
  BookOpenCheck,
  Calculator,
  Check,
  CheckCircle2,
  ChevronRight,
  FileDown,
  Loader2,
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

export type WizardStep = 'period' | 'review' | 'gl' | 'finish'

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

  const canCalculate = props.canRun && docDraft && run.run_status !== 'committed'
  const canCommit = props.canRun && docDraft && run.run_status === 'calculated'
  const canPost =
    props.canRun && committed && (run.document_status === 'draft' || run.document_status === 'approved')

  /** Step completion, derived — never client-side bookkeeping. */
  const complete: Record<WizardStep, boolean> = {
    period: calculated,
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

  /** Apply an input adjustment, then recalculate so the stubs stay truthful. */
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
    { key: 'review', label: t('wizard.steps.review') },
    { key: 'gl', label: t('wizard.steps.gl') },
    { key: 'finish', label: t('wizard.steps.finish') },
  ]

  return (
    <div className="space-y-4">
      {/* Run vitals strip */}
      <div className="flex flex-wrap items-center gap-4 text-sm text-slate-600 dark:text-slate-300">
        <RunStatusBadge status={runDisplayStatus(run)} />
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
          canCalculate={canCalculate}
          calculated={calculated}
          busy={busy}
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
          calcErrors={calcErrors}
          calculated={calculated}
          fmt={fmt}
        />
      )}
      {step === 'gl' && (
        <GlStep
          gl={gl}
          calculated={calculated}
          committed={committed || posted}
          canCommit={canCommit}
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
  canCalculate,
  calculated,
  busy,
  onCalculate,
  fmt,
}: {
  run: RunHeader
  roster: RosterRow[]
  stubs: StubRow[]
  canCalculate: boolean
  calculated: boolean
  busy: boolean
  onCalculate: () => void
  fmt: (v: string | number | null | undefined) => string
}) {
  const t = useTranslations('payroll')

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
          </dl>
          {canCalculate && (
            <Button onClick={onCalculate} disabled={busy}>
              {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Calculator size={14} aria-hidden />}
              {calculated ? t('wizard.period.recalculate') : t('run.calculate')}
            </Button>
          )}
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3 dark:border-slate-800">
          <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
            {t('wizard.period.employeesTitle', { count: roster.length })}
          </h3>
          <span className="text-xs text-slate-400 dark:text-slate-500">
            {calculated ? t('wizard.period.calculatedNote') : t('wizard.period.hint')}
          </span>
        </div>
<div className="p-3">
          <PagedTable
            rows={roster}
            columns={([
              {
                key: 'employee', header: t('run.stub.employee'),
                search: (row) => row.name,
                cell: (row) => <span className="font-medium">{row.name}</span>,
              },
              {
                key: 'basis', header: t('profiles.columns.basis'),
                cell: (row) => t(`profiles.basis.${row.pay_basis}`),
              },
              {
                key: 'hours', header: t('wizard.period.approvedHours'), align: 'right',
                cell: (row) => {
                  const hours = calculated
                    ? (stubHours.get(row.employee_party_id) ?? 0)
                    : Number(row.approved_hours)
                  return row.pay_basis === 'hourly' || hours > 0 ? hours.toFixed(2) : '—'
                },
              },
              {
                key: 'gross', header: calculated ? t('columns.gross') : '', align: 'right',
                cell: (row) => {
                  const stub = stubByEmployee.get(row.employee_party_id)
                  return calculated && stub ? fmt(stub.gross) : ''
                },
              },
              {
                key: 'status', header: t('columns.status'),
                cell: (row) => {
                  const hours = calculated
                    ? (stubHours.get(row.employee_party_id) ?? 0)
                    : Number(row.approved_hours)
                  const zeroHours = row.pay_basis === 'hourly' && hours === 0
                  return !row.has_wage ? (
                    <Badge variant="destructive">{t('wizard.period.wageMissing')}</Badge>
                  ) : zeroHours ? (
                    <Badge variant="warning">{t('wizard.period.zeroHours')}</Badge>
                  ) : (
                    <Badge variant="success">{t('wizard.period.ready')}</Badge>
                  )
                },
              },
            ] as PagedColumn<RosterRow>[])}
            pageSize={15}
            searchable
            empty={<p className="p-2 text-sm text-slate-500 dark:text-slate-400">{t('wizard.period.empty')}</p>}
            rowKey={(row) => row.employee_party_id}
          />
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Step 2 — Review stubs                                               */
/* ------------------------------------------------------------------ */

function ReviewStep({
  stubs,
  previousNet,
  calcErrors,
  calculated,
  fmt,
  adjustments,
  components,
  canAdjust,
  onAdjust,
}: {
  stubs: StubRow[]
  previousNet: Record<string, string>
  calcErrors: { employee: string; message: string }[]
  calculated: boolean
  fmt: (v: string | number | null | undefined) => string
  adjustments: AdjustmentRow[]
  components: ComponentOption[]
  canAdjust: boolean
  onAdjust: (body: Record<string, unknown>) => Promise<void>
}) {
  const t = useTranslations('payroll')
  const [openStub, setOpenStub] = useState<StubRow | null>(null)

  const variance = (stub: StubRow): { percent: number; flagged: boolean } | null => {
    const prev = Number(previousNet[stub.employee_party_id] ?? NaN)
    if (!Number.isFinite(prev) || prev === 0) return null
    const percent = ((Number(stub.net_pay) - prev) / prev) * 100
    return { percent, flagged: Math.abs(percent) > VARIANCE_FLAG_PERCENT }
  }

  const flagged = stubs.filter((stub) => variance(stub)?.flagged)
  const excludedRows = adjustments.filter((a) => a.adjustment_type === 'exclude')

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
      {flagged.length > 0 && (
        <div className="flex items-center gap-2 rounded-xl border border-sky-200/80 bg-sky-50 px-4 py-3 text-sm text-sky-800 dark:border-sky-800/60 dark:bg-sky-950/40 dark:text-sky-300">
          <AlertTriangle size={15} aria-hidden />
          {t('wizard.review.varianceFlag', { count: flagged.length, percent: VARIANCE_FLAG_PERCENT })}
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
<div className="p-3">
          <PagedTable
            rows={stubs}
            columns={([
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
    </div>
  )
}

/** One employee's stub — the house flyout: header facts, pay lines, the T4127
 * factor trace, and the variance flag, with the paystub PDF one click away. */
function StubDrawer({
  stub,
  variance,
  onClose,
  fmt,
  adjustments,
  components,
  canAdjust,
  onAdjust,
}: {
  stub: StubRow
  variance: { percent: number; flagged: boolean } | null
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
  busy,
  onRetry,
  onCommit,
  fmt,
}: {
  gl: { state: 'idle' | 'loading' | 'ready' | 'setup-error'; legs: GlLeg[]; debitTotal: string; error: string }
  calculated: boolean
  committed: boolean
  canCommit: boolean
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
        {canCommit && (
          <Button onClick={onCommit} disabled={busy}>
            {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <CheckCircle2 size={14} aria-hidden />}
            {t('run.commit')}
          </Button>
        )}
        {committed && (
          <Badge variant="default">{t('status.committed')}</Badge>
        )}
      </div>

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

/* ------------------------------------------------------------------ */
/* Step 4 — Post & finish                                              */
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
