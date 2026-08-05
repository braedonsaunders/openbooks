'use client'

import { useTranslations } from 'next-intl'
import { Badge } from '@openbooks/ui'

/**
 * Shared pay-run status language: the document's posted state trumps the run
 * lifecycle (draft → calculated → committed), so one badge tells the whole
 * story everywhere (dashboard cards, wizard header, runs list).
 */

export function runDisplayStatus(run: { document_status: string; run_status: string }): string {
  if (run.document_status === 'posted') return 'posted'
  if (run.document_status === 'void' || run.document_status === 'voided') return 'void'
  return run.run_status
}

export function RunStatusBadge({ status }: { status: string }) {
  const t = useTranslations('payroll')
  const variant =
    status === 'posted'
      ? 'success'
      : status === 'committed'
        ? 'default'
        : status === 'calculated'
          ? 'warning'
          : status === 'void'
            ? 'destructive'
            : 'secondary'
  return <Badge variant={variant}>{t(`status.${status}`)}</Badge>
}
