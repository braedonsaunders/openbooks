'use client'

/** Split from RunWizard.tsx; moved without behavior changes. */
import { type StubChange, type StubRow, type RosterRow, type AdjustmentRow, type ComponentOption, VARIANCE_FLAG_PERCENT, withholding } from '../run-wizard-model'
import { BulkEditDrawer } from '../BulkEditDrawer'
import { StubDrawer } from '../StubDrawer'
import { useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { AlertTriangle } from 'lucide-react'
import { Badge, Button, cn } from '@openbooks/ui'
import type { PayRunCalculationError } from '@openbooks/engine/src/payroll/run-calculation-evidence.ts'
import { PagedTable, type PagedColumn } from '../../../../../../components/paged-table'
import { HolidayAttestations } from '../HolidayAttestations'
import { decimalAbs, decimalCmp, decimalPercentChange } from '../../../../../../lib/statement-format'
import { type RegisterBucket } from '../../../../../../lib/payroll-register-buckets'

/* ------------------------------------------------------------------ */
/* Step 3 — Review stubs                                               */
/* ------------------------------------------------------------------ */

export function ReviewStep({
  runId,
  roster,
  stubs,
  previousNet,
  changes,
  calcErrors,
  calculated,
  registerReportId,
  registerBuckets,
  regionLabel,
  traceEngines,
  factorLabels,
  fmt,
  adjustments,
  components,
  canAdjust,
  busy,
  onAdjust,
  onAnswered,
  anomalyBlocks,
}: {
  runId: string
  roster: RosterRow[]
  stubs: StubRow[]
  previousNet: Record<string, string>
  changes: StubChange[]
  calcErrors: PayRunCalculationError[]
  calculated: boolean
  registerReportId: string | null
  registerBuckets: RegisterBucket[]
  regionLabel: string
  traceEngines: Record<string, string>
  factorLabels: Record<string, Record<string, string>>
  fmt: (v: string | number | null | undefined) => string
  adjustments: AdjustmentRow[]
  components: ComponentOption[]
  canAdjust: boolean
  /** Parent in-flight mutation state: disables drawer buttons while a request runs. */
  busy: boolean
  /**
   * True when the edit and its recalculation both landed. Drawers clear,
   * close and rotate their idempotency key only on true — a failure keeps
   * the key so the retry replays instead of duplicating.
   */
  onAdjust: (body: Record<string, unknown>) => Promise<boolean>
  onAnswered: () => void
  /** HR-21: open block-severity anomaly flags — the banner with the link. */
  anomalyBlocks: number
}) {
  const t = useTranslations('payroll')
  const [openStub, setOpenStub] = useState<StubRow | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkOpen, setBulkOpen] = useState(false)
  // Recalculation deletes every pay_stubs row and inserts fresh ones with new
  // ids, so a held snapshot goes stale (amounts) and its PDF link 404s after
  // any adjust. Re-resolve the open employee against the live stubs on every
  // render; a vanished employee (excluded) closes the drawer.
  const liveStub = openStub
    ? (stubs.find((s) => s.employee_party_id === openStub.employee_party_id) ?? null)
    : null

  const changeByEmployee = new Map(changes.map((c) => [c.employeePartyId, c]))

  const variance = (stub: StubRow): { percent: number; flagged: boolean } | null => {
    const prev = previousNet[stub.employee_party_id]
    if (prev == null || decimalCmp(prev, '0') === 0) return null
    const exactPercent = decimalPercentChange(stub.net_pay, prev)
    if (exactPercent === null) return null
    return {
      percent: Number(exactPercent),
      flagged: decimalCmp(decimalAbs(exactPercent), `${VARIANCE_FLAG_PERCENT}.0000`) > 0,
    }
  }

  const flagged = stubs.filter((stub) => variance(stub)?.flagged)
  const excludedRows = adjustments.filter((a) => a.adjustment_type === 'exclude')
  // An unpaid garnishment balance is a real obligation the creditor still
  // expects, so it can never be a silent difference between two stubs.
  const protectionShortfalls = stubs
    .map((stub) => ({ stub, amount: stub.factors?.PROT_SHORT ?? '0' }))
    .filter((entry) => decimalCmp(entry.amount, '0') > 0)
  const allSelected = stubs.length > 0 && stubs.every((s) => selected.has(s.employee_party_id))
  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const refusedCount = calcErrors.filter(
    (entry) => entry.kind !== 'warning' && entry.kind !== 'out-of-scope',
  ).length

  return (
    <div className="space-y-4">
      {/* Zero stubs with refusals is a refused calculation, not an empty one:
          the totals below would otherwise read "£0.00 / 0 employees" as if the
          run simply had nothing to pay. */}
      {calculated && stubs.length === 0 && refusedCount > 0 && (
        <div className="rounded-xl border border-red-200/80 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-800/60 dark:bg-red-950/40 dark:text-red-300">
          <p className="flex items-center gap-2 font-semibold">
            <AlertTriangle size={15} aria-hidden />
            {t('wizard.review.allRefusedTitle', { count: refusedCount })}
          </p>
          <p className="mt-1">{t('wizard.review.allRefusedHint')}</p>
        </div>
      )}
      {anomalyBlocks > 0 && (
        <div className="rounded-xl border border-red-200/80 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-800/60 dark:bg-red-950/40 dark:text-red-300">
          <p className="flex items-center gap-2 font-semibold">
            <AlertTriangle size={15} aria-hidden />
            {t('anomalies.wizardNotice', { count: anomalyBlocks })}
          </p>
          <p className="mt-1">
            <a href="/payroll/anomalies" className="font-medium underline">
              {t('anomalies.wizardLink')}
            </a>
          </p>
        </div>
      )}
      {excludedRows.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm dark:border-slate-800 dark:bg-slate-900">
          <span className="text-slate-500 dark:text-slate-400">{t('wizard.adjust.excludedLabel')}</span>
          {excludedRows.map((row) => (
            <span key={row.id} className="inline-flex items-center gap-1.5 rounded-full border border-slate-300 px-2.5 py-0.5 dark:border-slate-700">
              {row.employee_name}
              {canAdjust && (
                <button
                  className="text-xs font-medium text-teal-700 hover:underline disabled:opacity-50 dark:text-teal-300"
                  disabled={busy}
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
          <HolidayAttestations
            runId={runId}
            errors={calcErrors}
            roster={roster}
            canAnswer={canAdjust}
            onAnswered={onAnswered}
          />
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
              { key: 'region', header: regionLabel, cell: (stub) => stub.province },
              { key: 'gross', header: t('columns.gross'), align: 'right', cell: (stub) => fmt(stub.gross) },
              ...registerBuckets.map((bucket, index) => ({
                key: `withholding-${bucket.code}`,
                header: bucket.label,
                align: 'right' as const,
                cell: (stub: StubRow) => fmt(withholding(stub, registerBuckets).amounts[index] ?? '0'),
              })),
              { key: 'tax', header: t('run.stub.tax'), align: 'right', cell: (stub) => fmt(withholding(stub, registerBuckets).total) },
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

      {liveStub && (
        <StubDrawer
          stub={liveStub}
          variance={variance(liveStub)}
          change={changeByEmployee.get(liveStub.employee_party_id) ?? null}
          onClose={() => setOpenStub(null)}
          fmt={fmt}
          adjustments={adjustments.filter(
            (a) => a.adjustment_type === 'line' && a.employee_party_id === liveStub.employee_party_id,
          )}
          components={components}
          canAdjust={canAdjust}
          busy={busy}
          onAdjust={onAdjust}
          buckets={registerBuckets}
          regionLabel={regionLabel}
          traceEngines={traceEngines}
          factorLabels={factorLabels}
        />
      )}

      {bulkOpen && (
        <BulkEditDrawer
          count={selected.size}
          components={components}
          busy={busy}
          onClose={() => setBulkOpen(false)}
          onApply={async (body) => {
            const applied = await onAdjust({ ...body, action: 'bulk-adjustment', employeePartyIds: [...selected] })
            if (!applied) return
            setBulkOpen(false)
            setSelected(new Set())
          }}
        />
      )}
    </div>
  )
}
