'use client'

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import {
  CalendarRange, ChevronLeft, ChevronRight, Plus, Redo2, Rows3, Rows4,
  Send, Settings2, MoreHorizontal, Undo2, X,
} from 'lucide-react'
import { Button, Input, Select, Popover, cn } from '@openbooks/ui'
import { SchedulingAlert } from './SchedulingAlert'
import { BookingDrawer } from './BookingDrawer'
import { SourceRecordDrawer } from './SourceRecord'
import type { BoardSourceRecord } from '@openbooks/engine/src/schedule-boards/source-history.ts'
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
  readonly rowKind: 'people' | 'tasks' | 'resources'
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
  readonly resourcesEnabled: boolean
  readonly equipmentEnabled: boolean
}


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
        {props.refusal?.remedy ? <p className="mt-1 max-w-md text-xs text-slate-400">{props.refusal.remedy}</p> : null}
        {props.refusal ? null : props.canConfigure ? <Button className="mt-5" onClick={() => setNewBoard(true)}><Plus className="mr-1.5 h-4 w-4" />{t('empty.create')}</Button> : <p className="mt-4 text-xs text-slate-400">{t('empty.askAdmin')}</p>}
        <NewBoardDrawer open={newBoard} onClose={() => setNewBoard(false)} timeZone={props.timeZone} scope={props.scope} peopleEnabled={props.peopleEnabled} tasksEnabled={props.tasksEnabled} resourcesEnabled={props.resourcesEnabled} equipmentEnabled={props.equipmentEnabled} />
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
      newBoard={<NewBoardDrawer open={newBoard} onClose={() => setNewBoard(false)} timeZone={props.timeZone} scope={props.scope} peopleEnabled={props.peopleEnabled} tasksEnabled={props.tasksEnabled} resourcesEnabled={props.resourcesEnabled} equipmentEnabled={props.equipmentEnabled} />}
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
  const [openSourceRecord, setOpenSourceRecord] = useState<BoardSourceRecord | null>(null)
  const [publishing, setPublishing] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const range = useMemo(() => viewRange(view, anchor, rangeDays, board.weekStartsOn), [anchor, board.weekStartsOn, rangeDays, view])
  const people = board.rowKind !== 'tasks'
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
      slot.people.add(entry.subjectId)
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
    <div className="flex h-full min-h-0 min-w-0 flex-col gap-2">
      <div className="flex min-w-0 shrink-0 flex-nowrap items-center gap-1.5" role="toolbar" aria-label={t('toolbar.board')}>
        <Select value={board.code} onChange={(event) => props.onSwitchBoard(event.target.value)} className="h-8 min-w-0 flex-1 basis-24 text-xs font-medium sm:max-w-52" aria-label={t('toolbar.board')}>
          {props.boards.map((candidate) => <option key={candidate.id} value={candidate.code}>{candidate.name}</option>)}
        </Select>
        <Select value={view} onChange={(event) => setView(event.target.value)} className="h-8 w-24 shrink-0 text-xs" aria-label={t('toolbar.views')}>
          {board.views.map((candidate) => <option key={candidate} value={candidate}>{t(`views.${candidate}`)}</option>)}
        </Select>
        {people ? <div className="hidden shrink-0 items-center gap-1 sm:flex">
          <Button variant="outline" size="sm" className="h-8 px-2" onClick={() => move(-1)} aria-label={t('toolbar.previous')}><ChevronLeft className="h-4 w-4" /></Button>
          <Button variant="outline" size="sm" className="h-8 px-2 text-xs" onClick={() => setAnchor(props.today)}>{t('toolbar.today')}</Button>
          <Button variant="outline" size="sm" className="h-8 px-2" onClick={() => move(1)} aria-label={t('toolbar.next')}><ChevronRight className="h-4 w-4" /></Button>
          <span className="hidden max-w-52 truncate px-1 text-xs font-semibold text-slate-700 dark:text-slate-200 lg:block" title={label}>{label}</span>
        </div> : null}
        {!people && props.projects.length > 1 ? <Select value={projectId ?? ''} onChange={(event) => setProjectId(event.target.value)} className="h-8 min-w-0 flex-1 basis-28 text-xs" aria-label={t('tasks.pickProject')}>{props.projects.map((project) => <option key={project.id} value={project.id}>{project.code ? `${project.code} · ` : ''}{project.name}</option>)}</Select> : null}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {props.settingsHref ? <Button variant="ghost" size="sm" className="h-8 px-2" asChild title={t('toolbar.settings')}>
            <Link href={props.settingsHref} aria-label={t('toolbar.settings')}><Settings2 className="h-4 w-4" /></Link>
          </Button> : null}
          {props.canConfigure ? <Button variant="outline" size="sm" className="h-8 gap-1 px-2 text-xs" onClick={props.onNewBoard} aria-label={t('toolbar.newBoard')} title={t('toolbar.newBoard')}><Plus className="h-4 w-4" /><span className="hidden xl:inline">{t('toolbar.newBoard')}</span></Button> : null}
          {people ? <Popover open={moreOpen} onOpenChange={setMoreOpen} align="end" className="w-72 max-w-[calc(100vw-2rem)]" trigger={<Button variant="outline" size="sm" className="h-8 px-2" onClick={() => setMoreOpen((value) => !value)} aria-label={t('toolbar.more')} aria-expanded={moreOpen}><MoreHorizontal className="h-4 w-4" /></Button>}>
            <div className="space-y-3 p-3">
              <div className="flex items-center justify-between gap-2 text-xs"><Button variant="ghost" size="sm" onClick={() => move(-1)} aria-label={t('toolbar.previous')}><ChevronLeft className="h-4 w-4" /></Button><span>{label}</span><Button variant="ghost" size="sm" onClick={() => move(1)} aria-label={t('toolbar.next')}><ChevronRight className="h-4 w-4" /></Button></div>
              <Input type="date" value={anchor} onChange={(event) => { if (event.target.value) setAnchor(event.target.value) }} aria-label={t('toolbar.date')} />
              <Button variant="outline" size="sm" onClick={() => setAnchor(props.today)}>{t('toolbar.today')}</Button>
              {view !== 'calendar' ? <><label className="block space-y-1 text-xs"><span>{t('toolbar.range')}</span><Select value={String(rangeDays)} onChange={(event) => setRangeDays(Number(event.target.value))} className="h-8 w-full text-xs">{rangeOptions.map((days) => <option key={days} value={days}>{t('toolbar.days', { count: days })}</option>)}</Select></label>
              <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('toolbar.search')} className="h-8 text-xs" aria-label={t('toolbar.search')} />
              <label className="block space-y-1 text-xs"><span>{t('toolbar.groupBy')}</span><Select value={groupBy} onChange={(event) => setGroupBy(event.target.value as GroupBy)} className="h-8 w-full text-xs">{(['none', 'department', 'trade', 'jobTitle'] as const).map((option) => <option key={option} value={option}>{t(`groupBy.${option}`)}</option>)}</Select></label>
              <div className="flex items-center gap-1">{view === 'grid' ? <Button variant="ghost" size="sm" onClick={() => setCompact((value) => !value)} aria-label={t('toolbar.density')} title={t('toolbar.density')}>{compact ? <Rows4 className="h-4 w-4" /> : <Rows3 className="h-4 w-4" />}</Button> : null}
              <Button variant="ghost" size="sm" disabled={!controller.canUndo} onClick={() => void controller.undo()} aria-label={t('toolbar.undo')} title={controller.undoLabel ?? t('toolbar.undo')}><Undo2 className="h-4 w-4" /></Button>
              <Button variant="ghost" size="sm" disabled={!controller.canRedo} onClick={() => void controller.redo()} aria-label={t('toolbar.redo')}><Redo2 className="h-4 w-4" /></Button></div></> : null}
            </div>
          </Popover> : null}
        </div>
      </div>

      {/* Board context: scope, refusals, staged changes, legend */}
      {props.refusal ? (
        <SchedulingAlert message={props.refusal.message} remedy={props.refusal.remedy} />
      ) : null}
      {people && board.publishPolicy === 'staged' && drafts.length ? (
        <SchedulingAlert tone="warning" message={t('publish.pending', { count: drafts.length, people: new Set(drafts.map((entry) => entry.subjectId)).size })} remedy={t('publish.explain')}>
          {window?.canManage ? <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => void discardDrafts()}>{t('publish.discard')}</Button> : null}
          {window?.canPublish ? <Button size="sm" className="h-7 px-2 text-xs" onClick={() => void publishDrafts()} disabled={publishing}><Send className="mr-1 h-3.5 w-3.5" />{t('publish.action')}</Button> : null}
        </SchedulingAlert>
      ) : null}
      {people && view === 'grid' && legend.length ? (
        <div className="flex min-w-0 shrink-0 flex-nowrap items-center gap-1.5 overflow-x-auto">
          {legend.map((slot) => (
            <button
              key={slot.key}
              type="button"
              onClick={() => setSpotlight((current) => (current === slot.key ? null : slot.key))}
              style={chipStyle(targetHue(slot.target), slot.target.color)}
              className={cn('inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold transition', CHIP_COLORS, spotlight && spotlight !== slot.key && 'opacity-40', spotlight === slot.key && 'ring-2 ring-teal-500/50')}
              title={slot.target.label}
            >
              {slot.target.code ?? slot.target.label}
              <span className="rounded-full bg-white/60 px-1 text-[10px] tabular-nums dark:bg-black/20">{slot.people.size}</span>
            </button>
          ))}
        </div>
      ) : null}

      {/* Body: one view at a time */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
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
              <PeopleGrid controller={controller} window={window} groupBy={groupBy} search={search} compact={compact} spotlight={spotlight} onSpotlight={setSpotlight} onOpenEntry={entry => { setOpenSourceRecord(null); setOpenEntry(entry) }} onOpenSourceRecord={record => { setOpenEntry(null); setOpenSourceRecord(record) }} today={props.today} />
            ) : view === 'targets' ? (
              <TargetsView controller={controller} window={window} today={props.today} onOpenEntry={entry => { setOpenSourceRecord(null); setOpenEntry(entry) }} onOpenSourceRecord={record => { setOpenEntry(null); setOpenSourceRecord(record) }} />
            ) : view === 'timeline' ? (
              <TimelineView controller={controller} window={window} groupBy={groupBy} search={search} today={props.today} onOpenEntry={entry => { setOpenSourceRecord(null); setOpenEntry(entry) }} onOpenSourceRecord={record => { setOpenEntry(null); setOpenSourceRecord(record) }} />
            ) : (
              <CalendarView window={window} month={anchor.slice(0, 7)} today={props.today} onOpenEntry={entry => { setOpenSourceRecord(null); setOpenEntry(entry) }} onOpenSourceRecord={record => { setOpenEntry(null); setOpenSourceRecord(record) }} />
            )}
          </div>
        )}
      </div>

      {window && openSourceRecord ? <SourceRecordDrawer record={openSourceRecord} records={window.sourceRecords ?? []}
        workerName={window.rows.find(r => r.subjectId === openSourceRecord.workerPartyId)?.name ?? t('drawer.title')}
        onSelect={setOpenSourceRecord} onClose={() => setOpenSourceRecord(null)} /> : null}
      {window && openEntry && !openSourceRecord ? (
        <BookingDrawer entry={window.entries.find((entry) => entry.id === openEntry.id) ?? openEntry} window={window} controller={controller} onClose={() => setOpenEntry(null)} />
      ) : null}
      {props.newBoard}

      {/* Notices */}
      <div className="pointer-events-none fixed bottom-5 right-5 z-[70] flex w-96 max-w-[calc(100vw-2.5rem)] flex-col gap-2">
        {controller.notices.map((notice) => (
          <div key={notice.id} className="pointer-events-auto rounded-lg shadow-lg">
            <SchedulingAlert message={notice.message} remedy={notice.remedy} tone={notice.tone === 'error' ? 'error' : 'info'}>
              <button type="button" onClick={() => controller.dismiss(notice.id)} aria-label={t('notices.dismiss')} className="shrink-0 p-1 opacity-60 hover:opacity-100"><X className="h-4 w-4" /></button>
            </SchedulingAlert>
          </div>
        ))}
      </div>
    </div>
  )
}
