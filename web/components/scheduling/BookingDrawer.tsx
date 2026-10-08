'use client'

import { useEffect, useMemo, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { CalendarClock, Repeat2, Trash2 } from 'lucide-react'
import { Button, Drawer, Input, Select, Textarea, cn } from '@openbooks/ui'
import { projectTasks } from './api'
import { TargetPicker } from './TargetPicker'
import { CHIP_COLORS, chipStyle } from './BookingChip'
import { entryTemplate, formatMinutes, targetHue, type BoardChange, type BoardEntry, type BoardTarget, type SpanInput } from './model'
import type { BoardController } from './use-board'
import type { BoardWindow } from '@openbooks/engine/src/schedule-boards/window.ts'
import type { ProjectTaskOption } from '@openbooks/engine/src/schedule-boards/targets.ts'

const newId = () => crypto.randomUUID()

/** The one drawer for a booking: what, when, and the notes the crew needs. */
export function BookingDrawer({
  entry,
  window: board,
  controller,
  onClose,
}: {
  entry: BoardEntry | null
  window: BoardWindow
  controller: BoardController
  onClose: () => void
}) {
  const t = useTranslations('scheduling')
  const locale = useLocale()
  const editable = Boolean(entry && entry.boardId === board.board.id && board.canManage)
  const [target, setTarget] = useState<BoardTarget | null>(entry?.target ?? null)
  const [taskId, setTaskId] = useState<string>(entry?.projectTaskId ?? '')
  const [tasks, setTasks] = useState<ProjectTaskOption[]>([])
  const [mode, setMode] = useState<'day' | 'timed'>(entry?.spanMode ?? 'day')
  const [starts, setStarts] = useState(entry?.startClock ?? board.board.dayStarts)
  const [ends, setEnds] = useState(entry?.endClock ?? board.board.dayEnds)
  const [breakMinutes, setBreakMinutes] = useState(String(entry?.breakMinutes ?? board.board.dayBreakMinutes))
  const [detail, setDetail] = useState(entry?.detail ?? '')
  const [notes, setNotes] = useState(entry?.notes ?? '')
  const [picking, setPicking] = useState(false)
  const [repeatDays, setRepeatDays] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setTarget(entry?.target ?? null)
    setTaskId(entry?.projectTaskId ?? '')
    setMode(entry?.spanMode ?? 'day')
    setStarts(entry?.startClock ?? board.board.dayStarts)
    setEnds(entry?.endClock ?? board.board.dayEnds)
    setBreakMinutes(String(entry?.breakMinutes ?? board.board.dayBreakMinutes))
    setDetail(entry?.detail ?? '')
    setNotes(entry?.notes ?? '')
    setRepeatDays(new Set())
  }, [entry, board.board.dayStarts, board.board.dayEnds, board.board.dayBreakMinutes])

  useEffect(() => {
    if (target?.kind !== 'project') {
      setTasks([])
      return
    }
    let cancelled = false
    projectTasks(board.board.id, target.id, t('errors.load')).then((body) => !cancelled && setTasks(body.tasks)).catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [board.board.id, t, target])

  const person = board.rows.find((candidate) => candidate.subjectId === entry?.subjectId)
  const dateLabel = useMemo(() => entry
    ? new Intl.DateTimeFormat(locale, { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${entry.startsOn}T00:00:00Z`))
    : '', [entry, locale])
  const weekdays = useMemo(() => new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', timeZone: 'UTC' }), [locale])
  const repeatCandidates = useMemo(() => board.days.filter((day) => entry && day.date !== entry.startsOn && !day.isHoliday), [board.days, entry])

  if (!entry) return null
  const span: SpanInput = mode === 'day' ? { mode: 'day' } : { mode: 'timed', starts, ends, breakMinutes: Number(breakMinutes) || 0 }
  const hue = targetHue(target)

  async function save() {
    if (!entry) return
    setSaving(true)
    const fields = {
      target: target ? { kind: target.kind, id: target.id } : null,
      projectTaskId: target?.kind === 'project' && taskId ? taskId : null,
      detail: detail.trim() || null,
      notes: notes.trim() || null,
      span,
    }
    const changes: BoardChange[] = [{ op: 'update', id: entry.id, expectedRevision: entry.revision, fields }]
    const template = { ...entryTemplate(entry), ...fields }
    for (const date of repeatDays) {
      changes.push({ op: 'create', id: newId(), ...template, subject: { kind: entry.subjectKind, id: entry.subjectId }, onDate: date, seriesId: entry.seriesId })
    }
    const results = await controller.run(changes, t('history.edit'))
    setSaving(false)
    if (results && results.every((result) => result.ok)) onClose()
  }

  async function remove() {
    if (!entry) return
    setSaving(true)
    const results = await controller.run([{ op: 'cancel', id: entry.id, expectedRevision: entry.revision }], t('history.clear', { count: 1 }))
    setSaving(false)
    if (results?.[0]?.ok) onClose()
  }

  return (
    <Drawer
      open
      onClose={onClose}
      size="md"
      title={person?.name ?? t('drawer.title')}
      description={dateLabel}
      headerActions={editable ? (
        <Button size="sm" onClick={() => void save()} disabled={saving}>{t('drawer.save')}</Button>
      ) : undefined}
      footer={editable ? (
        <div className="flex items-center justify-between">
          <Button variant="ghost" size="sm" onClick={() => void remove()} disabled={saving} className="text-red-600 hover:text-red-700">
            <Trash2 className="mr-1.5 h-4 w-4" />{t('drawer.remove')}
          </Button>
          <span className="text-xs text-slate-500">{entry.updatedByName ? t('drawer.updatedBy', { name: entry.updatedByName }) : null}</span>
        </div>
      ) : undefined}
    >
      <div className="space-y-6">
        {!editable ? (
          <p className="rounded-lg bg-slate-100 px-3 py-2 text-xs text-slate-600 dark:bg-slate-900 dark:text-slate-300">
            {entry.boardId !== board.board.id ? t('drawer.otherBoard', { board: entry.boardName }) : t('drawer.readOnly')}
          </p>
        ) : null}
        {entry.status === 'draft' ? (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">{t('drawer.draft')}</p>
        ) : null}

        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{t('drawer.where')}</h3>
          <button
            type="button"
            disabled={!editable}
            onClick={() => setPicking(true)}
            style={chipStyle(hue)}
            className={cn('flex w-full items-center justify-between rounded-xl border px-4 py-3 text-left transition', CHIP_COLORS, editable && 'hover:shadow-md')}
          >
            <span className="min-w-0">
              <span className="block truncate text-base font-semibold">{target ? target.code ?? target.label : t('chip.unassigned')}</span>
              <span className="block truncate text-xs opacity-80">{target ? [target.label !== target.code ? target.label : null, target.context, t(`kinds.${target.kind}`)].filter(Boolean).join(' · ') : t('drawer.pickTarget')}</span>
            </span>
            {editable ? <span className="text-xs font-medium opacity-80">{t('drawer.change')}</span> : null}
          </button>
          {picking ? (
            <TargetPicker
              boardId={board.board.id}
              codes={board.codes}
              initialText=""
              anchor={{ left: globalThis.innerWidth - 480, top: 160, width: 420 }}
              cellCount={1}
              onCommit={(picked) => {
                setTarget(picked.target)
                setTaskId('')
                if (picked.detail) setDetail(picked.detail)
                if (picked.span?.mode === 'timed') {
                  setMode('timed')
                  setStarts(picked.span.starts)
                  setEnds(picked.span.ends)
                }
                setPicking(false)
              }}
              onCancel={() => setPicking(false)}
            />
          ) : null}
          {target?.kind === 'project' ? (
            <label className="block space-y-1">
              <span className="text-xs font-medium text-slate-600 dark:text-slate-300">{t('drawer.task')}</span>
              <Select value={taskId} disabled={!editable} onChange={(event) => setTaskId(event.target.value)}>
                <option value="">{t('drawer.noTask')}</option>
                {tasks.map((task) => <option key={task.id} value={task.id}>{task.code ? `${task.code} · ${task.name}` : task.name}</option>)}
              </Select>
            </label>
          ) : null}
          <label className="block space-y-1">
            <span className="text-xs font-medium text-slate-600 dark:text-slate-300">{t('drawer.detail')}</span>
            <Input value={detail} disabled={!editable} maxLength={120} onChange={(event) => setDetail(event.target.value)} placeholder={t('drawer.detailPlaceholder')} />
          </label>
        </section>

        <section className="space-y-3">
          <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500"><CalendarClock className="h-3.5 w-3.5" />{t('drawer.when')}</h3>
          <div className="inline-flex rounded-lg border border-slate-200 p-0.5 dark:border-slate-800" role="radiogroup">
            {(['day', 'timed'] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={mode === value}
                disabled={!editable}
                onClick={() => setMode(value)}
                className={cn('rounded-md px-3 py-1.5 text-xs font-medium', mode === value ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900' : 'text-slate-600 dark:text-slate-300')}
              >
                {value === 'day' ? t('drawer.wholeDay', { hours: `${board.board.dayStarts}–${board.board.dayEnds}` }) : t('drawer.customHours')}
              </button>
            ))}
          </div>
          {mode === 'timed' ? (
            <div className="grid grid-cols-3 gap-3">
              <label className="space-y-1"><span className="text-xs text-slate-500">{t('drawer.starts')}</span><Input type="time" value={starts} disabled={!editable} onChange={(event) => setStarts(event.target.value)} /></label>
              <label className="space-y-1"><span className="text-xs text-slate-500">{t('drawer.ends')}</span><Input type="time" value={ends} disabled={!editable} onChange={(event) => setEnds(event.target.value)} /></label>
              <label className="space-y-1"><span className="text-xs text-slate-500">{t('drawer.break')}</span><Input type="number" min={0} max={240} step={5} value={breakMinutes} disabled={!editable} onChange={(event) => setBreakMinutes(event.target.value)} /></label>
              {ends <= starts ? <p className="col-span-3 text-xs text-slate-500">{t('drawer.overnight')}</p> : null}
            </div>
          ) : null}
          <p className="text-xs text-slate-500">{t('drawer.booked', { hours: formatMinutes(entry.workedMinutes) })}</p>
        </section>

        {editable && repeatCandidates.length ? (
          <section className="space-y-2">
            <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500"><Repeat2 className="h-3.5 w-3.5" />{t('drawer.repeat')}</h3>
            <div className="flex flex-wrap gap-1.5">
              {repeatCandidates.map((day) => {
                const on = repeatDays.has(day.date)
                return (
                  <button
                    key={day.date}
                    type="button"
                    onClick={() => setRepeatDays((current) => {
                      const next = new Set(current)
                      if (next.has(day.date)) next.delete(day.date)
                      else next.add(day.date)
                      return next
                    })}
                    className={cn(
                      'rounded-lg border px-2 py-1 text-xs tabular-nums transition',
                      on ? 'border-teal-600 bg-teal-600 text-white' : 'border-slate-200 text-slate-600 hover:border-slate-300 dark:border-slate-700 dark:text-slate-300',
                      day.isWeekend && !on && 'opacity-60',
                    )}
                  >
                    {weekdays.format(new Date(`${day.date}T00:00:00Z`))}
                  </button>
                )
              })}
            </div>
          </section>
        ) : null}

        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{t('drawer.notes')}</h3>
          <Textarea value={notes} rows={4} disabled={!editable} maxLength={2000} onChange={(event) => setNotes(event.target.value)} placeholder={t('drawer.notesPlaceholder')} />
        </section>
      </div>
    </Drawer>
  )
}
