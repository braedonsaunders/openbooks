'use client'

import { useCallback, useState, type ReactNode } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { SlidersHorizontal } from 'lucide-react'
import { Button, Popover, Select, cn } from '@openbooks/ui'
import { PERIOD_PRESETS, PERIOD_PRESET_GROUP_LABELS, type PeriodPresetGroup } from '@openbooks/reports'

type DimOption = { id: string; name: string }

/** Which controls a given report exposes. */
export type ReportControls = {
  period?: boolean
  /** Balance-style: custom period collapses to a single "as of" date. */
  asOf?: boolean
  breakout?: boolean
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

const SELECT = 'h-8 w-auto min-w-0 border-0 bg-transparent px-1.5 text-sm font-medium shadow-none hover:bg-slate-100 dark:hover:bg-slate-800'
const DATE = 'h-8 rounded-md border border-slate-200 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-950'

/** A compact inline control: tiny uppercase label + the control, on one line. */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex items-center gap-1.5">
      <span className="text-[10px] font-semibold tracking-wider text-slate-400 uppercase dark:text-slate-500">{label}</span>
      {children}
    </label>
  )
}

/**
 * The report toolbar — every control on ONE compact row (inline labels, low-
 * chrome selects), with the report's actions (Save view, Export…) pinned to the
 * right. The report title lives above it in the PageHeader.
 */
export function ReportFilterBar({
  controls,
  dimensions,
  actions,
}: {
  controls: ReportControls
  dimensions?: { departments: DimOption[]; projects: DimOption[]; locations: DimOption[]; classes: DimOption[] }
  actions?: ReactNode
}) {
  const t = useTranslations('reports.filterBar')
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const [optionsOpen, setOptionsOpen] = useState(false)

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

  // Dimension filters carry no inline label — the value ("All departments", a
  // department name, …) is self-describing, which keeps the toolbar on one row.
  const dimSelect = (key: string, label: string, options: DimOption[] | undefined, allLabel: string) =>
    options && options.length ? (
      <Select key={key} value={params.get(key) ?? ''} onChange={(e) => setParams({ [key]: e.target.value })} className={SELECT} aria-label={label}>
        <option value="">{allLabel}</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </Select>
    ) : null

  return (
    <div className="flex flex-wrap items-center gap-x-1 gap-y-2 rounded-xl border border-slate-200 bg-slate-50/60 px-2 py-1.5 dark:border-slate-800 dark:bg-slate-900/40">
      {controls.period !== false && (
        <Field label={controls.asOf ? t('asOf') : t('period')}>
          <Select
            value={period}
            onChange={(e) => setParams({ period: e.target.value, ...(e.target.value === 'custom' ? {} : { from: null, to: null }) })}
            className={cn(SELECT, 'font-semibold')}
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
        </Field>
      )}

      {isCustom && controls.asOf && (
        <input type="date" value={params.get('to') ?? ''} onChange={(e) => setParams({ from: e.target.value, to: e.target.value })} className={DATE} />
      )}
      {isCustom && !controls.asOf && (
        <>
          <input type="date" value={params.get('from') ?? ''} onChange={(e) => setParams({ from: e.target.value })} className={DATE} aria-label={t('from')} />
          <span className="text-slate-400">–</span>
          <input type="date" value={params.get('to') ?? ''} onChange={(e) => setParams({ to: e.target.value })} className={DATE} aria-label={t('to')} />
        </>
      )}

      {controls.breakout && (
        <Field label={t('breakout')}>
          <Select value={breakout} onChange={(e) => setParams({ breakout: e.target.value })} className={SELECT} aria-label={t('breakout')}>
            <option value="none">{t('breakoutNone')}</option>
            {breakoutOpts.map((b) => (
              <option key={b} value={b}>
                {t(`breakoutOpts.${b}`)}
              </option>
            ))}
          </Select>
        </Field>
      )}

      {controls.compare && (
        <Field label={t('compare')}>
          <Select value={compare} onChange={(e) => setParams({ compare: e.target.value })} className={SELECT} aria-label={t('compare')}>
            <option value="none">{t('compareNone')}</option>
            <option value="prior_period">{t('comparePriorPeriod')}</option>
            <option value="prior_year">{t('comparePriorYear')}</option>
          </Select>
        </Field>
      )}

      {controls.dimensions && dimensions && (
        <>
          {dimSelect('dept', t('department'), dimensions.departments, t('allDepartments'))}
          {dimSelect('project', t('project'), dimensions.projects, t('allProjects'))}
          {dimSelect('location', t('location'), dimensions.locations, t('allLocations'))}
          {dimSelect('class', t('class'), dimensions.classes, t('allClasses'))}
        </>
      )}

      {/* Display controls (basis / scale / show-zeros) tuck into one popover so
          the toolbar stays a single row. */}
      {(controls.basis || controls.scale || controls.showZero) && (
        <Popover
          open={optionsOpen}
          onOpenChange={setOptionsOpen}
          align="start"
          trigger={
            <button
              type="button"
              onClick={() => setOptionsOpen((o) => !o)}
              className="flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
            >
              <SlidersHorizontal size={14} /> {t('options')}
            </button>
          }
        >
          <div className="w-56 space-y-3 p-3">
            {controls.basis && (
              <label className="flex items-center justify-between gap-2 text-sm">
                <span className="text-slate-500 dark:text-slate-400">{t('basis')}</span>
                <Select value={basis} onChange={(e) => setParams({ basis: e.target.value })} className="h-8 w-32" aria-label={t('basis')}>
                  <option value="accrual">{t('basisAccrual')}</option>
                  <option value="cash">{t('basisCash')}</option>
                </Select>
              </label>
            )}
            {controls.scale && (
              <label className="flex items-center justify-between gap-2 text-sm">
                <span className="text-slate-500 dark:text-slate-400">{t('scale')}</span>
                <Select value={scale} onChange={(e) => setParams({ scale: e.target.value })} className="h-8 w-32" aria-label={t('scale')}>
                  <option value="actual">{t('scaleActual')}</option>
                  <option value="thousands">{t('scaleThousands')}</option>
                  <option value="millions">{t('scaleMillions')}</option>
                </Select>
              </label>
            )}
            {controls.showZero && (
              <label className="flex cursor-pointer items-center justify-between gap-2 text-sm">
                <span className="text-slate-500 dark:text-slate-400">{t('showZeros')}</span>
                <input type="checkbox" checked={showZero} onChange={() => setParams({ zero: showZero ? null : '1' })} className="h-4 w-4 accent-teal-600" />
              </label>
            )}
          </div>
        </Popover>
      )}

      {actions && <div className="ml-auto flex items-center gap-1.5">{actions}</div>}
    </div>
  )
}
