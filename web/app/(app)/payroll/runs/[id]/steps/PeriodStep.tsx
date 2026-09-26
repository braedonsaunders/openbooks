'use client'

/** Split from RunWizard.tsx; moved without behavior changes. */
import { type RunHeader, type StubRow, type RosterRow, type AdjustmentRow, ROSTER_DIMENSIONS, type RosterDimension, dimensionOptions, runTypeLabel } from '../run-wizard-model'
import { HeaderFact } from '../run-wizard-controls'
import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { ArrowRight } from 'lucide-react'
import { Badge, Button, cn } from '@openbooks/ui'
import { FilterChips } from '../../../../../../components/filter-bar'
import { PagedTable, type PagedColumn } from '../../../../../../components/paged-table'

/* ------------------------------------------------------------------ */
/* Step 1 — Period & employees                                         */
/* ------------------------------------------------------------------ */

export function PeriodStep({
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
  // One filter state per axis the roster actually carries. Every axis is
  // ALWAYS rendered — an axis with no values shows disabled rather than
  // disappearing, so the toolbar does not silently change shape between one
  // pay schedule and the next (a schedule where nobody has a department used
  // to lose its filter row entirely).
  const [dimension, setDimension] = useState<Record<RosterDimension, string>>({
    department: '', trade: '', job_title: '', subsidiary: '', payment_method: '',
  })
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

  const visible = roster.filter((row) => {
    const f = flagsOf(row)
    for (const axis of ROSTER_DIMENSIONS) {
      if (dimension[axis] && (row[axis] ?? '') !== dimension[axis]) return false
    }
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
            <HeaderFact label={t('wizard.period.runType')}>{runTypeLabel(t, run.run_type)}</HeaderFact>
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
            {ROSTER_DIMENSIONS.map((axis) => {
              const options = dimensionOptions(roster, axis, (value) =>
                axis === 'payment_method' ? t(`paymentMethod.${value}`) : value)
              return (
                <FilterChips
                  key={axis}
                  paramKey={axis}
                  label={t(`wizard.period.dimension.${axis}`)}
                  allLabel={t('wizard.period.dimension.all')}
                  options={options}
                  value={dimension[axis]}
                  onChange={(value) => setDimension((current) => ({ ...current, [axis]: value }))}
                  disabled={options.length === 0}
                />
              )
            })}
            <FilterChips
              paramKey="basis"
              label={t('profiles.columns.basis')}
              allLabel={t('wizard.period.allBases')}
              options={(['hourly', 'salary'] as const).map((value) => ({
                value,
                label: t(`profiles.basis.${value}`),
                count: roster.filter((row) => row.pay_basis === value).length,
              }))}
              value={basis}
              onChange={setBasis}
            />
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
                // How this person's money leaves. Cheque is a normal answer,
                // not a defect — so it is stated plainly, not badged as a risk.
                key: 'payment_method', header: t('wizard.period.dimension.payment_method'),
                search: (row: RosterRow) => row.payment_method,
                cell: (row: RosterRow) => (
                  <span className="text-slate-600 dark:text-slate-300">
                    {t(`paymentMethod.${row.payment_method}`)}
                  </span>
                ),
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
