import 'server-only'

import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { page, pageHeader, ref, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { businessTimeZone, businessToday } from '@openbooks/engine/src/platform/business-date.ts'
import { isIsoCalendarDate } from '@openbooks/engine/src/platform/iso-date.ts'
import { subsidiaryVisibleFilter } from '@openbooks/engine/src/organization/subsidiary-scope.ts'
import { enabledBoardKinds, listBoards, type ScheduleBoard } from '@openbooks/engine/src/schedule-boards/boards.ts'
import { ScheduleError, scheduleDatabaseRefusal } from '@openbooks/engine/src/schedule-boards/errors.ts'
import { loadBoardWindow, type BoardWindow } from '@openbooks/engine/src/schedule-boards/window.ts'
import { can, getAuthz } from '../../../lib/authz'
import { accessDeniedHref } from '../../../lib/gate-targets'
import { pickString } from '../../../lib/list-params'
import { viewRange } from '../../../components/scheduling/model'
import type { SchedulingWorkspaceProps } from '../../../components/scheduling/SchedulingWorkspace'

/**
 * Scheduling: every board the organization runs — people boards (day
 * dispatch, shift rosters, round-the-clock rotations) and task boards (the
 * project schedules) — in one workspace. The loader resolves the board, the
 * view and the first window; the workspace navigates dates client-side.
 */

export type SchedulingPageData = SchedulingWorkspaceProps & { title: string; description: string }

const f = ref<SchedulingPageData>()

const RANGE_DAYS = new Set([1, 3, 7, 14, 21, 28, 35, 42])

export async function loadSchedulingPage(searchParams: Record<string, string | string[] | undefined>): Promise<SchedulingPageData> {
  const { redirect, notFound } = await import('next/navigation')
  const authz = await getAuthz()
  if (!authz) return redirect('/login')
  const orgId = authz.user.orgId
  const actor = { orgId, actorId: authz.user.id }
  const kinds = await enabledBoardKinds(orgId)
  if (!kinds.people && !kinds.tasks) notFound()
  const canPeople = kinds.people && can(authz, 'hrm.shifts.read')
  const canTasks = kinds.tasks && can(authz, 'projects.read')
  if (!canPeople && !canTasks) return redirect(accessDeniedHref({ permission: kinds.people ? 'hrm.shifts.read' : 'projects.read' }))

  const t = await getTranslations('scheduling')
  const [today, timeZone] = await Promise.all([businessToday(orgId), businessTimeZone(orgId)])
  let boards: ScheduleBoard[] = []
  let upgrade: { message: string; remedy: string | null } | null = null
  try {
    boards = await listBoards(actor)
  } catch (error) {
    const refusal = scheduleDatabaseRefusal(error)
    if (!(refusal instanceof ScheduleError)) throw error
    upgrade = { message: refusal.message, remedy: refusal.remedy ?? null }
  }
  const usable = boards.filter((board) => (board.rowKind === 'people' ? canPeople : canTasks))
  const requested = pickString(searchParams.board)
  const requestedProjectId = pickString(searchParams.project)
  // A project link opens the task board that schedules that project.
  const board: ScheduleBoard | null = usable.find((candidate) => candidate.code === requested || candidate.id === requested)
    ?? (requestedProjectId ? usable.find((candidate) => candidate.rowKind === 'tasks' && (!candidate.projectId || candidate.projectId === requestedProjectId)) : undefined)
    ?? usable[0] ?? null
  const canConfigure = can(authz, 'admin.setup.manage')

  const allowed = authz.allowedSubsidiaryIds
  type Option = { id: string; name: string }
  const none: Option[] = []
  const [subsidiaries, departments, locations, projectOptions] = canConfigure ? await Promise.all([
    db.execute<Option>(sql`select id, name from subsidiaries where org_id = ${orgId} and is_active and not is_elimination ${subsidiaryVisibleFilter(sql`id`, allowed)} order by name`).then((result) => result.rows),
    db.execute<Option>(sql`select id, name from departments where org_id = ${orgId} and is_active order by name`).then((result) => result.rows),
    db.execute<Option>(sql`select id, name from locations where org_id = ${orgId} and is_active order by name`).then((result) => result.rows),
    db.execute<Option>(sql`select id, coalesce(code || ' · ', '') || name as name from projects where org_id = ${orgId} and is_active and status = 'active'
      ${subsidiaryVisibleFilter(sql`subsidiary_id`, allowed, { orgWideNull: true })} order by name limit 500`).then((result) => result.rows),
  ]) : [none, none, none, none]

  const base: Omit<SchedulingPageData, 'board' | 'view' | 'anchor' | 'from' | 'through' | 'rangeDays' | 'initialWindow' | 'projects' | 'selectedProjectId' | 'settingsHref'> = {
    title: t('title'),
    description: t('description'),
    boards: usable.map(({ id, code, name, rowKind }) => ({ id, code, name, rowKind })),
    today,
    refusal: upgrade,
    canManageProjects: can(authz, 'projects.manage'),
    canConfigure,
    timeZone,
    scope: { subsidiaries, departments, locations, projects: projectOptions },
    peopleEnabled: kinds.people,
    tasksEnabled: kinds.tasks,
  }
  if (!board) {
    return { ...base, board: null, view: 'grid', anchor: today, from: today, through: today, rangeDays: 14, initialWindow: null, projects: [], selectedProjectId: null, settingsHref: null }
  }

  const requestedView = pickString(searchParams.view)
  const view = requestedView && board.views.includes(requestedView) ? requestedView : board.defaultView
  const settingsHref = canConfigure ? `/admin/setup/schedule-boards?row=${board.id}` : null

  if (board.rowKind === 'tasks') {
    const projects = (await db.execute<{ id: string; code: string | null; name: string; customerName: string | null; startsOn: string | null; endsOn: string | null }>(sql`
      select p.id, p.code, p.name, c.display_name as "customerName", p.starts_on::text as "startsOn", p.ends_on::text as "endsOn"
        from projects p left join parties c on c.org_id = p.org_id and c.id = p.customer_id
       where p.org_id = ${orgId} and p.is_active and p.status = 'active'
         ${board.projectId ? sql`and p.id = ${board.projectId}` : sql``}
         ${board.subsidiaryId ? sql`and p.subsidiary_id in (with recursive tree as (select id from subsidiaries where org_id = ${orgId} and id = ${board.subsidiaryId}
             union all select s.id from subsidiaries s join tree on s.parent_id = tree.id where s.org_id = ${orgId}) select id from tree)` : sql``}
         ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, allowed, { orgWideNull: true })}
       order by p.name, p.id
       limit 500
    `)).rows
    const selectedProjectId = projects.find((project) => project.id === requestedProjectId)?.id ?? projects[0]?.id ?? null
    return { ...base, board, view, anchor: today, from: today, through: today, rangeDays: board.rangeDays, initialWindow: null, projects, selectedProjectId, settingsHref }
  }

  const requestedDays = Number(pickString(searchParams.days))
  const rangeDays = RANGE_DAYS.has(requestedDays) ? requestedDays : board.rangeDays
  const requestedFrom = pickString(searchParams.from)
  const anchor = requestedFrom && isIsoCalendarDate(requestedFrom) ? requestedFrom : today
  const { from, through } = viewRange(view, anchor, rangeDays, board.weekStartsOn)
  let initialWindow: BoardWindow | null = null
  let refusal: SchedulingPageData['refusal'] = null
  try {
    initialWindow = await loadBoardWindow({ ...actor, boardId: board.id, from, through })
  } catch (error) {
    if (!(error instanceof ScheduleError)) throw error
    refusal = { message: error.message, remedy: error.remedy ?? null }
  }
  return { ...base, refusal, board, view, anchor, from, through, rangeDays, initialWindow, projects: [], selectedProjectId: null, settingsHref }
}

export async function schedulingTitle(): Promise<string> {
  return (await getTranslations('scheduling'))('title')
}

export function schedulingSpec(data: SchedulingPageData): PageSpec {
  return page({
    route: '/scheduling',
    layout: 'list',
    bodyClassName: 'flex h-full min-h-0 flex-col',
    header: [pageHeader({ title: f('title'), description: f('description') })],
    body: [
      widgetBlock('scheduling-workspace', {
        boards: data.boards,
        board: data.board,
        view: data.view,
        anchor: data.anchor,
        from: data.from,
        through: data.through,
        rangeDays: data.rangeDays,
        today: data.today,
        initialWindow: data.initialWindow,
        refusal: data.refusal,
        projects: data.projects,
        selectedProjectId: data.selectedProjectId,
        canManageProjects: data.canManageProjects,
        canConfigure: data.canConfigure,
        settingsHref: data.settingsHref,
        timeZone: data.timeZone,
        scope: data.scope,
        peopleEnabled: data.peopleEnabled,
        tasksEnabled: data.tasksEnabled,
      }),
    ],
  })
}
