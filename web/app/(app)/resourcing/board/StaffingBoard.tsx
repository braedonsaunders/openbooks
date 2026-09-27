'use client'

import { useMemo, useRef, useState, useTransition, type DragEvent, type KeyboardEvent } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { ArrowLeft, ArrowRight } from 'lucide-react'
import { Badge, Button, ContextMenu, Input, Select, useContextMenu } from '@openbooks/ui'
import { formatTicketHours } from '../../../../lib/format'
import { PagedTable, type PagedColumn } from '../../../../components/paged-table'
import { ListFilterSelect } from '../../../../components/list-filter-select'
import { nextCell, boardCell, type CellArrow, type CellPosition } from '../../../../lib/resourcing/board-cells'
import { sum } from '@openbooks/engine/src/money/money.ts'
import type { PersonWeekForecast } from '@openbooks/engine/src/resourcing/forecast.ts'
import type { ResourcingBoard } from '../../../../lib/resourcing/queries'

type Assignment = ResourcingBoard['rows'][number]
type Labels = Record<string, string> & {
  noPeople: string
  noCapacity: string
  capacityRemedy: string
  hard: string
  soft: string
  available: string
  person: string
  project: string
  departments: string
  jobTitles: string
  skills: string
  projects: string
  all: string
  startDate: string
  weeks: string
  view: string
  addAssignment: string
}
type FilterOptions = {
  departments: { value: string; label: string }[]
  jobTitles: { value: string; label: string }[]
  skills: { value: string; label: string }[]
  projects: { value: string; label: string }[]
}
type CellIntent = {
  assignmentIds: string[]
  week: string
  personId?: string
  projectId?: string
  anchor: HTMLButtonElement
}
type PersonBoardRow = {
  kind: 'person'
  key: string
  index: number
  personId: string
  name: string
  jobTitle: string
  department: string
  byWeek: Map<string, PersonWeekForecast>
}
type ProjectBoardRow = {
  kind: 'project'
  key: string
  index: number
  projectId: string
  name: string
  byWeek: Map<string, { hard: string; soft: string; assignmentIds: string[] }>
}
type BoardRow = PersonBoardRow | ProjectBoardRow

function hrefWith(
  current: Record<string, string | string[] | undefined>,
  updates: Record<string, string | undefined>,
): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(current)) if (typeof value === 'string') params.set(key, value)
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined || value === '') params.delete(key)
    else params.set(key, value)
  }
  const query = params.toString()
  return query ? `/resourcing/board?${query}` : '/resourcing/board'
}

export function StaffingBoard({
  board,
  weeks,
  view,
  canManage,
  currentParams,
  filterOptions,
  labels,
}: {
  board: ResourcingBoard
  weeks: string[]
  view: 'person' | 'project'
  canManage: boolean
  currentParams: Record<string, string | string[] | undefined>
  filterOptions: FilterOptions
  labels: Labels
}) {
  const t = useTranslations('resourcing')
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [focus, setFocus] = useState<CellPosition>({ row: 0, column: 0 })
  const [intent, setIntent] = useState<CellIntent | null>(null)
  const menu = useContextMenu()
  const cellRefs = useRef(new Map<string, HTMLButtonElement>())
  const projectNameById = useMemo(() => new Map(filterOptions.projects.map((project) => [project.value, project.label])), [filterOptions.projects])
  const assignmentsById = useMemo(() => new Map(board.rows.map((row) => [row.id, row])), [board.rows])

  const rows = useMemo<BoardRow[]>(() => {
    if (view === 'person') {
      const byPersonWeek = new Map<string, PersonWeekForecast>()
      for (const fact of board.forecast.personWeeks) byPersonWeek.set(`${fact.employeePartyId}:${fact.weekStart}`, fact)
      return board.people.map((person, index) => ({
        kind: 'person',
        key: person.partyId,
        index,
        personId: person.partyId,
        name: person.displayName,
        jobTitle: person.jobTitle ?? '',
        department: filterOptions.departments.find((item) => item.value === person.departmentId)?.label ?? '',
        byWeek: new Map(weeks.map((week) => [week, byPersonWeek.get(`${person.partyId}:${week}`)!]).filter((entry): entry is [string, PersonWeekForecast] => entry[1] !== undefined)),
      }))
    }
    const projects = new Map<string, { name: string; byWeek: Map<string, Assignment[]> }>(filterOptions.projects.map((project) => [project.value, {
      name: project.label,
      byWeek: new Map<string, Assignment[]>(),
    }]))
    for (const assignment of board.rows) {
      const current = projects.get(assignment.projectId) ?? {
        name: projectNameById.get(assignment.projectId) ?? assignment.projectId,
        byWeek: new Map<string, Assignment[]>(),
      }
      const group = current.byWeek.get(assignment.weekStart) ?? []
      group.push(assignment)
      current.byWeek.set(assignment.weekStart, group)
      projects.set(assignment.projectId, current)
    }
    return [...projects.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name)).map(([projectId, entry], index) => ({
      kind: 'project',
      key: projectId,
      index,
      projectId,
      name: entry.name,
      byWeek: new Map([...entry.byWeek].map(([week, assignments]) => [week, {
        hard: sum(assignments.filter((item) => item.booking === 'hard').map((item) => item.plannedHours)),
        soft: sum(assignments.filter((item) => item.booking === 'soft').map((item) => item.plannedHours)),
        assignmentIds: assignments.map((item) => item.id).sort(),
      }])),
    }))
  }, [board, filterOptions.departments, filterOptions.projects, projectNameById, view, weeks])
  const focusedCell = {
    row: Math.min(focus.row, Math.max(0, rows.length - 1)),
    column: Math.min(focus.column, Math.max(0, weeks.length - 1)),
  }

  const openAssignment = (assignmentId: string) => {
    startTransition(() => router.push(hrefWith(currentParams, { assignment: assignmentId, person: undefined, week: undefined, prefillProject: undefined, prefillHours: undefined }) as never))
  }
  const openNew = (cell: CellIntent, extra?: { projectId?: string; hours?: string }) => {
    if (!canManage) return
    startTransition(() => router.push(hrefWith(currentParams, {
      assignment: 'new',
      person: cell.personId,
      week: cell.week,
      prefillProject: extra?.projectId ?? cell.projectId,
      prefillHours: extra?.hours,
    }) as never))
  }

  function activateCell(cell: Omit<CellIntent, 'anchor'>, anchor: HTMLButtonElement) {
    const nextIntent = { ...cell, anchor }
    if (cell.assignmentIds.length === 1) {
      openAssignment(cell.assignmentIds[0]!)
      return
    }
    if (cell.assignmentIds.length === 0 && !canManage) return
    if (cell.assignmentIds.length === 0) {
      openNew(nextIntent)
      return
    }
    setIntent(nextIntent)
    menu.openBelow(anchor)
  }

  function keyMove(event: KeyboardEvent<HTMLButtonElement>, row: BoardRow, column: number) {
    const key = event.key
    if (!(key === 'ArrowUp' || key === 'ArrowDown' || key === 'ArrowLeft' || key === 'ArrowRight')) return
    event.preventDefault()
    const next = nextCell({ row: row.index, column }, key as CellArrow, { rows: rows.length, columns: weeks.length })
    setFocus(next)
    cellRefs.current.get(`${next.row}:${next.column}`)?.focus()
  }

  function dropDemand(event: DragEvent<HTMLButtonElement>, row: BoardRow, week: string) {
    if (!canManage || row.kind !== 'person') return
    const raw = event.dataTransfer.getData('application/x-openbooks-resourcing-assignment')
    if (!raw) return
    event.preventDefault()
    try {
      const demand = JSON.parse(raw) as { projectId: string; plannedHours: string; weekStart: string }
      if (!demand.projectId || !demand.plannedHours || demand.weekStart !== week) return
      openNew({ assignmentIds: [], week, personId: row.personId, anchor: event.currentTarget }, { projectId: demand.projectId, hours: demand.plannedHours })
    } catch {
      return
    }
  }

  const columns: PagedColumn<BoardRow>[] = [
    {
      key: 'subject',
      header: view === 'person' ? labels.person : labels.project,
      cell: (row) => <div className="min-w-40"><div className="font-medium text-slate-800 dark:text-slate-100">{row.name}</div>{row.kind === 'person' ? <div className="text-xs text-slate-500 dark:text-slate-400">{[row.jobTitle, row.department].filter(Boolean).join(' · ') || '—'}</div> : null}</div>,
      search: (row) => row.name,
    },
    ...weeks.map((week, columnIndex) => ({
      key: week,
      header: <span className="whitespace-nowrap">{week}</span>,
      cell: (row: BoardRow) => {
        const position = `${row.index}:${columnIndex}`
        const personFact = row.kind === 'person' ? row.byWeek.get(week) : undefined
        const projectFact = row.kind === 'project' ? row.byWeek.get(week) : undefined
        const assignmentIds = row.kind === 'person' ? personFact?.assignmentIds ?? [] : projectFact?.assignmentIds ?? []
        const intentData = {
          assignmentIds,
          week,
          personId: row.kind === 'person' ? row.personId : undefined,
          projectId: row.kind === 'project' ? row.projectId : undefined,
        }
        const chips = row.kind === 'person' ? boardCell(personFact) : null
        const hard = formatTicketHours(projectFact?.hard ?? '0.0000')
        const soft = formatTicketHours(projectFact?.soft ?? '0.0000')
        const ariaParts = row.kind === 'person'
          ? chips!.map((chip) => chip.key === 'capacity' ? labels.noCapacity : `${labels[chip.key] ?? chip.key} ${chip.hours} hours`)
          : [`${labels.hard} ${hard} hours`, `${labels.soft} ${soft} hours`]
        const capacityRemedy = chips?.find((chip) => chip.key === 'capacity')?.remedy
        return (
          <button
            ref={(node) => { if (node) cellRefs.current.set(position, node); else cellRefs.current.delete(position) }}
            type="button"
            data-row-action=""
            data-board-row={row.index}
            data-board-week={columnIndex}
            tabIndex={focusedCell.row === row.index && focusedCell.column === columnIndex ? 0 : -1}
          aria-label={`${row.name}, ${week}: ${ariaParts.join(', ')}${capacityRemedy ? `. ${labels.capacityRemedy}` : ''}`}
            className="flex min-h-12 min-w-36 flex-col items-start justify-center gap-1 rounded-md px-1 py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600"
            onFocus={() => setFocus({ row: row.index, column: columnIndex })}
            onKeyDown={(event) => keyMove(event, row, columnIndex)}
            onClick={(event) => activateCell(intentData, event.currentTarget)}
            onDragOver={(event) => { if (canManage && row.kind === 'person') event.preventDefault() }}
            onDrop={(event) => dropDemand(event, row, week)}
          >
            {row.kind === 'person'
              ? chips!.map((chip) => <Badge key={chip.key} variant={chip.variant} title={chip.remedy ? labels.capacityRemedy : undefined}>{chip.key === 'capacity' ? labels.noCapacity : `${labels[chip.key] ?? chip.key} ${chip.hours} h`}</Badge>)
              : <><Badge variant="secondary">{labels.hard} {hard} h</Badge><Badge variant="outline">{labels.soft} {soft} h</Badge></>}
          </button>
        )
      },
    })),
  ]

  const selectedAssignments = intent?.assignmentIds.flatMap((id) => {
    const assignment = assignmentsById.get(id)
    return assignment ? [{ id, assignment }] : []
  }) ?? []
  const contextItems = [
    ...selectedAssignments.map(({ id, assignment }) => ({
      key: id,
      label: `${projectNameById.get(assignment.projectId) ?? assignment.projectId} · ${formatTicketHours(assignment.plannedHours)} h · ${assignment.booking}`,
      onSelect: () => openAssignment(id),
    })),
    ...(canManage && intent ? [{
      key: 'new',
      label: labels.addAssignment,
      onSelect: () => openNew(intent),
    }] : []),
  ]

  const maxPage = Math.max(1, Math.ceil(board.total / board.pageSize))
  const toolbar = (
    <div className="flex flex-wrap items-end gap-3">
      <label className="inline-flex flex-col gap-1 text-xs text-slate-600 dark:text-slate-300">
        <span>{labels.startDate}</span>
        <Input type="date" value={String(currentParams.from ?? weeks[0])} disabled={pending} onChange={(event) => router.push(hrefWith(currentParams, { from: event.target.value, page: '1' }) as never)} />
      </label>
      <label className="inline-flex flex-col gap-1 text-xs text-slate-600 dark:text-slate-300">
        <span>{labels.weeks}</span>
        <Select value={String(currentParams.weeks ?? '12')} disabled={pending} onChange={(event) => router.push(hrefWith(currentParams, { weeks: event.target.value, page: '1' }) as never)}>
          {[4, 8, 12, 16, 20, 26].map((count) => <option key={count} value={count}>{count}</option>)}
        </Select>
      </label>
      <label className="inline-flex flex-col gap-1 text-xs text-slate-600 dark:text-slate-300">
        <span>{labels.view}</span>
        <Select value={view} disabled={pending} onChange={(event) => router.push(hrefWith(currentParams, { view: event.target.value, page: '1' }) as never)}>
          <option value="person">{labels.person}</option><option value="project">{labels.project}</option>
        </Select>
      </label>
      <ListFilterSelect basePath="/resourcing/board" currentParams={currentParams} paramKey="department" label={labels.departments} allLabel={labels.all} options={filterOptions.departments} />
      <ListFilterSelect basePath="/resourcing/board" currentParams={currentParams} paramKey="jobTitle" label={labels.jobTitles} allLabel={labels.all} options={filterOptions.jobTitles} />
      {filterOptions.skills.length ? <ListFilterSelect basePath="/resourcing/board" currentParams={currentParams} paramKey="skill" label={labels.skills} allLabel={labels.all} options={filterOptions.skills} /> : null}
      <ListFilterSelect basePath="/resourcing/board" currentParams={currentParams} paramKey="project" label={labels.projects} allLabel={labels.all} options={filterOptions.projects} />
      <div className="ml-auto flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
        <span>{t('board.page', { page: board.page, total: board.total })}</span>
        <Button variant="outline" size="sm" disabled={pending || board.page <= 1} aria-label={t('board.previousPage')} onClick={() => router.push(hrefWith(currentParams, { page: String(board.page - 1) }) as never)}><ArrowLeft size={15} aria-hidden /></Button>
        <Button variant="outline" size="sm" disabled={pending || board.page >= maxPage} aria-label={t('board.nextPage')} onClick={() => router.push(hrefWith(currentParams, { page: String(board.page + 1) }) as never)}><ArrowRight size={15} aria-hidden /></Button>
      </div>
    </div>
  )

  return (
    <div className="min-w-0 space-y-4">
      {toolbar}
      {board.excludedGenericAssignmentCount > 0 ? <p className="text-xs text-amber-800 dark:text-amber-200">{t('board.excludedGenericAssignments', { count: board.excludedGenericAssignmentCount })}</p> : null}
      <PagedTable
        rows={rows}
        columns={columns}
        rowKey={(row) => row.key}
        pageSize={Math.max(1, Math.max(board.pageSize, rows.length))}
        empty={<p className="p-4 text-sm text-slate-500 dark:text-slate-400">{labels.noPeople}</p>}
      />
      <ContextMenu open={menu.open} position={menu.position} onClose={menu.close} items={contextItems} />
    </div>
  )
}
