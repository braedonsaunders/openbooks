import 'server-only'

import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import {
  badge,
  column,
  field as item,
  page,
  pageHeader,
  panel,
  ref,
  table,
  text,
  widget,
  widgetBlock,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { requirePermission } from '../../../../lib/authz'
import { isFeatureEnabled } from '../../../../lib/features'
import { myClockDay, resolveOwnParty } from '@openbooks/engine/src/hrm/field-time/reads.ts'
import { loadFieldTimeSettings } from '@openbooks/engine/src/hrm/field-time/settings.ts'
import { ensureClockPhotoFolder } from '@openbooks/engine/src/hrm/field-time/photos.ts'

/**
 * The field clock page — the phone is the primary device. One state
 * card with the primary clock action (the `hrm-clock-controls` island:
 * picker sheet, break/switch, photo capture, offline queue), then
 * today's pairs as a shared `table` block. Loader-resolved rows only;
 * the spec carries no org or user id. 404s when fieldTime is off —
 * office orgs never see a clock.
 */

export interface ClockPageData {
  title: string
  description: string
  tabs: { href: string; label: string; active: boolean }[]
  clock: {
    clockedIn: boolean
    since: string | null
    projectId: string | null
    projectName: string | null
    costCodeRef: string | null
    onBreak: boolean
  }
  projects: { id: string; name: string; code: string | null }[]
  tasks: { id: string; name: string }[]
  photoRequired: boolean
  photoFolderId: string | null
  geoHint: string
  clockOutLabel: string
  pairsTitle: string
  emptyPairs: string
  inLabel: string
  outLabel: string
  projectLabel: string
  hoursLabel: string
  geoLabel: string
  rows: Record<string, unknown>[]
}

const f = ref<ClockPageData>()

export async function loadClockPage(): Promise<ClockPageData> {
  const authz = await requirePermission('time.clock')
  if (!(await isFeatureEnabled(authz.user.orgId, 'fieldTime'))) notFound()
  const t = await getTranslations('timesheets')
  const orgId = authz.user.orgId
  const partyId = await resolveOwnParty(orgId, authz.user.id)
  const day = await myClockDay(orgId, authz.user.id)
  const settings = await loadFieldTimeSettings(orgId)
  const photoOn = await isFeatureEnabled(orgId, 'fieldTimePhoto')
  const photoRequired = photoOn || settings.photoRequired
  let photoFolderId: string | null = null
  if (photoRequired) {
    try {
      photoFolderId = await ensureClockPhotoFolder(orgId, authz.user.id)
    } catch {
      photoFolderId = null
    }
  }
  const projects = (await db.execute<{ id: string; name: string; code: string | null }>(sql`
    select p.id::text as id, p.name, p.code
      from projects p
     where p.org_id = ${orgId} and p.is_active
     order by (select max(te.worked_on) from time_entries te
                where te.org_id = p.org_id and te.project_id = p.id
                  and te.employee_party_id = ${partyId}) desc nulls last,
              p.name
     limit 200`)).rows
  const tasks = (await db.execute<{ id: string; name: string }>(sql`
    select t.id::text as id, t.name from project_tasks t
      join projects p on p.id = t.project_id and p.org_id = t.org_id
     where t.org_id = ${orgId} and p.is_active
     order by t.name limit 500`)).rows
  const projectNames = new Map(projects.map((project) => [project.id, project.name]))
  return {
    title: t('field.title'),
    description: t('field.description'),
    tabs: [
      { href: '/timesheets', label: t('field.timesheetsTab'), active: false },
      { href: '/time/clock', label: t('field.clockTab'), active: true },
      { href: '/time/crew', label: t('field.crewTab'), active: false },
    ],
    clock: {
      clockedIn: day.status.clockedIn,
      since: day.status.since,
      projectId: day.status.projectId,
      projectName: day.status.projectId ? (projectNames.get(day.status.projectId) ?? null) : null,
      costCodeRef: day.status.costCodeRef,
      onBreak: day.status.onBreak,
    },
    projects,
    tasks,
    photoRequired,
    photoFolderId,
    geoHint: t('field.geoHint'),
    clockOutLabel: t('field.clockOut'),
    pairsTitle: t('field.todayTitle'),
    emptyPairs: t('field.noPairs'),
    inLabel: t('field.inLabel'),
    outLabel: t('field.outLabel'),
    projectLabel: t('field.projectLabel'),
    hoursLabel: t('field.hoursLabel'),
    geoLabel: t('field.geoLabel'),
    rows: day.pairs.map((pair) => ({
      id: pair.pairId,
      clockIn: pair.clockInAt,
      clockOut: pair.clockOutAt ?? t('field.open'),
      project: pair.projectName ?? t('field.noProject'),
      costCode: pair.costCodeRef ?? '—',
      hours: pair.entryHours ?? '—',
      geo: pair.geoCheck,
      autoClosed: pair.autoClosed,
    })),
  }
}

export function clockSpec(data: ClockPageData): PageSpec {
  return page({
    route: '/time/clock',
    layout: 'list',
    bodyClassName: 'mx-auto w-full max-w-xl',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actions: [widget('module-home-tabs', { tabs: data.tabs })],
      }),
    ],
    body: [
      widgetBlock('hrm-clock-controls', {
        initial: data.clock,
        projects: data.projects,
        tasks: data.tasks,
        photoRequired: data.photoRequired,
        photoFolderId: data.photoFolderId,
        geoHint: data.geoHint,
        clockOutLabel: data.clockOutLabel,
      }),
      panel({
        title: f('pairsTitle'),
        bodyClassName: 'p-0',
        blocks: [
          table({
            variant: 'app',
            rows: f('rows'),
            rowKey: item('id'),
            columns: [
              column(f('inLabel'), text(item('clockIn'))),
              column(f('outLabel'), text(item('clockOut'))),
              column(f('projectLabel'), text(item('project'))),
              column(f('hoursLabel'), text(item('hours')), {
                align: 'right',
                className: 'tabular-nums',
              }),
              column(f('geoLabel'), badge(item('geo'), { variant: 'secondary' })),
            ],
            empty: { title: f('pairsTitle'), description: f('emptyPairs') },
          }),
        ],
      }),
    ],
  })
}

export async function clockTitle(): Promise<string> {
  const t = await getTranslations('timesheets')
  return t('field.title')
}
