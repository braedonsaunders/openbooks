'use client'

import { useTranslations } from 'next-intl'
import type { ReportRunResult } from '@openbooks/reports'
import { PaperView } from '../PaperView'

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
}: {
  company: string
  title: string
  description?: string | null
  result: ReportRunResult
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
        groups: result.groups.map((group) => ({
          title: group.title,
          subtitle: group.subtitle,
          columns: group.columns,
          rows: group.rows,
          isEmpty: group.isEmpty,
        })),
      }}
    />
  )
}
