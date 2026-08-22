'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { AlertTriangle, History, Search } from 'lucide-react'
import { Badge, Button, Drawer, Label, Select, cn } from '@openbooks/ui'
import { PagedTable, type PagedColumn } from '../../../../components/paged-table'
import { useBusinessToday } from '../../../../components/business-date-provider'
import { useMoney } from '../../../../components/money-provider'

/* ------------------------------------------------------------------ */
/* Shapes (mirror engine/src/payroll-retro-store.ts)                   */
/* ------------------------------------------------------------------ */

interface RetroReason {
  source: 'wage_rate' | 'pay_component' | 'unclaimed_time'
  detail: string
}

interface RetroBucket {
  componentId: string | null
  description: string
  projectId: string | null
  departmentId: string | null
  originalAmount: string
  recomputedAmount: string
  previouslySettled: string
  amount: string
  originalHours: string | null
  recomputedHours: string | null
}

interface RetroPeriod {
  candidate: {
    employeePartyId: string
    employeeName: string
    sourcePayRunDocumentId: string
    sourceDocumentNumber: string
    periodStart: string
    periodEnd: string
    payDate: string
    taxYear: number
    reasons: RetroReason[]
  }
  outcome: 'payable' | 'none' | 'overpaid' | 'unavailable'
  difference: {
    originalEarnings: string
    recomputedEarnings: string
    previouslySettled: string
    delta: string
    buckets: RetroBucket[]
  } | null
  blockedReason: string | null
}

interface RetroProposal {
  taxYear: number
  periods: RetroPeriod[]
  employees: { employeePartyId: string; employeeName: string; periods: number; payable: string; overpaid: string }[]
  payableTotal: string
  overpaidTotal: string
  unavailable: number
}

export type RetroSchedule = {
  id: string
  name: string
};


/**
 * Retroactive pay — detect, quantify, review, pay.
 *
 * The screen is the CONTROL, not a convenience: it exists so that no retro
 * amount is ever paid without somebody having seen, per employee per period,
 * what the period paid, what it would pay now, what earlier retro runs already
 * settled, and the difference that leaves. Nothing on this page writes until
 * "Create retro pay run", and that button hands off to the ordinary pay-run
 * wizard for calculate → approve → commit → post.
 *
 * Every number and every refusal comes from the engine
 * (engine/src/payroll-retro.ts and its store). This component computes no
 * money.
 */
export function RetroWorkspace({
  schedules,
  canRun,
}: {
  schedules: RetroSchedule[]
  canRun: boolean
}) {
  const t = useTranslations('payroll')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const { money } = useMoney()
  const today = useBusinessToday()
  const text = (key: string, fallback: string) =>
    t.has(key as never) ? t(key as never) : fallback

  const [scheduleId, setScheduleId] = useState(schedules[0]?.id ?? '')
  const [payDate, setPayDate] = useState(today)
  const [busy, setBusy] = useState(false)
  const [proposal, setProposal] = useState<RetroProposal | null>(null)
  const [excluded, setExcluded] = useState<string[]>([])
  const [open, setOpen] = useState<RetroPeriod | null>(null)

  async function call(action: 'propose' | 'create'): Promise<Record<string, unknown>> {
    const res = await fetch('/api/payroll/retro', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action, payScheduleId: scheduleId, payDate,
        excludeSourcePayRunDocumentIds: excluded,
      }),
    })
    const json = (await res.json()) as Record<string, unknown>
    if (!res.ok) throw new Error(String(json.error ?? 'failed'))
    return json
  }

  async function find() {
    if (!scheduleId) return
    setBusy(true)
    try {
      setProposal((await call('propose')) as unknown as RetroProposal)
      setExcluded([])
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function create() {
    setBusy(true)
    try {
      const result = await call('create')
      router.push(`/payroll/runs/${String(result.documentId)}` as never)
    } catch (error) {
      toast.error((error as Error).message)
      setBusy(false)
    }
  }

  const payable = proposal?.periods.filter((period) => period.outcome === 'payable') ?? []
  const selected = payable.filter(
    (period) => !excluded.includes(period.candidate.sourcePayRunDocumentId),
  )
  const outcomeTone: Record<RetroPeriod['outcome'], string> = {
    payable: 'text-emerald-700 dark:text-emerald-400',
    none: 'text-slate-500 dark:text-slate-400',
    overpaid: 'text-amber-700 dark:text-amber-400',
    unavailable: 'text-red-700 dark:text-red-400',
  }
  const outcomeLabel = (outcome: RetroPeriod['outcome']) =>
    text(`retro.outcome.${outcome}`, {
      payable: 'Owed',
      none: 'Nothing owed',
      overpaid: 'Overpaid — not payable here',
      unavailable: 'Could not be recalculated',
    }[outcome])

  const reasonLabel = (source: RetroReason['source']) =>
    text(`retro.reason.${source}`, {
      wage_rate: 'Backdated wage',
      pay_component: 'Backdated pay component',
      unclaimed_time: 'Hours never paid',
    }[source])

  const columns: PagedColumn<RetroPeriod>[] = [
    {
      key: 'select',
      header: '',
      cell: (row) =>
        row.outcome === 'payable' ? (
          <input
            type="checkbox"
            aria-label={row.candidate.employeeName}
            checked={!excluded.includes(row.candidate.sourcePayRunDocumentId)}
            onClick={(event) => event.stopPropagation()}
            onChange={(event) =>
              setExcluded((current) =>
                event.target.checked
                  ? current.filter((id) => id !== row.candidate.sourcePayRunDocumentId)
                  : [...current, row.candidate.sourcePayRunDocumentId],
              )
            }
          />
        ) : null,
    },
    {
      key: 'employee',
      header: text('retro.columns.employee', 'Employee'),
      cell: (row) => row.candidate.employeeName,
      search: (row) => row.candidate.employeeName,
    },
    {
      key: 'period',
      header: text('retro.columns.period', 'Period paid'),
      cell: (row) => (
        <span className="whitespace-nowrap">
          {row.candidate.periodStart} – {row.candidate.periodEnd}
        </span>
      ),
      search: (row) => `${row.candidate.periodStart} ${row.candidate.periodEnd}`,
    },
    {
      key: 'run',
      header: text('retro.columns.sourceRun', 'Pay run'),
      cell: (row) => row.candidate.sourceDocumentNumber,
      search: (row) => row.candidate.sourceDocumentNumber,
    },
    {
      key: 'old',
      header: text('retro.columns.paid', 'Paid'),
      align: 'right',
      cell: (row) => (row.difference ? money(row.difference.originalEarnings) : '—'),
    },
    {
      key: 'new',
      header: text('retro.columns.shouldHavePaid', 'Should have paid'),
      align: 'right',
      cell: (row) => (row.difference ? money(row.difference.recomputedEarnings) : '—'),
    },
    {
      key: 'settled',
      header: text('retro.columns.alreadySettled', 'Already settled'),
      align: 'right',
      cell: (row) => (row.difference ? money(row.difference.previouslySettled) : '—'),
    },
    {
      key: 'delta',
      header: text('retro.columns.difference', 'Difference'),
      align: 'right',
      cell: (row) => (
        <span className={cn('font-medium tabular-nums', outcomeTone[row.outcome])}>
          {row.difference ? money(row.difference.delta) : '—'}
        </span>
      ),
    },
    {
      key: 'outcome',
      header: text('retro.columns.outcome', 'Outcome'),
      cell: (row) => (
        <Badge
          variant={
            row.outcome === 'payable'
              ? 'success'
              : row.outcome === 'unavailable'
                ? 'destructive'
                : row.outcome === 'overpaid'
                  ? 'warning'
                  : 'secondary'
          }
        >
          {outcomeLabel(row.outcome)}
        </Badge>
      ),
      search: (row) => row.outcome,
    },
  ]

  return (
    <div className="space-y-6">
      {/* Controls */}
      <section className="grid items-end gap-3 rounded-xl border border-slate-200 p-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] dark:border-slate-800">
        <div className="space-y-1.5">
          <Label
            htmlFor="retro-schedule"
            help={text(
              'retro.scheduleHelp',
              'Retroactive pay is quantified against the committed runs of one pay schedule at a time, because a schedule is what defines the periods that were paid.',
            )}
          >
            {text('columns.schedule', 'Pay schedule')}
          </Label>
          <Select id="retro-schedule" value={scheduleId} onChange={(e) => setScheduleId(e.target.value)}>
            {schedules.map((schedule) => (
              <option key={schedule.id} value={schedule.id}>{schedule.name}</option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label
            htmlFor="retro-paydate"
            help={text(
              'retro.payDateHelp',
              'Retro is paid in the current period for work in past ones. This date decides the statutory year in scope and the accounting period the money posts to — that period must be open.',
            )}
          >
            {text('columns.payDate', 'Pay date')}
          </Label>
          <input
            id="retro-paydate"
            type="date"
            value={payDate}
            onChange={(e) => setPayDate(e.target.value)}
            className="h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-950"
          />
        </div>
        <Button onClick={find} disabled={busy || !scheduleId}>
          <Search size={14} aria-hidden />
          {busy ? tCommon('actions.saving') : text('retro.find', 'Find retroactive pay')}
        </Button>
      </section>

      {proposal === null ? (
        <p className="rounded-xl border border-dashed border-slate-200 px-4 py-10 text-center text-sm text-slate-500 dark:border-slate-800 dark:text-slate-400">
          {text(
            'retro.idle',
            'Pick a schedule and a pay date, then look for periods whose pay has changed since they were paid — a wage backdated over them, a pay component effective before them, or approved hours no run ever paid.',
          )}
        </p>
      ) : (
        <>
          {/* Summary */}
          <section className="grid gap-3 sm:grid-cols-4">
            <Tile
              label={text('retro.summary.payable', 'Owed')}
              value={money(proposal.payableTotal)}
              hint={text('retro.summary.payableHint', 'Sum of every positive difference found.')}
            />
            <Tile
              label={text('retro.summary.employees', 'Employees')}
              value={String(new Set(payable.map((p) => p.candidate.employeePartyId)).size)}
            />
            <Tile
              label={text('retro.summary.periods', 'Periods')}
              value={`${selected.length} / ${payable.length}`}
              hint={text('retro.summary.periodsHint', 'Selected periods out of those with money owed.')}
            />
            <Tile
              label={text('retro.summary.taxYear', 'Statutory year')}
              value={String(proposal.taxYear)}
              hint={text(
                'retro.summary.taxYearHint',
                'Only periods in this year are in scope. Retro for a prior year changes year-end slips that have been filed and goes through an amended return instead.',
              )}
            />
          </section>

          {(proposal.unavailable > 0 || Number(proposal.overpaidTotal) < 0) && (
            <section className="space-y-2 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-900 dark:bg-amber-950/40">
              <p className="flex items-center gap-2 font-medium text-amber-900 dark:text-amber-200">
                <AlertTriangle size={14} aria-hidden />
                {text('retro.exceptions', 'Findings that are not payable here')}
              </p>
              {Number(proposal.overpaidTotal) < 0 && (
                <p className="text-amber-900 dark:text-amber-200">
                  {text(
                    'retro.overpaidNote',
                    'A backdated decrease is an overpayment recovery, not retro pay. It has its own consent and notice rules and is never netted into a retro cheque.',
                  )}{' '}
                  <span className="font-medium tabular-nums">{money(proposal.overpaidTotal)}</span>
                </p>
              )}
              {proposal.periods
                .filter((period) => period.outcome === 'unavailable')
                .map((period) => (
                  <p key={`${period.candidate.employeePartyId}:${period.candidate.sourcePayRunDocumentId}`}
                     className="text-amber-900 dark:text-amber-200">
                    {period.candidate.employeeName}: {period.blockedReason}
                  </p>
                ))}
            </section>
          )}

          {/* Review */}
          <section className="space-y-2">
            <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
              {text('retro.reviewTitle', 'Per employee, per period')}
            </h2>
            <PagedTable
              rows={proposal.periods}
              columns={columns}
              rowKey={(row) => `${row.candidate.employeePartyId}:${row.candidate.sourcePayRunDocumentId}`}
              searchable
              pageSize={15}
              onRowClick={(row) => setOpen(row)}
              empty={
                <p className="rounded-xl border border-dashed border-slate-200 px-4 py-8 text-center text-sm text-slate-500 dark:border-slate-800 dark:text-slate-400">
                  {text('retro.none', 'Nothing has changed for any period this schedule has already paid.')}
                </p>
              }
            />
          </section>

          {canRun && selected.length > 0 && (
            <div className="flex items-center justify-end gap-3">
              <p className="text-sm text-slate-500 dark:text-slate-400">
                {text('retro.createHint', 'Creates a draft retroactive pay run you still calculate, approve and commit.')}
              </p>
              <Button onClick={create} disabled={busy}>
                <History size={14} aria-hidden />
                {text('retro.create', 'Create retro pay run')}
              </Button>
            </div>
          )}
        </>
      )}

      {/* Per-period detail */}
      <Drawer
        open={open !== null}
        onClose={() => setOpen(null)}
        size="2xl"
        title={open ? `${open.candidate.employeeName} · ${open.candidate.sourceDocumentNumber}` : ''}
        description={
          open
            ? `${open.candidate.periodStart} – ${open.candidate.periodEnd} · ${text('retro.paidOn', 'paid')} ${open.candidate.payDate}`
            : undefined
        }
      >
        {open && (
          <div className="space-y-5">
            <section className="space-y-1">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                {text('retro.whyTitle', 'Why this period was looked at')}
              </h3>
              <ul className="space-y-1 text-sm">
                {open.candidate.reasons.map((reason, index) => (
                  <li key={index} className="flex gap-2">
                    <Badge variant="secondary">{reasonLabel(reason.source)}</Badge>
                    <span className="text-slate-600 dark:text-slate-300">{reason.detail}</span>
                  </li>
                ))}
              </ul>
            </section>

            {open.blockedReason ? (
              <p className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
                {open.blockedReason}
              </p>
            ) : (
              <section className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  {text('retro.bucketsTitle', 'Where the difference lands')}
                </h3>
                <PagedTable
                  rows={open.difference?.buckets ?? []}
                  columns={[
                    {
                      key: 'what',
                      header: text('retro.columns.line', 'Line'),
                      cell: (row: RetroBucket) => row.description,
                      search: (row: RetroBucket) => row.description,
                    },
                    {
                      key: 'hours',
                      header: text('retro.columns.hours', 'Hours'),
                      align: 'right',
                      cell: (row: RetroBucket) => row.originalHours ?? '—',
                    },
                    {
                      key: 'paid',
                      header: text('retro.columns.paid', 'Paid'),
                      align: 'right',
                      cell: (row: RetroBucket) => money(row.originalAmount),
                    },
                    {
                      key: 'now',
                      header: text('retro.columns.shouldHavePaid', 'Should have paid'),
                      align: 'right',
                      cell: (row: RetroBucket) => money(row.recomputedAmount),
                    },
                    {
                      key: 'settled',
                      header: text('retro.columns.alreadySettled', 'Already settled'),
                      align: 'right',
                      cell: (row: RetroBucket) => money(row.previouslySettled),
                    },
                    {
                      key: 'delta',
                      header: text('retro.columns.difference', 'Difference'),
                      align: 'right',
                      cell: (row: RetroBucket) => (
                        <span className="font-medium tabular-nums">{money(row.amount)}</span>
                      ),
                    },
                  ]}
                  rowKey={(row, index) => `${row.componentId ?? ''}|${row.projectId ?? ''}|${index}`}
                  pageSize={10}
                  empty={
                    <p className="text-sm text-slate-500 dark:text-slate-400">
                      {text('retro.noBuckets', 'Nothing to show.')}
                    </p>
                  }
                />
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {text(
                    'retro.bucketsNote',
                    'Each line is a pay component on a job. The retro is differenced line by line rather than split from a total, so it costs to the jobs the original hours were charged to.',
                  )}
                </p>
              </section>
            )}
          </div>
        )}
      </Drawer>
    </div>
  )
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
        {label}
      </p>
      <p className="mt-1 text-xl font-semibold tabular-nums text-slate-900 dark:text-slate-50">{value}</p>
      {hint ? <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{hint}</p> : null}
    </div>
  )
}
