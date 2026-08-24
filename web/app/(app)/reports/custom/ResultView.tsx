'use client'

import { useTranslations } from 'next-intl'
import type { ReportRunResult } from '@openbooks/reports'
import { PaperView } from '../PaperView'
import type { ReportDrillTarget } from '../../../../lib/report-drill'
import { resultGroupsForPaper } from './paper-groups'

/**
 * Render a ReportRunResult exactly as the engine shapes it: a summary band of
 * key figures, then one section per group (rows mode with a groupBy yields
 * several; summarize/plain rows yield one). Shared by the studio live preview
 * and the run/view page.
 */

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
        groups: resultGroupsForPaper(result, drillTarget),
      }}
    />
  )
}
