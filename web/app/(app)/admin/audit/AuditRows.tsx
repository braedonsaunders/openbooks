'use client'

import { PagedTable } from '../../../../components/paged-table'
import { useRouter, useSearchParams } from 'next/navigation'
import { useFormatter, useTranslations } from 'next-intl'
import { Badge } from '@openbooks/ui'
import { ChevronRight } from 'lucide-react'

export type AuditListRow = {
  id: string
  rowId: string
  at: string
  actorName: string | null
  action: string
  recordType: string
  summaryKind: 'snapshot' | 'metadata' | 'fields'
  changeCount: number
}

const ACTION_VARIANT: Record<string, 'success' | 'secondary' | 'warning' | 'destructive' | 'outline'> = {
  insert: 'success',
  update: 'secondary',
  delete: 'destructive',
  post: 'success',
  void: 'warning',
  approve: 'success',
  reject: 'destructive',
}

const KNOWN_ACTIONS = new Set([
  'insert',
  'update',
  'delete',
  'post',
  'void',
  'approve',
  'reject',
])
const ACRONYMS = new Set(['api', 'fx', 'gl', 'id', 'url'])

const humanize = (value: string) =>
  value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .split(' ')
    .map((word) =>
      ACRONYMS.has(word.toLowerCase())
        ? word.toUpperCase()
        : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(' ')

export function AuditRows({
  rows,
  selectedId,
}: {
  rows: AuditListRow[]
  selectedId?: string
}) {
  const t = useTranslations('admin.audit')
  const format = useFormatter()
  const router = useRouter()
  const searchParams = useSearchParams()
  const actionLabel = (action: string) =>
    KNOWN_ACTIONS.has(action)
      ? t(`actions.${action}` as never)
      : humanize(action)
  const when = (row: AuditListRow) =>
    format.dateTime(new Date(row.at), {
      dateStyle: 'medium',
      timeStyle: 'short',
    })

  function openEvent(id: string) {
    const next = new URLSearchParams(searchParams.toString())
    next.set('event', id)
    router.push(`/admin/audit?${next.toString()}`)
  }

  return (
    <PagedTable
      source="admin_audit"
      rows={rows}
      rowKey={(row) => row.id}
      empty=""
      rowClassName={() =>
        'group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-500'
      }
      onRowClick={(row) => openEvent(row.id)}
      rowRole="link"
      rowSelected={(row) => selectedId === row.id}
      rowLabel={(row) =>
        t('openEventAria', {
          action: actionLabel(row.action),
          recordType: humanize(row.recordType),
          when: when(row),
        })
      }
      columns={[
        {
          key: 'at',
          header: t('table.when'),
          className: 'whitespace-nowrap',
          cell: when,
        },
        {
          key: 'actor',
          header: t('table.actor'),
          cell: (row) =>
            row.actorName ?? (
              <span className="text-slate-400">{t('systemActor')}</span>
            ),
        },
        {
          key: 'action',
          header: t('table.action'),
          cell: (row) => (
            <Badge variant={ACTION_VARIANT[row.action] ?? 'secondary'}>
              {actionLabel(row.action)}
            </Badge>
          ),
        },
        {
          key: 'recordType',
          header: t('table.tableName'),
          className: 'font-medium text-slate-800 dark:text-slate-200',
          cell: (row) => humanize(row.recordType),
        },
        {
          key: 'rowId',
          header: t('table.row'),
          className: 'font-mono text-xs text-slate-500 dark:text-slate-400',
          cell: (row) => `${row.rowId.slice(0, 8)}…`,
        },
        {
          key: 'details',
          header: t('table.changes'),
          cell: (row) => {
            const summary =
              row.summaryKind === 'snapshot'
                ? t('summaries.snapshot')
                : row.summaryKind === 'metadata'
                  ? t('summaries.metadata')
                  : t('summaries.changeCount', { count: row.changeCount })
            return (
              <span className="flex items-center justify-between gap-3 text-sm text-slate-500 dark:text-slate-400">
                <span>{summary}</span>
                <ChevronRight
                  size={16}
                  aria-hidden
                  className="shrink-0 text-slate-300 transition-transform group-hover:translate-x-0.5 group-hover:text-teal-600 dark:text-slate-600 dark:group-hover:text-teal-400"
                />
              </span>
            )
          },
        },
      ]}
    />
  )
}
