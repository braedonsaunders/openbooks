'use client'

import { useMemo } from 'react'
import { useTranslations } from 'next-intl'
import { buildVizSpec, formatCell } from '../viz'
import type { QueryResult, ResultColumn, VizSettings, VizType } from '../types'
import { InsightChart } from './InsightChart'

/**
 * The single renderer for an executed insight result. Given a QueryResult and a
 * viz type + settings, it draws a table or the appropriate ECharts chart. Used
 * by the card studio's live preview AND the dashboard/home card tiles, so a card
 * looks identical everywhere it appears.
 *
 * Localization: column labels arrive already localized (the API compiles them
 * with the request locale); this component localizes the chrome (empty states)
 * and fixed-vocabulary cell values (ResultColumn.valueKind) via insights.viz.*.
 */
export function InsightResultView({
  result,
  vizType,
  settings,
  chartHeight,
}: {
  result: QueryResult
  vizType: VizType
  settings?: VizSettings
  /** Fixed chart height in px; omit to fill a sized parent. */
  chartHeight?: number
}) {
  const t = useTranslations('insights.viz')

  // Localize fixed-vocabulary dimension values ('yes'/'active'/…) everywhere
  // they surface: chart categories, pie names, and table cells.
  const valueLabel = useMemo(() => {
    return (col: ResultColumn, v: unknown): string | null => {
      if (!col.valueKind || typeof v !== 'string') return null
      const known =
        col.valueKind === 'yesNo'
          ? v === 'yes' || v === 'no'
          : v === 'active' || v === 'inactive'
      return known ? t(`values.${v}`) : null
    }
  }, [t])

  const spec = useMemo(
    () => buildVizSpec(result, vizType, settings ?? {}, valueLabel),
    [result, vizType, settings, valueLabel],
  )

  if (spec.kind === 'empty') {
    return (
      <div className="flex h-full min-h-[8rem] items-center justify-center px-4 py-8 text-center text-sm text-slate-500 dark:text-slate-400">
        {t(`empty.${spec.reason}`)}
      </div>
    )
  }

  if (spec.kind === 'chart') {
    return <InsightChart option={spec.option} height={chartHeight} />
  }

  // table
  return (
    <div className="max-h-full overflow-auto">
      <table className="w-full border-collapse text-sm">
        <thead className="sticky top-0 z-10 bg-slate-50 dark:bg-slate-900">
          <tr className="border-b border-slate-200 dark:border-slate-800">
            {spec.columns.map((c) => (
              <th
                key={c.key}
                className={
                  'px-3 py-2 font-semibold text-slate-600 dark:text-slate-300 ' +
                  (c.type === 'currency' || c.type === 'number' ? 'text-right' : 'text-left')
                }
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {spec.rows.length === 0 ? (
            <tr>
              <td
                colSpan={spec.columns.length}
                className="px-3 py-8 text-center text-slate-500 dark:text-slate-400"
              >
                {t('noRows')}
              </td>
            </tr>
          ) : (
            spec.rows.map((row, i) => (
              <tr
                key={i}
                className="border-b border-slate-100 last:border-0 dark:border-slate-800/60 hover:bg-slate-50 dark:hover:bg-slate-900/40"
              >
                {spec.columns.map((c) => (
                  <td
                    key={c.key}
                    className={
                      'px-3 py-1.5 ' +
                      (c.type === 'currency' || c.type === 'number'
                        ? 'text-right tabular-nums'
                        : 'text-left text-slate-700 dark:text-slate-300')
                    }
                  >
                    {valueLabel(c, row[c.key]) ?? formatCell(row[c.key], c.type)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}
