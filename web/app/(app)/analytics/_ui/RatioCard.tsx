'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Info } from 'lucide-react'
import { Popover, cn } from '@openbooks/ui'
import type { RatioResult } from '../../../../lib/analytics/financial-health'
import { useRatioFormat, GRADE_STYLE, GRADE_TINT } from './format'

export interface RatioDef {
  label: string
  formula: string
  desc: string
  interpret: string
}

/**
 * A single graded ratio tile. Colour-tinted by letter grade, shows the value
 * and its target, and opens a detail popover (formula, interpretation, how it
 * was measured and the actual numerator/denominator) on click. An
 * unavailable ratio shows the engine's reason — never a zero.
 */
export function RatioCard({ data, def }: { data: RatioResult; def: RatioDef }) {
  const format = useRatioFormat()
  const t = useTranslations('analytics.financialHealth')
  const [open, setOpen] = useState(false)
  const value = format(data.value, data.format)
  const target = format(data.benchmark, data.format)
  const unavailable = value === null
  const graded = !unavailable && data.grade !== null
  const shown = value ?? t('ratioCard.notAvailable')

  const card = (
    <button
      type="button"
      onClick={() => setOpen((o) => !o)}
      className={cn(
        'group w-full rounded-lg border p-3 text-left transition-all duration-200 hover:-translate-y-0.5 hover:shadow-sm focus-visible:ring-2 focus-visible:ring-teal-500/40 focus-visible:outline-none',
        graded ? GRADE_TINT[data.grade!] : 'border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900/40',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="truncate text-xs font-medium text-slate-500 dark:text-slate-400">{def.label}</span>
        {graded ? (
          <span className={cn('rounded px-1.5 py-0.5 text-[11px] font-bold', GRADE_STYLE[data.grade!])}>{data.grade}</span>
        ) : (
          <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-bold text-slate-500 dark:bg-slate-700 dark:text-slate-300">
            {unavailable ? t('ratioCard.notAvailable') : t('ratioCard.ungraded')}
          </span>
        )}
      </div>
      <div className="mt-1 text-lg font-bold text-slate-900 tabular-nums dark:text-slate-100">{shown}</div>
      {unavailable ? (
        <div className="mt-0.5 flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400">
          <Info size={11} className="shrink-0" />
          <span className="truncate">{data.unavailable}</span>
        </div>
      ) : (
        <div className="mt-0.5 text-[11px] text-slate-400 dark:text-slate-500">
          {target === null ? t('ratioCard.noTarget') : t('ratioCard.target', { target })}
        </div>
      )}
    </button>
  )

  return (
    <Popover trigger={card} open={open} onOpenChange={setOpen} align="start" side="bottom" className="w-80">
      <div className="space-y-3 p-4">
        <div className="flex items-center justify-between gap-3">
          <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{def.label}</h4>
          {graded ? <span className={cn('rounded px-2 py-0.5 text-xs font-bold', GRADE_STYLE[data.grade!])}>{data.grade}</span> : null}
        </div>
        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-bold text-slate-900 tabular-nums dark:text-slate-100">{shown}</span>
          {!unavailable && target !== null ? (
            <span className="text-xs text-slate-400">{t('ratioCard.versusTarget', { target })}</span>
          ) : null}
        </div>
        {unavailable ? <p className="text-xs text-amber-600 dark:text-amber-400">{data.unavailable}</p> : null}
        <dl className="space-y-2 text-xs">
          <div>
            <dt className="font-semibold text-slate-500 uppercase dark:text-slate-400">{t('ratioCard.formula')}</dt>
            <dd className="mt-0.5 font-mono text-slate-700 dark:text-slate-300">{def.formula}</dd>
          </div>
          <div>
            <dt className="font-semibold text-slate-500 uppercase dark:text-slate-400">{t('ratioCard.meaning')}</dt>
            <dd className="mt-0.5 text-slate-600 dark:text-slate-300">{def.desc}</dd>
          </div>
          <div>
            <dt className="font-semibold text-slate-500 uppercase dark:text-slate-400">{t('ratioCard.interpretation')}</dt>
            <dd className="mt-0.5 text-slate-600 dark:text-slate-300">{def.interpret}</dd>
          </div>
          {!unavailable && data.calc ? (
            <div className="border-t border-slate-100 pt-2 dark:border-slate-800">
              <dt className="font-semibold text-slate-500 uppercase dark:text-slate-400">{t('ratioCard.thisPeriod')}</dt>
              <dd className="mt-0.5 font-mono text-slate-700 dark:text-slate-300">{data.calc}</dd>
              {data.basis ? <dd className="mt-0.5 text-slate-500 dark:text-slate-400">{data.basis}</dd> : null}
            </div>
          ) : null}
        </dl>
      </div>
    </Popover>
  )
}
