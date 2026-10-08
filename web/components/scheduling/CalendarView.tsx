'use client'

import { useMemo, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { cn } from '@openbooks/ui'
import { filterBoardRows } from './legend'
import { CHIP_COLORS, chipStyle } from './BookingChip'
import { SourceRecordChip } from './SourceRecord'
import type { BoardSourceRecord } from '@openbooks/engine/src/schedule-boards/source-history.ts'
import { targetHue, targetShortLabel, presentedBoardEntries, type BoardEntry, type BoardTarget } from './model'
import type { BoardWindow } from '@openbooks/engine/src/schedule-boards/window.ts'

/** The month at a glance: who is where each day, or one person's month. */
export function CalendarView({ window: board, month, personId, search, today, onOpenEntry, onOpenSourceRecord }: {
  window: BoardWindow
  month: string
  personId: string
  search: string
  today: string
  onOpenEntry: (entry: BoardEntry) => void
  onOpenSourceRecord: (record: BoardSourceRecord) => void
}) {
  const t = useTranslations('scheduling')
  const locale = useLocale()
  const visibleSubjects = useMemo(() => new Set(filterBoardRows(board,search,null).map(r=>r.subjectId)),[board,search])
  const [open, setOpen] = useState<string | null>(null)
  const replaced = useMemo(() => new Set(board.replaced), [board.replaced])
  const names = useMemo(() => new Map(board.rows.map((person) => [person.subjectId, person.name])), [board.rows])
  const presented = useMemo(() => presentedBoardEntries(board), [board.entries, board.sourceRecords])
  const byDate = useMemo(() => {
    const map = new Map<string, BoardEntry[]>()
    for (const entry of presented) {
      if (!visibleSubjects.has(entry.subjectId) || replaced.has(entry.id) || (personId && entry.subjectId !== personId)) continue
      const list = map.get(entry.startsOn) ?? []
      list.push(entry)
      map.set(entry.startsOn, list)
    }
    return map
  }, [presented, personId, replaced, visibleSubjects])
  const sourceByDate = useMemo(() => {
    const map = new Map<string, Map<string, BoardSourceRecord[]>>()
    for (const record of board.sourceRecords ?? []) {
      if (!visibleSubjects.has(record.workerPartyId) || (personId && record.workerPartyId !== personId)) continue
      const people = map.get(record.onDate) ?? new Map<string, BoardSourceRecord[]>()
      people.set(record.workerPartyId, [...(people.get(record.workerPartyId) ?? []), record])
      map.set(record.onDate, people)
    }
    return map
  }, [board.sourceRecords, personId, visibleSubjects])
  const leaveByDate = useMemo(() => {
    const map = new Map<string, number>()
    for (const absence of board.absences) if (visibleSubjects.has(absence.workerPartyId) && (!personId || absence.workerPartyId === personId)) map.set(absence.onDate, (map.get(absence.onDate) ?? 0) + 1)
    return map
  }, [board.absences, personId, visibleSubjects])
  const weekdayFormat = useMemo(() => new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }), [locale])
  const weeks = useMemo(() => {
    const rows: (typeof board.days)[] = []
    for (let i = 0; i < board.days.length; i += 7) rows.push(board.days.slice(i, i + 7))
    return rows
  }, [board.days])

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="grid min-h-0 flex-1 grid-cols-[repeat(7,minmax(0,1fr))] overflow-auto rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950" style={{ gridTemplateRows: `auto repeat(${weeks.length}, minmax(0, 1fr))` }}>
        {weeks[0]?.map((day) => (
          <div key={`h-${day.date}`} className="sticky top-0 z-10 border-b border-slate-200 bg-white/95 px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:bg-slate-950/95">
            {weekdayFormat.format(new Date(`${day.date}T00:00:00Z`))}
          </div>
        ))}
        {weeks.flat().map((day) => {
          const entries = byDate.get(day.date) ?? []
          const groups = new Map<string, { target: BoardTarget | null; entries: BoardEntry[] }>()
          for (const entry of entries) {
            const key = entry.target ? `${entry.target.kind}:${entry.target.id}` : 'none'
            const group = groups.get(key) ?? { target: entry.target, entries: [] }
            group.entries.push(entry)
            groups.set(key, group)
          }
          const inMonth = day.date.slice(0, 7) === month
          const expanded = open === day.date
          const leave = leaveByDate.get(day.date) ?? 0
          const sourceGroups = [...(sourceByDate.get(day.date)?.values() ?? [])]
          const sourceLimit = expanded ? sourceGroups.length : Math.min(4, sourceGroups.length)
          const bookingLimit = expanded ? groups.size : Math.max(0, 4 - sourceLimit)
          const remaining = sourceGroups.length + groups.size - sourceLimit - bookingLimit
          return (
            <div key={day.date} className={cn('relative min-h-0 min-w-0 overflow-auto border-b border-l border-slate-100 p-1.5 dark:border-slate-800', day.isWeekend && 'bg-slate-200/50 dark:bg-slate-800/60', !inMonth && 'text-slate-400', day.isHoliday && 'bg-rose-50/60 dark:bg-rose-950/20')}>
              <button type="button" onClick={() => setOpen(expanded ? null : day.date)} className="flex w-full items-center justify-between">
                <span className={cn('flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-xs font-semibold tabular-nums', day.date === today ? 'bg-teal-600 text-white' : 'text-slate-700 dark:text-slate-200')}>
                  {Number(day.date.slice(8))}
                </span>
                {leave ? <span className="rounded bg-amber-100 px-1 text-[9px] font-semibold text-amber-800 dark:bg-amber-950 dark:text-amber-200">{t('calendar.onLeave', { count: leave })}</span> : null}
              </button>
              <div className="mt-1 space-y-0.5">
                {sourceGroups.slice(0, sourceLimit).map(records =>
                  <SourceRecordChip key={records[0]!.workerPartyId} records={records} compact workerName={!personId ? names.get(records[0]!.workerPartyId) : undefined} onOpen={onOpenSourceRecord} />)}
                {[...groups.values()].slice(0, bookingLimit).map((group) => (
                  <div key={group.target ? group.target.id : 'none'}>
                    <button
                      type="button"
                      onClick={() => (personId && group.entries[0] ? onOpenEntry(group.entries[0]) : setOpen(expanded ? null : day.date))}
                      style={chipStyle(targetHue(group.target), group.target?.color)}
                      className={cn('flex w-full items-center justify-between rounded border px-1.5 py-0.5 text-[10px] font-semibold', CHIP_COLORS)}
                    >
                      <span className="truncate">{targetShortLabel(group.target)}</span>
                      {!personId ? <span className="tabular-nums opacity-75">{group.entries.length}</span> : null}
                    </button>
                    {expanded && !personId ? (
                      <ul className="mb-1 ml-1 mt-0.5 space-y-0.5">
                        {group.entries.map((entry) => (
                          <li key={entry.id}>
                            <button type="button" onClick={() => onOpenEntry(entry)} className="w-full truncate text-left text-[10px] font-semibold text-slate-600 hover:underline dark:text-slate-300">
                              {names.get(entry.subjectId) ?? '—'}
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                ))}
                {!expanded && remaining > 0 ? (
                  <button type="button" onClick={() => setOpen(day.date)} className="px-1 text-[10px] font-medium text-teal-700 hover:underline dark:text-teal-300">{t('calendar.more', { count: remaining })}</button>
                ) : null}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
