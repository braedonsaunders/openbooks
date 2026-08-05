'use client'

import { History } from 'lucide-react'
import { useTranslations } from 'next-intl'
import {
  Badge,
  EmptyState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@openbooks/ui'
import { dateTime } from '../../../../../lib/format'

/**
 * Read-only run history for one flow: status, trigger, subject, timing, and
 * any error. Rows come straight from flow_runs via the builder page load.
 */

export type FlowRunRow = {
  id: string
  subject_kind: string
  subject_id: string
  trigger: string
  status: string
  error: string | null
  started_at: string
  finished_at: string | null
}

const STATUS_VARIANT: Record<string, 'success' | 'warning' | 'destructive' | 'secondary' | 'outline'> = {
  completed: 'success',
  waiting: 'warning',
  failed: 'destructive',
  running: 'secondary',
  cancelled: 'outline',
}

const KNOWN_STATUSES = new Set(['running', 'waiting', 'completed', 'failed', 'cancelled'])

export function RunsPanel({ runs }: { runs: FlowRunRow[] }) {
  const t = useTranslations('admin.flows.runs')

  if (runs.length === 0) {
    return (
      <EmptyState
        icon={<History />}
        title={t('empty.title')}
        description={t('empty.description')}
      />
    )
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('table.status')}</TableHead>
          <TableHead>{t('table.trigger')}</TableHead>
          <TableHead>{t('table.subject')}</TableHead>
          <TableHead>{t('table.started')}</TableHead>
          <TableHead>{t('table.finished')}</TableHead>
          <TableHead>{t('table.error')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {runs.map((r) => (
          <TableRow key={r.id}>
            <TableCell>
              <Badge variant={STATUS_VARIANT[r.status] ?? 'outline'}>
                {KNOWN_STATUSES.has(r.status) ? t(`status.${r.status}`) : r.status}
              </Badge>
            </TableCell>
            <TableCell>
              <code className="font-mono text-xs text-slate-600 dark:text-slate-300">{r.trigger}</code>
            </TableCell>
            <TableCell className="text-slate-500 dark:text-slate-400">
              {r.subject_kind.replace(/_/g, ' ')}{' '}
              <span className="font-mono text-[11px] text-slate-400 dark:text-slate-500">
                {r.subject_id.slice(0, 8)}
              </span>
            </TableCell>
            <TableCell className="text-slate-500 tabular-nums dark:text-slate-400">
              {dateTime(r.started_at)}
            </TableCell>
            <TableCell className="text-slate-500 tabular-nums dark:text-slate-400">
              {r.finished_at ? dateTime(r.finished_at) : '—'}
            </TableCell>
            <TableCell className="max-w-[320px]">
              {r.error ? (
                <span className="block truncate text-xs text-red-600 dark:text-red-400" title={r.error}>
                  {r.error}
                </span>
              ) : null}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
