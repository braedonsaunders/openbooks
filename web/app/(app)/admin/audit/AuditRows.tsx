'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useFormatter, useTranslations } from 'next-intl'
import { Badge, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
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

const KNOWN_ACTIONS = new Set(['insert', 'update', 'delete', 'post', 'void', 'approve', 'reject'])
const ACRONYMS = new Set(['api', 'fx', 'gl', 'id', 'url'])

const humanize = (value: string) => value
  .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  .replace(/[_-]+/g, ' ')
  .split(' ')
  .map((word) => ACRONYMS.has(word.toLowerCase()) ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1))
  .join(' ')

export function AuditRows({ rows, selectedId }: { rows: AuditListRow[]; selectedId?: string }) {
  const t = useTranslations('admin.audit')
  const format = useFormatter()
  const router = useRouter()
  const searchParams = useSearchParams()

  const actionLabel = (action: string) => KNOWN_ACTIONS.has(action)
    ? t(`actions.${action}` as never)
    : humanize(action)

  function openEvent(id: string) {
    const next = new URLSearchParams(searchParams.toString())
    next.set('event', id)
    router.push(`/admin/audit?${next.toString()}`)
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('table.when')}</TableHead>
          <TableHead>{t('table.actor')}</TableHead>
          <TableHead>{t('table.action')}</TableHead>
          <TableHead>{t('table.tableName')}</TableHead>
          <TableHead>{t('table.row')}</TableHead>
          <TableHead>{t('table.changes')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const when = format.dateTime(new Date(row.at), { dateStyle: 'medium', timeStyle: 'short' })
          const summary = row.summaryKind === 'snapshot'
            ? t('summaries.snapshot')
            : row.summaryKind === 'metadata'
              ? t('summaries.metadata')
              : t('summaries.changeCount', { count: row.changeCount })
          return (
            <TableRow
              key={row.id}
              data-state={selectedId === row.id ? 'selected' : undefined}
              role="link"
              tabIndex={0}
              aria-label={t('openEventAria', { action: actionLabel(row.action), recordType: humanize(row.recordType), when })}
              onClick={() => openEvent(row.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  openEvent(row.id)
                }
              }}
              className="group cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-500"
            >
              <TableCell className="whitespace-nowrap">{when}</TableCell>
              <TableCell>{row.actorName ?? <span className="text-slate-400">{t('systemActor')}</span>}</TableCell>
              <TableCell>
                <Badge variant={ACTION_VARIANT[row.action] ?? 'secondary'}>{actionLabel(row.action)}</Badge>
              </TableCell>
              <TableCell className="font-medium text-slate-800 dark:text-slate-200">{humanize(row.recordType)}</TableCell>
              <TableCell className="font-mono text-xs text-slate-500 dark:text-slate-400">
                {row.rowId.slice(0, 8)}…
              </TableCell>
              <TableCell>
                <span className="flex items-center justify-between gap-3 text-sm text-slate-500 dark:text-slate-400">
                  <span>{summary}</span>
                  <ChevronRight
                    size={16}
                    aria-hidden
                    className="shrink-0 text-slate-300 transition-transform group-hover:translate-x-0.5 group-hover:text-teal-600 dark:text-slate-600 dark:group-hover:text-teal-400"
                  />
                </span>
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}
