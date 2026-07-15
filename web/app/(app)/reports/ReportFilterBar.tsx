'use client'

import { useCallback } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Select } from '@openbooks/ui'
import {
  PERIOD_PRESETS,
  PERIOD_PRESET_GROUP_LABELS,
  type PeriodPresetGroup,
} from '@openbooks/reports'

type DimOption = { id: string; name: string }

/** Which controls a given report exposes. */
export type ReportControls = {
  /** Show period preset + custom from/to. */
  period?: boolean
  /** Balance-style: custom period collapses to a single "as of" date. */
  asOf?: boolean
  breakout?: boolean
  /** Breakout options to offer (defaults to all). Time breakouts only suit flow reports. */
  breakoutOptions?: ('department' | 'project' | 'location' | 'class' | 'month' | 'quarter')[]
  compare?: boolean
  basis?: boolean
  dimensions?: boolean
  showZero?: boolean
  scale?: boolean
}

const PRESET_GROUP_ORDER: PeriodPresetGroup[] = [
  'fiscal_year',
  'fiscal_quarter',
  'fiscal_half',
  'period',
  'calendar',
  'rolling',
  'days',
  'custom',
]

export function ReportFilterBar({
  controls,
  dimensions,
}: {
  controls: ReportControls
  dimensions?: { departments: DimOption[]; projects: DimOption[]; locations: DimOption[]; classes: DimOption[] }
}) {
  const t = useTranslations('reports.filterBar')
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()

  const setParams = useCallback(
    (updates: Record<string, string | null>) => {
      const next = new URLSearchParams(params.toString())
      for (const [k, v] of Object.entries(updates)) {
        if (v === null || v === '') next.delete(k)
        else next.set(k, v)
      }
      router.replace(`${pathname}?${next.toString()}`)
    },
    [params, pathname, router],
  )

  const period = params.get('period') ?? 'this_fiscal_year'
  const breakout = params.get('breakout') ?? 'none'
  const compare = params.get('compare') ?? 'none'
  const basis = params.get('basis') ?? 'accrual'
  const scale = params.get('scale') ?? 'actual'
  const showZero = params.get('zero') === '1'
  const isCustom = period === 'custom'
  const breakoutOpts = controls.breakoutOptions ?? ['department', 'project', 'location', 'class', 'month', 'quarter']

  const dimSelect = (key: string, label: string, options: DimOption[] | undefined, allLabel: string) =>
    options && options.length ? (
      <Select
        key={key}
        value={params.get(key) ?? ''}
        onChange={(e) => setParams({ [key]: e.target.value })}
        className="w-44"
        aria-label={label}
      >
        <option value="">{allLabel}</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </Select>
    ) : null

  return (
    <div className="flex flex-wrap items-end gap-2">
      {controls.period !== false && (
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-slate-500 dark:text-slate-400">{t('period')}</span>
          <Select
            value={period}
            onChange={(e) => setParams({ period: e.target.value, ...(e.target.value === 'custom' ? {} : { from: null, to: null }) })}
            className="w-56"
            aria-label={t('period')}
          >
            {PRESET_GROUP_ORDER.map((group) => (
              <optgroup key={group} label={PERIOD_PRESET_GROUP_LABELS[group]}>
                {PERIOD_PRESETS.filter((p) => p.group === group).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
        </label>
      )}

      {isCustom && controls.asOf && (
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-slate-500 dark:text-slate-400">{t('asOf')}</span>
          <input
            type="date"
            value={params.get('to') ?? ''}
            onChange={(e) => setParams({ from: e.target.value, to: e.target.value })}
            className="h-9 rounded-md border border-slate-300 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-950"
          />
        </label>
      )}
      {isCustom && !controls.asOf && (
        <>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-slate-500 dark:text-slate-400">{t('from')}</span>
            <input
              type="date"
              value={params.get('from') ?? ''}
              onChange={(e) => setParams({ from: e.target.value })}
              className="h-9 rounded-md border border-slate-300 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-950"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-slate-500 dark:text-slate-400">{t('to')}</span>
            <input
              type="date"
              value={params.get('to') ?? ''}
              onChange={(e) => setParams({ to: e.target.value })}
              className="h-9 rounded-md border border-slate-300 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-950"
            />
          </label>
        </>
      )}

      {controls.breakout && (
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-slate-500 dark:text-slate-400">{t('breakout')}</span>
          <Select value={breakout} onChange={(e) => setParams({ breakout: e.target.value })} className="w-40" aria-label={t('breakout')}>
            <option value="none">{t('breakoutNone')}</option>
            {breakoutOpts.map((b) => (
              <option key={b} value={b}>
                {t(`breakoutOpts.${b}`)}
              </option>
            ))}
          </Select>
        </label>
      )}

      {controls.compare && (
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-slate-500 dark:text-slate-400">{t('compare')}</span>
          <Select value={compare} onChange={(e) => setParams({ compare: e.target.value })} className="w-40" aria-label={t('compare')}>
            <option value="none">{t('compareNone')}</option>
            <option value="prior_period">{t('comparePriorPeriod')}</option>
            <option value="prior_year">{t('comparePriorYear')}</option>
          </Select>
        </label>
      )}

      {controls.basis && (
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-slate-500 dark:text-slate-400">{t('basis')}</span>
          <Select value={basis} onChange={(e) => setParams({ basis: e.target.value })} className="w-32" aria-label={t('basis')}>
            <option value="accrual">{t('basisAccrual')}</option>
            <option value="cash">{t('basisCash')}</option>
          </Select>
        </label>
      )}

      {controls.dimensions && dimensions && (
        <div className="flex flex-wrap items-end gap-2">
          {dimSelect('dept', t('department'), dimensions.departments, t('allDepartments'))}
          {dimSelect('project', t('project'), dimensions.projects, t('allProjects'))}
          {dimSelect('location', t('location'), dimensions.locations, t('allLocations'))}
          {dimSelect('class', t('class'), dimensions.classes, t('allClasses'))}
        </div>
      )}

      {controls.scale && (
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-slate-500 dark:text-slate-400">{t('scale')}</span>
          <Select value={scale} onChange={(e) => setParams({ scale: e.target.value })} className="w-36" aria-label={t('scale')}>
            <option value="actual">{t('scaleActual')}</option>
            <option value="thousands">{t('scaleThousands')}</option>
            <option value="millions">{t('scaleMillions')}</option>
          </Select>
        </label>
      )}

      {controls.showZero && (
        <button
          type="button"
          onClick={() => setParams({ zero: showZero ? null : '1' })}
          className={
            'h-9 self-end rounded-md border px-3 text-sm ' +
            (showZero
              ? 'border-teal-500 bg-teal-50 text-teal-700 dark:bg-teal-950 dark:text-teal-300'
              : 'border-slate-300 text-slate-600 dark:border-slate-700 dark:text-slate-300')
          }
        >
          {t('showZeros')}
        </button>
      )}
    </div>
  )
}
