'use client'

import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { ZoomIn, ZoomOut } from 'lucide-react'
import { Button, cn } from '@openbooks/ui'
import { CHIP_COLORS, chipStyle } from './BookingChip'
import { TargetPicker, type PickedTarget } from './TargetPicker'
import { formatMinutes, groupRows, initials, targetHue, targetShortLabel, type BoardEntry, type GroupBy } from './model'
import type { BoardController } from './use-board'
import type { BoardWindow } from '@openbooks/engine/src/schedule-boards/window.ts'

const NAME_W = 200
const ROW_H = 40
const HEADER_H = 44
const SNAP = 15
const ZOOMS = [4, 8, 16, 32, 56]

const newId = () => crypto.randomUUID()
const clockMinutes = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5))
const clock = (minutes: number) => `${String(Math.floor((((minutes % 1440) + 1440) % 1440) / 60)).padStart(2, '0')}:${String(((minutes % 60) + 60) % 60).padStart(2, '0')}`

type Drag =
  | { kind: 'move'; entry: BoardEntry; startX: number; startY: number; dx: number; dy: number }
  | { kind: 'start' | 'end'; entry: BoardEntry; startX: number; dx: number }
  | { kind: 'create'; row: number; startMinute: number; endMinute: number }

/** Hours across the window: shifts as bars, overnight work crossing midnight. */
export function TimelineView({ controller, window: board, groupBy, search, today, onOpenEntry }: {
  controller: BoardController
  window: BoardWindow
  groupBy: GroupBy
  search: string
  today: string
  onOpenEntry: (entry: BoardEntry) => void
}) {
  const t = useTranslations('scheduling')
  const locale = useLocale()
  const [zoom, setZoom] = useState(board.days.length <= 3 ? 3 : board.days.length <= 7 ? 2 : 1)
  const hourW = ZOOMS[zoom]!
  const dayW = hourW * 24
  const dates = board.days.map((day) => day.date)
  const dayIndex = useMemo(() => new Map(dates.map((date, i) => [date, i])), [dates])
  const replaced = useMemo(() => new Set(board.replaced), [board.replaced])
  const people = useMemo(() => {
    const query = search.trim().toLowerCase()
    return query ? board.rows.filter((person) => person.name.toLowerCase().includes(query)) : board.rows
  }, [board.rows, search])
  const { items, persons } = useMemo(() => groupRows(people, groupBy, t('grid.ungrouped')), [groupBy, people, t])
  const rowOf = useMemo(() => new Map(persons.map((person, i) => [person.subjectId, i])), [persons])
  const tops = useMemo(() => {
    let y = 0
    const personTop = new Map<number, number>()
    const out = items.map((item) => {
      const top = y
      if (item.kind === 'person') personTop.set(item.personIndex!, top)
      y += item.kind === 'group' ? 26 : ROW_H
      return top
    })
    return { out, personTop, height: y }
  }, [items])

  const scrollRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [creating, setCreating] = useState<{ row: number; date: string; starts: string; ends: string; anchor: { left: number; top: number; width: number } } | null>(null)

  // Open on today's working morning.
  useEffect(() => {
    const element = scrollRef.current
    const index = dayIndex.get(today) ?? 0
    if (element) element.scrollLeft = Math.max(0, index * dayW + clockMinutes(board.board.dayStarts) / 60 * hourW - 2 * hourW)
  }, [board.board.dayStarts, board.from, dayIndex, dayW, hourW, today])

  const minuteAt = (clientX: number) => {
    const element = scrollRef.current!
    const x = clientX - element.getBoundingClientRect().left + element.scrollLeft - NAME_W
    return Math.round((x / hourW) * 60 / SNAP) * SNAP
  }
  const rowAt = (clientY: number) => {
    const element = scrollRef.current!
    const y = clientY - element.getBoundingClientRect().top + element.scrollTop - HEADER_H
    for (const [row, top] of tops.personTop) if (y >= top && y < top + ROW_H) return row
    return null
  }

  const position = (entry: BoardEntry) => {
    const day = dayIndex.get(entry.startsOn)
    if (day === undefined) return null
    const start = day * 1440 + clockMinutes(entry.startClock)
    const duration = Math.round((Date.parse(entry.endsAt) - Date.parse(entry.startsAt)) / 60000)
    return { start, duration }
  }

  function onBarPointerDown(event: PointerEvent<HTMLDivElement>, entry: BoardEntry, kind: 'move' | 'start' | 'end') {
    if (!board.canManage || entry.boardId !== board.board.id || event.button !== 0) return
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    setDrag(kind === 'move' ? { kind, entry, startX: event.clientX, startY: event.clientY, dx: 0, dy: 0 } : { kind, entry, startX: event.clientX, dx: 0 })
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!drag) return
    if (drag.kind === 'create') {
      setDrag({ ...drag, endMinute: minuteAt(event.clientX) })
    } else if (drag.kind === 'move') {
      setDrag({ ...drag, dx: event.clientX - drag.startX, dy: event.clientY - drag.startY })
    } else {
      setDrag({ ...drag, dx: event.clientX - drag.startX })
    }
  }

  async function onPointerUp(event: PointerEvent<HTMLDivElement>) {
    const current = drag
    setDrag(null)
    if (!current) return
    if (current.kind === 'create') {
      const from = Math.min(current.startMinute, current.endMinute)
      const to = Math.max(current.startMinute, current.endMinute)
      if (to - from < SNAP) return
      const date = dates[Math.floor(from / 1440)]
      if (!date) return
      const element = scrollRef.current!
      const box = element.getBoundingClientRect()
      setCreating({
        row: current.row, date, starts: clock(from), ends: clock(to),
        anchor: { left: box.left + NAME_W + from / 60 * hourW - element.scrollLeft, top: event.clientY + 12, width: 320 },
      })
      return
    }
    const pos = position(current.entry)
    if (!pos) return
    const deltaMinutes = Math.round((current.dx / hourW) * 60 / SNAP) * SNAP
    if (current.kind === 'move') {
      const row = rowAt(event.clientY)
      const person = row === null ? null : persons[row]
      const start = pos.start + deltaMinutes
      const date = dates[Math.floor(start / 1440)]
      if (!date || (deltaMinutes === 0 && (!person || person.subjectId === current.entry.subjectId))) {
        if (Math.abs(current.dx) < 3 && Math.abs(current.dy) < 3) onOpenEntry(current.entry)
        return
      }
      await controller.run([{
        op: 'update', id: current.entry.id, expectedRevision: current.entry.revision,
        fields: {
          ...(person && person.subjectId !== current.entry.subjectId ? { subject: { kind: person.subjectKind, id: person.subjectId } } : {}),
          onDate: date,
          span: { mode: 'timed', starts: clock(start), ends: clock(start + pos.duration), breakMinutes: current.entry.breakMinutes },
        },
      }], t('history.reschedule'))
      return
    }
    if (deltaMinutes === 0) return
    const start = current.kind === 'start' ? pos.start + deltaMinutes : pos.start
    const end = current.kind === 'end' ? pos.start + pos.duration + deltaMinutes : pos.start + pos.duration
    if (end - start < SNAP) return
    const date = dates[Math.floor(start / 1440)]
    if (!date) return
    await controller.run([{
      op: 'update', id: current.entry.id, expectedRevision: current.entry.revision,
      fields: { onDate: date, span: { mode: 'timed', starts: clock(start), ends: clock(end), breakMinutes: Math.min(current.entry.breakMinutes, Math.max(0, end - start - SNAP)) } },
    }], t('history.reschedule'))
  }

  async function commitCreate(picked: PickedTarget) {
    if (!creating) return
    const person = persons[creating.row]
    setCreating(null)
    if (!person) return
    await controller.run([{
      op: 'create', id: newId(), subject: { kind: person.subjectKind, id: person.subjectId }, onDate: creating.date,
      target: { kind: picked.target.kind, id: picked.target.id }, detail: picked.detail,
      span: picked.span ?? { mode: 'timed', starts: creating.starts, ends: creating.ends, breakMinutes: 0 },
    }], t('history.book', { target: picked.target.code ?? picked.target.label }))
  }

  const dayFormat = useMemo(() => new Intl.DateTimeFormat(locale, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }), [locale])
  const width = NAME_W + dayW * dates.length
  const tickEvery = hourW >= 32 ? 1 : hourW >= 16 ? 2 : hourW >= 8 ? 4 : 6

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center justify-end gap-1">
        <Button variant="ghost" size="sm" onClick={() => setZoom((value) => Math.max(0, value - 1))} disabled={zoom === 0} aria-label={t('timeline.zoomOut')}><ZoomOut className="h-4 w-4" /></Button>
        <Button variant="ghost" size="sm" onClick={() => setZoom((value) => Math.min(ZOOMS.length - 1, value + 1))} disabled={zoom === ZOOMS.length - 1} aria-label={t('timeline.zoomIn')}><ZoomIn className="h-4 w-4" /></Button>
      </div>
      <div
        ref={scrollRef}
        className="relative min-h-0 flex-1 select-none overflow-auto rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950"
        onPointerMove={onPointerMove}
        onPointerUp={(event) => void onPointerUp(event)}
      >
        <div style={{ width, height: HEADER_H + tops.height }} className="relative">
          <div className="sticky top-0 z-20 flex border-b border-slate-200 bg-white/95 backdrop-blur dark:border-slate-800 dark:bg-slate-950/95" style={{ height: HEADER_H, width }}>
            <div className="sticky left-0 z-10 bg-white/95 dark:bg-slate-950/95" style={{ width: NAME_W }} />
            {dates.map((date) => (
              <div key={date} className="relative border-l border-slate-200 dark:border-slate-800" style={{ width: dayW }}>
                <div className={cn('sticky left-[200px] inline-block px-2 pt-1 text-[11px] font-semibold', date === today ? 'text-teal-700 dark:text-teal-300' : 'text-slate-600 dark:text-slate-300')}>
                  {dayFormat.format(new Date(`${date}T00:00:00Z`))}
                </div>
                <div className="absolute inset-x-0 bottom-0 flex h-4">
                  {Array.from({ length: 24 / tickEvery }, (_, i) => (
                    <div key={i} className="border-l border-slate-100 pl-0.5 text-[9px] tabular-nums text-slate-400 dark:border-slate-800" style={{ width: hourW * tickEvery }}>
                      {String(i * tickEvery).padStart(2, '0')}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="relative" style={{ height: tops.height, width }}>
            {dates.map((date, i) => {
              const day = board.days[i]!
              return (
                <div
                  key={date}
                  className={cn('pointer-events-none absolute inset-y-0 border-l border-slate-200 dark:border-slate-800', day.isWeekend && 'bg-slate-50/60 dark:bg-slate-900/40', day.isHoliday && 'bg-rose-50/50 dark:bg-rose-950/20')}
                  style={{ left: NAME_W + i * dayW, width: dayW }}
                >
                  <div
                    className="absolute inset-y-0 bg-teal-500/[0.04]"
                    style={{ left: clockMinutes(board.board.dayStarts) / 60 * hourW, width: (clockMinutes(board.board.dayEnds) - clockMinutes(board.board.dayStarts)) / 60 * hourW }}
                  />
                </div>
              )
            })}
            {items.map((item, i) => {
              const top = tops.out[i]!
              if (item.kind === 'group') {
                return (
                  <div key={item.key} className="absolute left-0 flex items-center bg-slate-50/90 px-3 text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:bg-slate-900/80" style={{ top, height: 26, width }}>
                    <span className="sticky left-3">{item.label}</span>
                  </div>
                )
              }
              const person = item.person!
              const row = item.personIndex!
              const entries = board.entries.filter((entry) => entry.subjectId === person.subjectId && !replaced.has(entry.id))
              return (
                <div key={item.key} className="absolute left-0 border-b border-slate-100 dark:border-slate-800/70" style={{ top, height: ROW_H, width }}>
                  <div className="sticky left-0 z-[5] flex h-full items-center gap-2 border-r border-slate-100 bg-white px-3 dark:border-slate-800 dark:bg-slate-950" style={{ width: NAME_W }}>
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-100 text-[9px] font-bold text-slate-600 dark:bg-slate-800 dark:text-slate-300">{initials(person.name)}</span>
                    <span className="truncate text-xs font-medium text-slate-800 dark:text-slate-100">{person.name}</span>
                  </div>
                  <div
                    className="absolute inset-y-0"
                    style={{ left: NAME_W, width: dayW * dates.length }}
                    onPointerDown={(event) => {
                      if (!board.canManage || event.button !== 0) return
                      event.currentTarget.setPointerCapture(event.pointerId)
                      const minute = minuteAt(event.clientX)
                      setDrag({ kind: 'create', row, startMinute: minute, endMinute: minute })
                    }}
                  >
                    {board.absences.filter((absence) => absence.workerPartyId === person.subjectId).map((absence) => {
                      const day = dayIndex.get(absence.onDate)
                      if (day === undefined) return null
                      return (
                        <div key={`${absence.onDate}-${absence.leaveTypeCode}`} className="absolute inset-y-1 rounded-md border border-amber-300/70 bg-amber-50/80 px-1 text-[10px] font-semibold text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200" style={{ left: day * dayW + 2, width: dayW - 4 }} title={absence.leaveTypeName}>
                          {absence.leaveTypeCode}
                        </div>
                      )
                    })}
                    {entries.map((entry) => {
                      const pos = position(entry)
                      if (!pos) return null
                      let left = pos.start / 60 * hourW
                      let barWidth = pos.duration / 60 * hourW
                      let offsetY = 0
                      if (drag && drag.kind !== 'create' && drag.entry.id === entry.id) {
                        if (drag.kind === 'move') {
                          left += drag.dx
                          offsetY = drag.dy
                        } else if (drag.kind === 'start') {
                          left += drag.dx
                          barWidth -= drag.dx
                        } else barWidth += drag.dx
                      }
                      const editable = board.canManage && entry.boardId === board.board.id
                      return (
                        <div
                          key={entry.id}
                          onPointerDown={(event) => onBarPointerDown(event, entry, 'move')}
                          onDoubleClick={() => onOpenEntry(entry)}
                          style={{ ...chipStyle(targetHue(entry.target), entry.target?.color), left, width: Math.max(barWidth, 6), transform: offsetY ? `translateY(${offsetY}px)` : undefined }}
                          className={cn(
                            'absolute inset-y-1 flex items-center overflow-hidden rounded-md border px-1.5 text-[11px] font-semibold shadow-sm',
                            CHIP_COLORS,
                            entry.status === 'draft' && 'border-dashed',
                            !editable && 'opacity-60',
                            editable && 'cursor-grab active:cursor-grabbing',
                            drag && drag.kind !== 'create' && drag.entry.id === entry.id && 'z-10 shadow-lg ring-2 ring-teal-500/40',
                          )}
                          title={`${entry.target?.label ?? ''} ${entry.startClock}–${entry.endClock} (${formatMinutes(entry.workedMinutes)})`}
                        >
                          {editable ? <span onPointerDown={(event) => onBarPointerDown(event, entry, 'start')} className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize" /> : null}
                          <span className="truncate">{targetShortLabel(entry.target)}{barWidth > 90 ? <span className="ml-1 font-normal opacity-75">{entry.startClock}–{entry.endClock}</span> : null}</span>
                          {editable ? <span onPointerDown={(event) => onBarPointerDown(event, entry, 'end')} className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize" /> : null}
                        </div>
                      )
                    })}
                    {drag?.kind === 'create' && drag.row === row ? (
                      <div
                        className="pointer-events-none absolute inset-y-1 rounded-md border-2 border-dashed border-teal-500 bg-teal-500/10 text-[10px] font-semibold text-teal-700"
                        style={{ left: Math.min(drag.startMinute, drag.endMinute) / 60 * hourW, width: Math.abs(drag.endMinute - drag.startMinute) / 60 * hourW }}
                      >
                        <span className="px-1">{clock(Math.min(drag.startMinute, drag.endMinute))}–{clock(Math.max(drag.startMinute, drag.endMinute))}</span>
                      </div>
                    ) : null}
                  </div>
                </div>
              )
            })}
            {(() => {
              const day = dayIndex.get(today)
              if (day === undefined) return null
              const parts = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: board.board.timeZone }).format(new Date())
              const minutes = clockMinutes(parts)
              return <div className="pointer-events-none absolute inset-y-0 z-[6] w-px bg-rose-500" style={{ left: NAME_W + (day * 1440 + minutes) / 60 * hourW }} />
            })()}
          </div>
        </div>
        {rowOf.size === 0 ? <div className="absolute inset-x-0 top-24 text-center text-sm text-slate-500">{t('grid.noPeople')}</div> : null}
      </div>
      {creating ? (
        <TargetPicker
          boardId={board.board.id}
          codes={board.codes}
          initialText=""
          anchor={creating.anchor}
          cellCount={1}
          onCommit={(picked) => void commitCreate(picked)}
          onCancel={() => setCreating(null)}
        />
      ) : null}
    </div>
  )
}
