'use client'

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import {
  CalendarDays, CalendarRange, ChevronLeft, ChevronRight, ChartGantt, LayoutGrid, ListChecks, Plus, Redo2, Rows3, Rows4, Search,
  Send, Settings2, Undo2, Users, X,
} from 'lucide-react'
import { Button, Input, Select, cn } from '@openbooks/ui'
import { BookingDrawer } from './BookingDrawer'
import { CalendarView } from './CalendarView'
import { NewBoardDrawer, type ScopeOptions } from './NewBoardDrawer'
import { PeopleGrid } from './PeopleGrid'
import { TargetsView } from './TargetsView'
import { TaskBoard, type TaskBoardProject } from './TaskBoard'
import { TimelineView } from './TimelineView'
import { CHIP_COLORS, chipStyle } from './BookingChip'
import { publish, SchedulingRequestError } from './api'
import { addDays, targetHue, viewRange, type BoardEntry, type BoardWindow, type GroupBy } from './model'
import { useBoard } from './use-board'
import type { ScheduleBoard } from '@openbooks/engine/src/schedule-boards/boards.ts'

export interface BoardSummary {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly rowKind: 'people' | 'tasks'
}

export interface SchedulingWorkspaceProps {
  readonly boards: readonly BoardSummary[]
  readonly board: ScheduleBoard | null
  readonly view: string
  readonly anchor: string
  readonly from: string
  readonly through: string
  readonly rangeDays: number
  readonly today: string
  readonly initialWindow: BoardWindow | null
  readonly refusal: { message: string; remedy: string | null } | null
  readonly projects: readonly TaskBoardProject[]
  readonly selectedProjectId: string | null
  readonly canManageProjects: boolean
  readonly canConfigure: boolean
  readonly settingsHref: string | null
  readonly timeZone: string
  readonly scope: ScopeOptions
  readonly peopleEnabled: boolean
  readonly tasksEnabled: boolean
}

const VIEW_ICONS = { grid: LayoutGrid, targets: Users, timeline: Rows3, calendar: CalendarDays, gantt: ChartGantt, progress: ListChecks } as const

export function SchedulingWorkspace(props: SchedulingWorkspaceProps) {
  const t = useTranslations('scheduling')
  const router = useRouter()
  const [newBoard, setNewBoard] = useState(false)

  if (!props.board) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-white p-12 text-center dark:border-slate-700 dark:bg-slate-950">
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-teal-50 text-teal-700 dark:bg-teal-950 dark:text-teal-300"><CalendarRange className="h-7 w-7" /></span>
        <h2 className="mt-4 text-lg font-semibold text-slate-900 dark:text-slate-100">{t('empty.title')}</h2>
        <p className="mt-1 max-w-md text-sm text-slate-500">{props.refusal?.message ?? t('empty.description')}</p>
        {props.canConfigure ? <Button className="mt-5" onClick={() => setNewBoard(true)}><Plus className="mr-1.5 h-4 w-4" />{t('empty.create')}</Button> : <p className="mt-4 text-xs text-slate-400">{t('empty.askAdmin')}</p>}
        <NewBoardDrawer open={newBoard} onClose={() => setNewBoard(false)} timeZone={props.timeZone} scope={props.scope} peopleEnabled={props.peopleEnabled} tasksEnabled={props.tasksEnabled} />
      </div>
    )
  }

  return (
    <BoardShell
      key={props.board.id}
      {...props}
      board={props.board}
      onSwitchBoard={(code) => router.push(`/scheduling?board=${encodeURIComponent(code)}`)}
      onNewBoard={() => setNewBoard(true)}
      newBoard={<NewBoardDrawer open={newBoard} onClose={() => setNewBoard(false)} timeZone={props.timeZone} scope={props.scope} peopleEnabled={props.peopleEnabled} tasksEnabled={props.tasksEnabled} />}
    />
  )
}

function BoardShell(props: SchedulingWorkspaceProps & { board: ScheduleBoard; onSwitchBoard: (code: string) => void; onNewBoard: () => void; newBoard: ReactNode }) {
  const { board } = props
  const t = useTranslations('scheduling')
  const locale = useLocale()
  const [view, setView] = useState(props.view)
  const [anchor, setAnchor] = useState(props.anchor)
  const [rangeDays, setRangeDays] = useState(props.rangeDays)
  const [projectId, setProjectId] = useState(props.selectedProjectId)
  const [groupBy, setGroupBy] = useState<GroupBy>('none')
  const [search, setSearch] = useState('')
  const [compact, setCompact] = useState(false)
  const [spotlight, setSpotlight] = useState<string | null>(null)
  const [openEntry, setOpenEntry] = useState<BoardEntry | null>(null)
  const [publishing, setPublishing] = useState(false)
  const range = useMemo(() => viewRange(view, anchor, rangeDays, board.weekStartsOn), [anchor, board.weekStartsOn, rangeDays, view])
  const people = board.rowKind === 'people'
  const controller = useBoard(board.id, people ? props.initialWindow : null, range, people)
  const window = controller.window

  // Keep the address shareable without a server round trip.
  useEffect(() => {
    const params = new URLSearchParams({ board: board.code, view })
    if (people) params.set('from', anchor)
    if (people && rangeDays !== board.rangeDays) params.set('days', String(rangeDays))
    if (!people && projectId) params.set('project', projectId)
    globalThis.history.replaceState(null, '', `/scheduling?${params.toString()}`)
  }, [anchor, board.code, board.rangeDays, people, projectId, rangeDays, view])

  const step = view === 'calendar' ? 'month' : rangeDays
  const move = useCallback((direction: -1 | 1) => {
    setAnchor((current) => {
      if (step === 'month') {
        const date = new Date(`${current.slice(0, 7)}-01T00:00:00Z`)
        date.setUTCMonth(date.getUTCMonth() + direction)
        return date.toISOString().slice(0, 10)
      }
      return addDays(current, direction * rangeDays)
    })
  }, [rangeDays, step])

  const label = useMemo(() => {
    if (view === 'calendar') return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${anchor.slice(0, 7)}-01T00:00:00Z`))
    const format = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' })
    const year = new Intl.DateTimeFormat(locale, { year: 'numeric', timeZone: 'UTC' })
    return `${format.format(new Date(`${range.from}T00:00:00Z`))} – ${format.format(new Date(`${range.through}T00:00:00Z`))}, ${year.format(new Date(`${range.through}T00:00:00Z`))}`
  }, [anchor, locale, range.from, range.through, view])

  const drafts = useMemo(() => window?.entries.filter((entry) => entry.status === 'draft' && entry.boardId === board.id) ?? [], [board.id, window])
  const legend = useMemo(() => {
    if (!window) return []
    const counts = new Map<string, { key: string; target: NonNullable<BoardEntry['target']>; people: Set<string> }>()
    for (const entry of window.entries) {
      if (!entry.target) continue
      const key = `${entry.target.kind}:${entry.target.id}`
      const slot = counts.get(key) ?? { key, target: entry.target, people: new Set<string>() }
      slot.people.add(entry.workerPartyId)
      counts.set(key, slot)
    }
    return [...counts.values()].sort((a, b) => b.people.size - a.people.size).slice(0, 14)
  }, [window])

  // Undo and redo answer anywhere on the page, not only inside the grid.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable || target.getAttribute('role') === 'grid')) return
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        void (event.shiftKey ? controller.redo() : controller.undo())
      }
    }
    globalThis.addEventListener('keydown', onKey)
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [controller])

  async function publishDrafts() {
    setPublishing(true)
    try {
      const result = await publish(board.id, range.from, range.through, t('errors.publish'))
      controller.notify('success', t('notices.published', { count: result.published }))
      await controller.reload()
    } catch (error) {
      controller.notify('error', error instanceof Error ? error.message : t('errors.publish'), error instanceof SchedulingRequestError ? error.remedy : null)
    } finally {
      setPublishing(false)
    }
  }

  async function discardDrafts() {
    await controller.run(drafts.map((entry) => ({ op: 'cancel' as const, id: entry.id, expectedRevision: entry.revision })), t('history.discard', { count: drafts.length }))
  }

  const rangeOptions = [...new Set([1, 3, 7, 14, 28, board.rangeDays])].sort((a, b) => a - b)

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <Select value={board.code} onChange={(event) => props.onSwitchBoard(event.target.value)} className="h-9 w-56 font-medium" aria-label={t('toolbar.board')}>
          {props.boards.some((candidate) => candidate.rowKind === 'people') ? (
            <optgroup label={t('toolbar.peopleBoards')}>
              {props.boards.filter((candidate) => candidate.rowKind === 'people').map((candidate) => <option key={candidate.id} value={candidate.code}>{candidate.name}</option>)}
            </optgroup>
          ) : null}
          {props.boards.some((candidate) => candidate.rowKind === 'tasks') ? (
            <optgroup label={t('toolbar.taskBoards')}>
              {props.boards.filter((candidate) => candidate.rowKind === 'tasks').map((candidate) => <option key={candidate.id} value={candidate.code}>{candidate.name}</option>)}
            </optgroup>
          ) : null}
        </Select>
        <div className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5 dark:border-slate-800 dark:bg-slate-950" role="tablist" aria-label={t('toolbar.views')}>
          {board.views.map((candidate) => {
            const Icon = VIEW_ICONS[candidate as keyof typeof VIEW_ICONS] ?? LayoutGrid
            return (
              <button
                key={candidate}
                type="button"
                role="tab"
                aria-selected={view === candidate}
                onClick={() => setView(candidate)}
                className={cn('inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition', view === candidate ? 'bg-slate-900 text-white shadow-sm dark:bg-slate-100 dark:text-slate-900' : 'text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white')}
              >
                <Icon className="h-3.5 w-3.5" />{t(`views.${candidate}`)}
              </button>
            )
          })}
        </div>
        {people ? (
          <div className="flex items-center gap-1">
            <Button variant="outline" size="sm" onClick={() => move(-1)} aria-label={t('toolbar.previous')}><ChevronLeft className="h-4 w-4" /></Button>
            <Button variant="outline" size="sm" onClick={() => setAnchor(props.today)}>{t('toolbar.today')}</Button>
            <Button variant="outline" size="sm" onClick={() => move(1)} aria-label={t('toolbar.next')}><ChevronRight className="h-4 w-4" /></Button>
            <span className="ml-2 min-w-[11rem] text-sm font-semibold text-slate-800 dark:text-slate-100">{label}</span>
            {view !== 'calendar' ? (
              <Select value={String(rangeDays)} onChange={(event) => setRangeDays(Number(event.target.value))} className="h-8 w-28 text-xs" aria-label={t('toolbar.range')}>
                {rangeOptions.map((days) => <option key={days} value={days}>{t('toolbar.days', { count: days })}</option>)}
              </Select>
            ) : null}
          </div>
        ) : null}
        <div className="ml-auto flex items-center gap-1.5">
          {people && view !== 'calendar' ? (
            <>
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('toolbar.search')} className="h-8 w-44 pl-7 text-xs" aria-label={t('toolbar.search')} />
              </div>
              <Select value={groupBy} onChange={(event) => setGroupBy(event.target.value as GroupBy)} className="h-8 w-36 text-xs" aria-label={t('toolbar.groupBy')}>
                {(['none', 'department', 'trade', 'jobTitle'] as const).map((option) => <option key={option} value={option}>{t(`groupBy.${option}`)}</option>)}
              </Select>
              {view === 'grid' ? (
                <Button variant="ghost" size="sm" onClick={() => setCompact((value) => !value)} aria-label={t('toolbar.density')} title={t('toolbar.density')}>
                  {compact ? <Rows4 className="h-4 w-4" /> : <Rows3 className="h-4 w-4" />}
                </Button>
              ) : null}
              <Button variant="ghost" size="sm" disabled={!controller.canUndo} onClick={() => void controller.undo()} title={controller.undoLabel ? t('toolbar.undoWhat', { what: controller.undoLabel }) : t('toolbar.undo')} aria-label={t('toolbar.undo')}><Undo2 className="h-4 w-4" /></Button>
              <Button variant="ghost" size="sm" disabled={!controller.canRedo} onClick={() => void controller.redo()} aria-label={t('toolbar.redo')} title={t('toolbar.redo')}><Redo2 className="h-4 w-4" /></Button>
            </>
          ) : null}
          {props.settingsHref ? (
            <Button variant="ghost" size="sm" asChild title={t('toolbar.settings')}>
              <Link href={props.settingsHref} aria-label={t('toolbar.settings')}><Settings2 className="h-4 w-4" /></Link>
            </Button>
          ) : null}
          {props.canConfigure ? <Button variant="outline" size="sm" onClick={props.onNewBoard}><Plus className="mr-1 h-4 w-4" />{t('toolbar.newBoard')}</Button> : null}
        </div>
      </div>

      {/* Board context: scope, refusals, staged changes, legend */}
      {people && window?.calendarNotice ? (
        <p className="rounded-lg bg-slate-100 px-3 py-1.5 text-xs text-slate-600 dark:bg-slate-900 dark:text-slate-300">{window.calendarNotice}</p>
      ) : null}
      {props.refusal ? (
        <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">{props.refusal.message}{props.refusal.remedy ? ` ${props.refusal.remedy}` : ''}</p>
      ) : null}
      {people && board.publishPolicy === 'staged' && drafts.length ? (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 dark:border-amber-900 dark:bg-amber-950/30">
          <span className="h-2 w-2 rounded-full bg-amber-500" />
          <span className="text-sm font-medium text-amber-900 dark:text-amber-100">{t('publish.pending', { count: drafts.length, people: new Set(drafts.map((entry) => entry.workerPartyId)).size })}</span>
          <span className="text-xs text-amber-800/80 dark:text-amber-200/70">{t('publish.explain')}</span>
          <div className="ml-auto flex gap-2">
            {window?.canManage ? <Button variant="ghost" size="sm" onClick={() => void discardDrafts()}>{t('publish.discard')}</Button> : null}
            {window?.canPublish ? <Button size="sm" onClick={() => void publishDrafts()} disabled={publishing}><Send className="mr-1.5 h-3.5 w-3.5" />{t('publish.action')}</Button> : null}
          </div>
        </div>
      ) : null}
      {people && view === 'grid' && legend.length ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {legend.map((slot) => (
            <button
              key={slot.key}
              type="button"
              onClick={() => setSpotlight((current) => (current === slot.key ? null : slot.key))}
              style={chipStyle(targetHue(slot.target))}
              className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold transition', CHIP_COLORS, spotlight && spotlight !== slot.key && 'opacity-40', spotlight === slot.key && 'ring-2 ring-teal-500/50')}
              title={slot.target.label}
            >
              {slot.target.code ?? slot.target.label}
              <span className="rounded-full bg-white/60 px-1 text-[10px] tabular-nums dark:bg-black/20">{slot.people.size}</span>
            </button>
          ))}
        </div>
      ) : null}

      {/* Body: one view at a time */}
      <div className="flex min-h-0 flex-1 flex-col">
        {!people ? (
          <TaskBoard
            boardId={board.id}
            view={view === 'progress' ? 'progress' : 'gantt'}
            projects={props.projects}
            selectedProjectId={projectId}
            onSelectProject={setProjectId}
            canManage={props.canManageProjects}
          />
        ) : !window ? (
          <div className="flex-1 animate-pulse rounded-xl border border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900" />
        ) : (
          <div className={cn('flex min-h-0 flex-1 flex-col transition-opacity', controller.loading && 'opacity-60')}>
            {view === 'grid' ? (
              <PeopleGrid controller={controller} window={window} groupBy={groupBy} search={search} compact={compact} spotlight={spotlight} onSpotlight={setSpotlight} onOpenEntry={setOpenEntry} today={props.today} />
            ) : view === 'targets' ? (
              <TargetsView controller={controller} window={window} today={props.today} onOpenEntry={setOpenEntry} />
            ) : view === 'timeline' ? (
              <TimelineView controller={controller} window={window} groupBy={groupBy} search={search} today={props.today} onOpenEntry={setOpenEntry} />
            ) : (
              <CalendarView window={window} month={anchor.slice(0, 7)} today={props.today} onOpenEntry={setOpenEntry} />
            )}
          </div>
        )}
      </div>

      {window && openEntry ? (
        <BookingDrawer entry={window.entries.find((entry) => entry.id === openEntry.id) ?? openEntry} window={window} controller={controller} onClose={() => setOpenEntry(null)} />
      ) : null}
      {props.newBoard}

      {/* Notices */}
      <div className="pointer-events-none fixed bottom-5 right-5 z-[70] flex w-96 max-w-[calc(100vw-2.5rem)] flex-col gap-2">
        {controller.notices.map((notice) => (
          <div
            key={notice.id}
            role={notice.tone === 'error' ? 'alert' : 'status'}
            className={cn('pointer-events-auto flex items-start gap-3 rounded-xl border px-4 py-3 text-sm shadow-lg', notice.tone === 'error' ? 'border-rose-200 bg-white text-rose-900 dark:border-rose-900 dark:bg-slate-900 dark:text-rose-200' : 'border-emerald-200 bg-white text-emerald-900 dark:border-emerald-900 dark:bg-slate-900 dark:text-emerald-200')}
          >
            <div className="min-w-0 flex-1">
              <p className="font-medium">{notice.message}</p>
              {notice.remedy ? <p className="mt-0.5 text-xs opacity-80">{notice.remedy}</p> : null}
            </div>
            <button type="button" onClick={() => controller.dismiss(notice.id)} aria-label={t('notices.dismiss')} className="shrink-0 opacity-60 hover:opacity-100"><X className="h-4 w-4" /></button>
          </div>
        ))}
      </div>
    </div>
  )
}
