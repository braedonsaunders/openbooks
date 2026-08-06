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
        defaultDrillTarget: drillTarget,
        summary: result.summary,
        groups: result.groups.map((group) => ({
          title: group.title,
          subtitle: group.subtitle,
          columns: group.columns,
          rows: group.rows,
          money: group.money,
          // Section groups drill to exactly their own bucket's rows.
          drillTarget: group.groupKey && drillTarget.kind === 'custom'
            ? { ...drillTarget, label: group.title, filter: group.groupKey }
            : undefined,
          isEmpty: group.isEmpty,
        })),
      }}
    />
  )
}
