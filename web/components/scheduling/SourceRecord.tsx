'use client'

import { useTranslations } from 'next-intl'
import { History } from 'lucide-react'
import { CHIP_COLORS, chipStyle } from './BookingChip'
import { Drawer, cn } from '@openbooks/ui'
import type { BoardSourceRecord } from '@openbooks/engine/src/schedule-boards/source-history.ts'

export function SourceRecordChip({ records, compact = false, workerName, onOpen }: {
  records: readonly BoardSourceRecord[]
  compact?: boolean
  workerName?: string
  onOpen: (record: BoardSourceRecord) => void
}) {
  const t = useTranslations('scheduling')
  if (!records.length) return null
  const color = records[0]!.color
  return <button style={color ? chipStyle(215,color) : undefined} type="button" onClick={(event) => { event.stopPropagation(); onOpen(records[0]!) }}
    onMouseDown={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}
    onDoubleClick={event => event.stopPropagation()}
    title={records.map(r => `${r.label ?? '—'}${r.result ? ` · ${r.result}` : ''}\n${t('source.unknownHours')}${!r.visibleInSource ? `\n${t('source.hidden')}` : ''}`).join('\n\n')}
    className={cn('flex min-w-0 flex-1 items-center gap-1 overflow-hidden rounded-md border px-1.5 text-left', color ? CHIP_COLORS : 'border-slate-300 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200',compact ? 'h-[22px] text-[11px]' : 'h-[32px] text-xs')}>
    <History className="h-3 w-3 shrink-0" aria-hidden />
    <span className="truncate font-semibold">{workerName ? `${workerName} · ` : ''}{records[0]!.label ?? '—'}</span>
    {records.length > 1 ? <span className="ml-auto shrink-0 text-[10px]">+{records.length - 1}</span> : null}
  </button>
}

export function SourceRecordDrawer({ record, records, workerName, onSelect, onClose }: {
  record: BoardSourceRecord
  records: readonly BoardSourceRecord[]
  workerName: string
  onSelect: (record: BoardSourceRecord) => void
  onClose: () => void
}) {
  const t = useTranslations('scheduling')
  const peers = records.filter(r => r.workerPartyId === record.workerPartyId && r.onDate === record.onDate)
  return <Drawer open onClose={onClose} size="md" title={workerName} description={record.onDate}>
    <div className="space-y-5">
      <p className="rounded-lg bg-slate-100 px-3 py-2 text-sm dark:bg-slate-900">{t('source.explanation')}</p>
      {peers.length > 1 ? <div className="space-y-2">
        <p className="text-xs text-slate-500">{t('source.multiple', { count: peers.length })}</p>
        <select className="w-full rounded border p-2 text-sm dark:bg-slate-900" value={record.id}
          aria-label={t('source.select')} onChange={event => { const selected = peers.find(r => r.id === event.target.value); if (selected) onSelect(selected) }}>
          {peers.map(r => <option key={r.id} value={r.id}>{r.label ?? '—'} · {r.sourceKey}</option>)}
        </select>
      </div> : null}
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-3 text-sm">
        <dt className="text-slate-500">{t('source.label')}</dt><dd className="whitespace-pre-wrap break-words">{record.label ?? '—'}</dd>
        <dt className="text-slate-500">{t('source.result')}</dt><dd className="whitespace-pre-wrap break-words">{record.result ?? '—'}</dd>
        <dt className="text-slate-500">{t('source.hours')}</dt><dd>{t('source.unknownHours')}</dd>
        <dt className="text-slate-500">{t('source.origin')}</dt><dd className="break-words">{record.sourceSystem} · {record.sourceDataset} · {record.sourceKey}</dd>
      </dl>
      {!record.visibleInSource ? <p className="text-xs text-slate-500">{t('source.hidden')}</p> : null}
      {record.notes ? <p className="whitespace-pre-wrap break-words text-sm">{record.notes}</p> : null}
    </div>
  </Drawer>
}
