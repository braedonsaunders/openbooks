'use client'

import { useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Badge, Button } from '@openbooks/ui'
import { PagedTable } from '@/components/paged-table'
import { decimalLabel, viewerDate } from '@/lib/format'
import type { PendingWeekEntry, TimesheetPickers } from '../../api/timesheets/_lib'
import type { AdditionalTimeSelection } from '@openbooks/engine/projects/additional-time-submission'

export function AdditionalTimeReview({ entries, pickers, busy, refusal, onBack, onSubmit }: {
  entries: PendingWeekEntry[]; pickers: TimesheetPickers; busy: boolean
  refusal: { message: string; remedy: string | null } | null
  onBack: () => void
  onSubmit: (selections: AdditionalTimeSelection[], reason: string) => Promise<void>
}) {
  const t = useTranslations('timesheets.additional')
  const common = useTranslations('common')
  const timesheets = useTranslations('timesheets')
  const locale = useLocale()
  const statusLabel = (status: string) => common.has(`status.${status}` as never)
    ? common(`status.${status}` as never) : status === 'submitted' ? timesheets('status.submitted') : status
  const [selected, setSelected] = useState<Map<string, string>>(new Map())
  const [reason, setReason] = useState('')
  const chosen = entries.filter(entry => selected.get(entry.id) === entry.updatedAt)
  const projectName = (id: string | null) => pickers.projects.find(project => project.value === id)?.label ?? '—'
  const itemName = (id: string | null) => pickers.items.find(item => item.value === id)?.label ?? '—'
  return <div className="space-y-4 p-6">
    <p className="text-sm text-muted-foreground">{t('description')}</p>
    <PagedTable rows={entries} rowKey={entry => entry.id} searchable searchLayout="drawer" emptyAsRow empty={t('empty')}
      selection={{
        getId: entry => entry.id, selectedIds: new Set(chosen.map(entry => entry.id)), disabled: busy,
        onToggle: id => setSelected(previous => {
          const entry = entries.find(row => row.id === id)
          const next = new Map(previous)
          if (!entry) return next
          if (next.get(id) === entry.updatedAt) next.delete(id); else next.set(id, entry.updatedAt)
          return next
        }),
        onToggleAll: ids => setSelected(previous => {
          const next = new Map(previous)
          const matching = entries.filter(entry => ids.includes(entry.id))
          const all = matching.every(entry => next.get(entry.id) === entry.updatedAt)
          for (const entry of matching) { if (all) next.delete(entry.id); else next.set(entry.id, entry.updatedAt) }
          return next
        }),
      }}
      columns={[
        { key: 'date', header: t('date'), cell: entry => viewerDate(entry.workedOn, locale), search: entry => entry.workedOn },
        { key: 'project', header: t('project'), cell: entry => projectName(entry.projectId), search: entry => projectName(entry.projectId) },
        { key: 'source', header: t('source'), cell: entry => <div className="flex flex-wrap items-center gap-2">
          <span>{entry.fieldTicketNumber ?? t('directTime')}</span>
          {entry.fieldTicketStatus ? <Badge variant="secondary">{statusLabel(entry.fieldTicketStatus)}</Badge> : null}
        </div>, search: entry => [entry.fieldTicketNumber ?? t('directTime'), entry.fieldTicketStatus ? statusLabel(entry.fieldTicketStatus) : ''].join(' ') },
        { key: 'item', header: t('item'), cell: entry => itemName(entry.itemId), search: entry => itemName(entry.itemId) },
        { key: 'hours', header: t('hours'), align: 'right', cell: entry => decimalLabel(entry.hours) },
        { key: 'status', header: t('timeStatus'), cell: entry => <Badge variant="outline">{statusLabel(entry.status)}</Badge> },
      ]} />
    <label className="block space-y-1 text-sm">
      <span>{t('reason')}</span>
      <textarea className="w-full rounded-md border bg-background p-2" rows={3} maxLength={500}
        value={reason} disabled={busy} onChange={event => setReason(event.target.value)} />
    </label>
    {refusal ? <div role="alert" className="rounded-md border border-destructive/30 p-3 text-sm text-destructive">
      <p>{refusal.message}</p>{refusal.remedy ? <p className="mt-1">{refusal.remedy}</p> : null}
    </div> : null}
    <div className="flex justify-end gap-2">
      <Button variant="outline" disabled={busy} onClick={onBack}>{t('back')}</Button>
      <Button disabled={busy || chosen.length === 0 || chosen.length > 250 || reason.trim().length < 10}
        onClick={() => void onSubmit(chosen.map(({ id, updatedAt }) => ({ id, updatedAt })), reason.trim())}>
        {busy ? t('submitting') : t('submit', { count: chosen.length })}
      </Button>
    </div>
  </div>
}
