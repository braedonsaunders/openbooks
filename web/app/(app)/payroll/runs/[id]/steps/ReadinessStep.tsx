'use client'

/** Split from RunWizard.tsx; moved without behavior changes. */
import { READINESS_CODE_FALLBACK, type ReadinessItem, type Readiness, type RosterRow } from '../run-wizard-model'
import { HeaderFact } from '../run-wizard-controls'
import { useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { AlertTriangle, Beaker, Calculator, CheckCircle2, Loader2 } from 'lucide-react'
import { Button, cn } from '@openbooks/ui'
import { HolidayAttestations } from '../HolidayAttestations'

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
export function ReadinessStep({
  runId,
  roster,
  readiness,
  canCalculate,
  calculated,
  busy,
  dry,
  onDryRun,
  onCalculate,
  onAnswered,
  fmt,
}: {
  runId: string
  roster: RosterRow[]
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
  onAnswered: () => void
  fmt: (v: string | number | null | undefined) => string
}) {
  const t = useTranslations('payroll')
  const [acknowledged, setAcknowledged] = useState(false)

  const blockers = readiness.items.filter((i) => i.severity === 'blocker')
  const warnings = readiness.items.filter((i) => i.severity === 'warning')
  const needsAck = warnings.length > 0 && !acknowledged
  // A readiness code with no message must still be READABLE. Rendering the raw
  // key ("…codes.employee.noOpeningBalance") on the one screen that decides
  // whether a payday is safe to run is worse than an untranslated sentence.
  const label = (item: ReadinessItem) =>
    t.has(`wizard.readiness.codes.${item.code}` as never)
      ? t(`wizard.readiness.codes.${item.code}`, {
          count: item.employees.length,
          detail: item.detail ?? '',
        })
      : (READINESS_CODE_FALLBACK[item.code]?.(item.employees.length, item.detail ?? '') ?? item.code)

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
          {dry.errors.length > 0 && (
            <HolidayAttestations
              runId={runId}
              errors={dry.errors}
              roster={roster}
              canAnswer={canCalculate}
              onAnswered={onAnswered}
            />
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
