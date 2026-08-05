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
  Landmark,
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
import { RunStatusBadge, runDisplayStatus } from '../../_ui/run-status'

export type WizardStep = 'period' | 'review' | 'gl' | 'finish'

export interface RunHeader {
  document_id: string
  document_number: string
  document_status: string
  currency: string
  posted_entry_id: string | null
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

/** Net-pay variance beyond this (either direction) flags a stub for review. */
const VARIANCE_FLAG_PERCENT = 15

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
  /** employee_party_id → net pay on the employee's previous committed stub. */
  previousNet: Record<string, string>
  /** Credit legs by account from the committed document lines (negative). */
  remittance: RemittanceRow[]
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
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('run.stub.employee')}</TableHead>
              <TableHead>{t('profiles.columns.basis')}</TableHead>
              <TableHead className="text-right">{t('wizard.period.approvedHours')}</TableHead>
              <TableHead className="text-right">{calculated ? t('columns.gross') : ''}</TableHead>
              <TableHead>{t('columns.status')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {roster.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-slate-500 dark:text-slate-400">
                  {t('wizard.period.empty')}
                </TableCell>
              </TableRow>
            )}
            {roster.map((row) => {
              const hours = calculated
                ? (stubHours.get(row.employee_party_id) ?? 0)
                : Number(row.approved_hours)
              const stub = stubByEmployee.get(row.employee_party_id)
              const zeroHours = row.pay_basis === 'hourly' && hours === 0
              return (
                <TableRow key={row.employee_party_id}>
                  <TableCell className="font-medium">{row.name}</TableCell>
                  <TableCell>{t(`profiles.basis.${row.pay_basis}`)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.pay_basis === 'hourly' || hours > 0 ? hours.toFixed(2) : '—'}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {calculated && stub ? fmt(stub.gross) : ''}
                  </TableCell>
                  <TableCell>
                    {!row.has_wage ? (
                      <Badge variant="destructive">{t('wizard.period.wageMissing')}</Badge>
                    ) : zeroHours ? (
                      <Badge variant="warning">{t('wizard.period.zeroHours')}</Badge>
                    ) : (
                      <Badge variant="success">{t('wizard.period.ready')}</Badge>
                    )}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
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
}: {
  stubs: StubRow[]
  previousNet: Record<string, string>
  calcErrors: { employee: string; message: string }[]
  calculated: boolean
  fmt: (v: string | number | null | undefined) => string
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

  return (
    <div className="space-y-4">
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
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('run.stub.employee')}</TableHead>
              <TableHead>{t('run.stub.province')}</TableHead>
              <TableHead className="text-right">{t('columns.gross')}</TableHead>
              <TableHead className="text-right">{t('run.stub.cpp')}</TableHead>
              <TableHead className="text-right">{t('run.stub.ei')}</TableHead>
              <TableHead className="text-right">{t('run.stub.tax')}</TableHead>
              <TableHead className="text-right">{t('columns.net')}</TableHead>
              <TableHead className="text-right">{t('wizard.review.varianceColumn')}</TableHead>
              <TableHead className="text-right">{t('run.employerCost')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {stubs.length === 0 && (
              <TableRow>
                <TableCell colSpan={9} className="text-slate-500 dark:text-slate-400">
                  {calculated ? t('run.empty') : t('wizard.review.needsCalculation')}
                </TableCell>
              </TableRow>
            )}
            {stubs.map((stub) => {
              const s = statutory(stub)
              const delta = variance(stub)
              return (
                <TableRow key={stub.id} className="cursor-pointer" onClick={() => setOpenStub(stub)}>
                  <TableCell className="font-medium text-teal-700 dark:text-teal-300">
                    {stub.employee_name}
                  </TableCell>
                  <TableCell>{stub.province}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(stub.gross)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(s.cpp)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(s.ei)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(s.tax)}</TableCell>
                  <TableCell className="text-right font-medium tabular-nums">{fmt(stub.net_pay)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {delta === null ? (
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
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(stub.employer_cost)}</TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>

      {openStub && (
        <StubDrawer
          stub={openStub}
          variance={variance(openStub)}
          onClose={() => setOpenStub(null)}
          fmt={fmt}
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
}: {
  stub: StubRow
  variance: { percent: number; flagged: boolean } | null
  onClose: () => void
  fmt: (v: string | number | null | undefined) => string
}) {
  const t = useTranslations('payroll')
  const s = statutory(stub)
  const factorEntries = Object.entries(stub.factors ?? {}).sort(([a], [b]) => a.localeCompare(b))
  return (
    <Drawer
      open
      onClose={onClose}
      title={stub.employee_name}
      description={t('wizard.review.drawerDescription')}
      footer={
        <div className="flex justify-between gap-2">
          <Button variant="outline" asChild>
            <a href={`/api/payroll/stubs/${stub.id}/pdf`} target="_blank" rel="noreferrer">
              <FileDown size={14} aria-hidden />
              {t('wizard.review.downloadPdf')}
            </a>
          </Button>
          <Button variant="ghost" onClick={onClose}>
            {t('wizard.review.close')}
          </Button>
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
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-sm">
            {factorEntries.map(([key, value]) => (
              <Fragment key={key}>
                <dt className="font-mono text-xs text-slate-500 dark:text-slate-400">{key}</dt>
                <dd className="text-right tabular-nums">{value}</dd>
              </Fragment>
            ))}
          </dl>
        </div>
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
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('wizard.gl.account')}</TableHead>
              <TableHead>{t('wizard.gl.description')}</TableHead>
              <TableHead className="text-right">{t('wizard.gl.debits')}</TableHead>
              <TableHead className="text-right">{t('wizard.gl.credits')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {legRows(debits, false)}
            {legRows(credits, true)}
            <TableRow className="border-t-2 border-slate-200 bg-slate-50 font-semibold dark:border-slate-700 dark:bg-slate-950/40">
              <TableCell colSpan={2}>{t('wizard.gl.balanced')}</TableCell>
              <TableCell className="text-right tabular-nums">{fmt(gl.debitTotal)}</TableCell>
              <TableCell className="text-right tabular-nums">{fmt(creditTotal)}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
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
  fmt,
}: {
  run: RunHeader
  remittance: RemittanceRow[]
  posted: boolean
  committed: boolean
  canPost: boolean
  busy: boolean
  onPost: () => void
  fmt: (v: string | number | null | undefined) => string
}) {
  const t = useTranslations('payroll')
  const [bankBusy, setBankBusy] = useState(false)

  async function createBankFile() {
    setBankBusy(true)
    try {
      const res = await fetch(`/api/payroll/runs/${run.document_id}/bank-file`, { method: 'POST' })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.error ?? 'failed')
      }
      const blob = await res.blob()
      const disposition = res.headers.get('Content-Disposition') ?? ''
      const match = /filename="?([^";]+)"?/.exec(disposition)
      const link = document.createElement('a')
      link.href = URL.createObjectURL(blob)
      link.download = match?.[1] ?? `${run.document_number}-bank-file.txt`
      link.click()
      URL.revokeObjectURL(link.href)
      toast.success(t('wizard.finish.bankFileDone'))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBankBusy(false)
    }
  }

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
          <Button size="sm" variant="outline" onClick={createBankFile} disabled={bankBusy}>
            {bankBusy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Landmark size={14} aria-hidden />}
            {t('wizard.finish.bankFile')}
          </Button>
          {posted && run.posted_entry_id && (
            <Button asChild size="sm" variant="outline">
              <Link href={`/journal?entry=${run.posted_entry_id}` as never}>
                <BookOpenCheck size={14} aria-hidden />
                {t('wizard.finish.viewJournal')}
              </Link>
            </Button>
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
          <Table>
            <TableBody>
              {remittance.map((row, index) => (
                <TableRow key={index}>
                  <TableCell className="font-medium">{row.account_label}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(Math.abs(Number(row.amount)))}</TableCell>
                </TableRow>
              ))}
              <TableRow className="border-t-2 border-slate-200 bg-slate-50 font-semibold dark:border-slate-700 dark:bg-slate-950/40">
                <TableCell>{t('wizard.finish.netPay')}</TableCell>
                <TableCell className="text-right tabular-nums">{fmt(run.net_total)}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
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
