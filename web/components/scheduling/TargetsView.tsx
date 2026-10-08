'use client'

import { useMemo, useState, type DragEvent } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Plus, Users } from 'lucide-react'
import { cn } from '@openbooks/ui'
import { CHIP_COLORS, chipStyle } from './BookingChip'
import { TargetPicker } from './TargetPicker'
import { cellKey, indexAbsences, initials, targetHue, type BoardEntry, type BoardTarget, type SpanInput } from './model'
import type { BoardController } from './use-board'
import type { BoardWindow } from '@openbooks/engine/src/schedule-boards/window.ts'

const newId = () => crypto.randomUUID()
const keyOf = (target: Pick<BoardTarget, 'kind' | 'id'>) => `${target.kind}:${target.id}`

/**
 * The dispatch view: one row per job, customer or code on the board, people
 * stacked in each day. Drag people from the rail onto a job and day to book
 * them, or between days and jobs to move them.
 */
export function TargetsView({ controller, window: board, today, onOpenEntry }: {
  controller: BoardController
  window: BoardWindow
  today: string
  onOpenEntry: (entry: BoardEntry) => void
}) {
  const t = useTranslations('scheduling')
  const locale = useLocale()
  const [extraTargets, setExtraTargets] = useState<BoardTarget[]>([])
  const [adding, setAdding] = useState<{ left: number; top: number } | null>(null)
  const [railDate, setRailDate] = useState<string>(() => board.days.find((day) => day.date >= today)?.date ?? board.days[0]?.date ?? today)
  const days = useMemo(() => board.days.filter((day) => board.board.showWeekends || !day.isWeekend), [board.days, board.board.showWeekends])
  const replaced = useMemo(() => new Set(board.replaced), [board.replaced])
  const personName = useMemo(() => new Map(board.people.map((person) => [person.partyId, person.name])), [board.people])
  const absences = useMemo(() => indexAbsences(board.absences), [board.absences])

  const live = useMemo(() => board.entries.filter((entry) => !replaced.has(entry.id)), [board.entries, replaced])
  const rows = useMemo(() => {
    const byTarget = new Map<string, { target: BoardTarget; cells: Map<string, BoardEntry[]>; people: Set<string> }>()
    for (const entry of live) {
      if (!entry.target) continue
      const key = keyOf(entry.target)
      const row = byTarget.get(key) ?? { target: entry.target, cells: new Map(), people: new Set() }
      const list = row.cells.get(entry.startsOn) ?? []
      list.push(entry)
      row.cells.set(entry.startsOn, list)
      row.people.add(entry.workerPartyId)
      byTarget.set(key, row)
    }
    for (const target of extraTargets) if (!byTarget.has(keyOf(target))) byTarget.set(keyOf(target), { target, cells: new Map(), people: new Set() })
    return [...byTarget.values()].sort((a, b) => Number(a.target.kind === 'code') - Number(b.target.kind === 'code') || b.people.size - a.people.size || (a.target.code ?? a.target.label).localeCompare(b.target.code ?? b.target.label))
  }, [extraTargets, live])

  const bookedOn = useMemo(() => {
    const set = new Set<string>()
    for (const entry of live) set.add(cellKey(entry.workerPartyId, entry.startsOn))
    return set
  }, [live])
  const available = useMemo(() => board.people.filter((person) => !bookedOn.has(cellKey(person.partyId, railDate)) && !(absences.get(cellKey(person.partyId, railDate)) ?? []).length), [absences, board.people, bookedOn, railDate])

  const span: SpanInput = board.board.grain === 'day' ? { mode: 'day' } : { mode: 'timed', starts: board.board.dayStarts, ends: board.board.dayEnds, breakMinutes: board.board.dayBreakMinutes }
  const weekday = useMemo(() => new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', timeZone: 'UTC' }), [locale])

  async function drop(event: DragEvent<HTMLElement>, target: BoardTarget, date: string) {
    event.preventDefault()
    if (!board.canManage) return
    const personId = event.dataTransfer.getData('application/x-openbooks-person')
    const entryId = event.dataTransfer.getData('application/x-openbooks-booking')
    if (personId) {
      await controller.run([{ op: 'create', id: newId(), workerPartyId: personId, onDate: date, target: { kind: target.kind, id: target.id }, span }], t('history.book', { target: target.code ?? target.label }))
    } else if (entryId) {
      const entry = controller.entriesById.get(entryId)
      if (!entry || entry.boardId !== board.board.id) return
      if (entry.startsOn === date && entry.target && keyOf(entry.target) === keyOf(target)) return
      await controller.run([{ op: 'update', id: entry.id, expectedRevision: entry.revision, fields: { onDate: date, target: { kind: target.kind, id: target.id }, projectTaskId: null } }], t('history.move', { name: personName.get(entry.workerPartyId) ?? '' }))
    }
  }

  return (
    <div className="flex min-h-0 flex-1 gap-4">
      <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950">
        <table className="w-full border-separate border-spacing-0 text-sm">
          <thead className="sticky top-0 z-10 bg-white/95 backdrop-blur dark:bg-slate-950/95">
            <tr>
              <th className="sticky left-0 z-10 w-56 border-b border-slate-200 bg-white/95 px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:bg-slate-950/95">{t('targets.where')}</th>
              {days.map((day) => (
                <th key={day.date} className={cn('min-w-[110px] border-b border-l border-slate-100 px-2 py-2 text-center text-[11px] font-semibold dark:border-slate-800', day.date === today ? 'text-teal-700 dark:text-teal-300' : 'text-slate-500', day.isWeekend && 'bg-slate-50/80 dark:bg-slate-900/60')}>
                  {weekday.format(new Date(`${day.date}T00:00:00Z`))}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const hue = targetHue(row.target)
              return (
                <tr key={keyOf(row.target)} className="group">
                  <td className="sticky left-0 z-[5] border-b border-slate-100 bg-white px-3 py-2 align-top dark:border-slate-800 dark:bg-slate-950">
                    <div className="flex items-center gap-2">
                      <span className="h-8 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: `hsl(${hue} 65% 55%)` }} />
                      <div className="min-w-0">
                        <div className="truncate font-semibold text-slate-900 dark:text-slate-100">{row.target.code ?? row.target.label}</div>
                        <div className="truncate text-[11px] text-slate-400">{[row.target.code ? row.target.label : null, row.target.context].filter(Boolean).join(' · ') || t(`kinds.${row.target.kind}`)}</div>
                      </div>
                      <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300"><Users className="h-3 w-3" />{row.people.size}</span>
                    </div>
                  </td>
                  {days.map((day) => {
                    const entries = row.cells.get(day.date) ?? []
                    return (
                      <td
                        key={day.date}
                        onDragOver={(event) => board.canManage && event.preventDefault()}
                        onDrop={(event) => void drop(event, row.target, day.date)}
                        className={cn('border-b border-l border-slate-100 p-1 align-top dark:border-slate-800', day.isWeekend && 'bg-slate-50/60 dark:bg-slate-900/40', day.date === today && 'bg-teal-50/40 dark:bg-teal-950/20')}
                      >
                        <div className="flex min-h-[36px] flex-col gap-0.5">
                          {entries.map((entry) => (
                            <div
                              key={entry.id}
                              draggable={board.canManage && entry.boardId === board.board.id}
                              onDragStart={(event) => event.dataTransfer.setData('application/x-openbooks-booking', entry.id)}
                              onDoubleClick={() => onOpenEntry(entry)}
                              style={chipStyle(hue)}
                              className={cn('flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-[11px] font-medium', CHIP_COLORS, entry.status === 'draft' && 'border-dashed', entry.boardId !== board.board.id && 'opacity-60')}
                              title={[entry.detail, entry.spanMode === 'timed' ? `${entry.startClock}–${entry.endClock}` : null, entry.notes].filter(Boolean).join('\n') || undefined}
                            >
                              <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-white/70 text-[8px] font-bold dark:bg-black/20">{initials(personName.get(entry.workerPartyId) ?? '?')}</span>
                              <span className="truncate">{personName.get(entry.workerPartyId) ?? '—'}</span>
                            </div>
                          ))}
                          {entries.length > 1 ? <span className="px-1 text-[10px] font-semibold text-slate-400">{t('targets.count', { count: entries.length })}</span> : null}
                        </div>
                      </td>
                    )
                  })}
                </tr>
              )
            })}
            <tr>
              <td colSpan={days.length + 1} className="px-3 py-2">
                {board.canManage ? (
                  <button
                    type="button"
                    onClick={(event) => {
                      const box = event.currentTarget.getBoundingClientRect()
                      setAdding({ left: box.left, top: box.bottom + 4 })
                    }}
                    className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium text-teal-700 hover:bg-teal-50 dark:text-teal-300 dark:hover:bg-teal-950/40"
                  >
                    <Plus className="h-3.5 w-3.5" />{t('targets.add')}
                  </button>
                ) : null}
                {rows.length === 0 ? <p className="py-6 text-center text-sm text-slate-500">{t('targets.empty')}</p> : null}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <aside className="hidden w-60 shrink-0 flex-col rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950 lg:flex">
        <div className="border-b border-slate-100 p-3 dark:border-slate-800">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{t('targets.available')}</div>
          <div className="mt-2 flex flex-wrap gap-1">
            {days.map((day) => (
              <button
                key={day.date}
                type="button"
                onClick={() => setRailDate(day.date)}
                className={cn('rounded-md px-1.5 py-0.5 text-[10px] font-medium tabular-nums', railDate === day.date ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900' : 'text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800')}
              >
                {weekday.format(new Date(`${day.date}T00:00:00Z`))}
              </button>
            ))}
          </div>
        </div>
        <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
          {available.map((person) => (
            <li
              key={person.partyId}
              draggable={board.canManage}
              onDragStart={(event) => event.dataTransfer.setData('application/x-openbooks-person', person.partyId)}
              className={cn('flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-900', board.canManage && 'cursor-grab')}
            >
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-100 text-[9px] font-bold text-slate-600 dark:bg-slate-800 dark:text-slate-300">{initials(person.name)}</span>
              <span className="min-w-0">
                <span className="block truncate font-medium">{person.name}</span>
                <span className="block truncate text-[10px] text-slate-400">{person.tradeName ?? person.jobTitle ?? person.departmentName ?? ''}</span>
              </span>
            </li>
          ))}
          {available.length === 0 ? <li className="px-2 py-6 text-center text-xs text-slate-500">{t('targets.allBooked')}</li> : null}
        </ul>
      </aside>

      {adding ? (
        <TargetPicker
          boardId={board.board.id}
          codes={board.codes}
          initialText=""
          anchor={{ ...adding, width: 360 }}
          cellCount={1}
          onCommit={(picked) => {
            setExtraTargets((current) => [...current, picked.target])
            setAdding(null)
          }}
          onCancel={() => setAdding(null)}
        />
      ) : null}
    </div>
  )
}
