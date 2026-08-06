'use client'

import { useTranslations } from 'next-intl'
import type { ReportRunResult } from '@openbooks/reports'
import { PaperView } from '../PaperView'
import type { ReportDrillTarget } from '../../../../lib/report-drill'

/**
 * Render a ReportRunResult exactly as the engine shapes it: a summary band of
 * key figures, then one section per group (rows mode with a groupBy yields
 * several; summarize/plain rows yield one). Shared by the studio live preview
 * and the run/view page.
 */
const NUMERIC_CELL = /^-?[\d,]+(\.\d+)?$/

export function ResultView({
  company,
  title,
  description,
  result,
  drillTarget,
}: {
  company: string
  title: string
  description?: string | null
  result: ReportRunResult
  drillTarget: ReportDrillTarget
}) {
  const t = useTranslations('reports.custom.resultView')
  return (
    <PaperView
      company={company}
      emptyLabel={t('noRows')}
      data={{
        title,
        periodPhrase: description || undefined,
        summary: result.summary,
        // Drills exist ONLY where a number decomposes into records: summarize
        // aggregates, scoped to their exact bucket. Rows-mode cells ARE the
        // record — nothing behind them, so no drill.
        groups: result.groups.map((group) => ({
          title: group.title,
          subtitle: group.subtitle,
          columns: group.columns,
          rows: group.rows,
          money: group.money,
          drills: group.kind === 'summary' && group.rowKeys && drillTarget.kind === 'custom'
            ? group.rows.map((row, ri) => {
                const scope = group.rowKeys?.[ri]
                if (!scope) return row.map(() => undefined)
                return row.map((cell) =>
                  (typeof cell === 'number' || (typeof cell === 'string' && NUMERIC_CELL.test(cell.trim())))
                    ? { ...drillTarget, filter: scope }
                    : undefined,
                )
              })
            : undefined,
          isEmpty: group.isEmpty,
        })),
      }}
    />
  )
}
