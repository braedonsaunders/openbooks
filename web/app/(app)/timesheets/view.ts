import 'server-only'

import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { page, pageHeader, ref, widget, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { can, requirePermission } from '../../../lib/authz'
import { requireFeatureEnabled } from '../../../lib/feature-gates'
import { isUuid, pickString } from '../../../lib/list-params'
import { loadFieldDefs } from '../../../lib/custom-fields'
import { loadTimePolicy } from '../../../lib/time-policy'
import {
  currentWeekStart,
  isIsoDate,
  loadPickers,
  loadWeek,
  pinTimesheetEmployee,
  userEmployeeId,
  weekStart,
} from '../../api/timesheets/_lib'
import type { WeeklyGrid } from './WeeklyGrid'

/**
 * The weekly-timesheet list, split into a loader and a spec.
 *
 * Almost all of the page is the universal entity list over the
 * `timesheet_week` aggregate; what is page-specific is the drawer SLOT, which
 * the native page fills with the WeeklyGrid editor, and the "New timesheet"
 * link, whose href the loader computes from the user's linked employee (or
 * the first active employee) and the current week. A spec cannot express a
 * link target it must compute, so href and label travel as widget props and
 * the host renders the anchor — the same indirection the empty state already
 * uses for its action.
 *
 * The drawer keeps its remount key. The native page passes
 * `key={employeeId:week}` so switching employees or weeks resets grid state,
 * and a widget placed at a fixed position would otherwise reuse the mounted
 * component. The key rides along as a prop and the registry applies it.
 */

type WeeklyGridProps = Parameters<typeof WeeklyGrid>[0]

export interface TimesheetsData {
  title: string
  description: string
  canManage: boolean
  currentParams: Record<string, string | string[] | undefined>
  newButton: { href: string; label: string }
  drawer: (Record<string, unknown> & { remountKey: string }) | null
}

export async function loadTimesheets(
  sp: Record<string, string | string[] | undefined>,
): Promise<TimesheetsData> {
  const t = await getTranslations('timesheets')

  const authz = await requirePermission('time.read')
  await requireFeatureEnabled(authz.user.orgId, 'timeTracking')
  const canManage = can(authz, 'time.manage')
  const orgId = authz.user.orgId

  // Employee filter — the same active-employee set the editor uses.
  const employees = (await db.execute<{ id: string; name: string | null }>(sql`
    select p.id, p.display_name as name
      from parties p
     where p.org_id = ${orgId} and p.is_active
       and exists (select 1 from employee_roles r where r.party_id = p.id and r.org_id = p.org_id and r.is_active)
     order by p.display_name`))

  // "New timesheet" targets the current user's linked employee (or the first
  // active employee as a fallback picker seed) and the current week.
  const myEmployee = canManage ? await userEmployeeId(orgId, authz.user.id) : null
  const newTarget = myEmployee ?? employees.rows[0]?.id ?? null
  const newHref = newTarget
    ? (`/timesheets?timesheet=${newTarget}:${await currentWeekStart(orgId)}` as const)
    : ('/timesheets' as const)

  // Flyout: ?timesheet=<employeeId>:<weekStart>, the id the list emits.
  const openParam = pickString(sp.timesheet)
  const [openEmployee, openWeekRaw] = openParam ? openParam.split(':') : []
  const requestedEmployeeId = openEmployee && isUuid(openEmployee) ? openEmployee : null
  const openEmployeeId = requestedEmployeeId
    ? await pinTimesheetEmployee(orgId, requestedEmployeeId)
    : null
  const openWeek = openWeekRaw && isIsoDate(openWeekRaw) ? weekStart(openWeekRaw) : null
  const [pickers, weekPayload, lineFieldDefs] = openEmployeeId && openWeek
    ? await Promise.all([
        loadPickers(orgId, openEmployeeId),
        loadWeek(orgId, openEmployeeId, openWeek),
        loadFieldDefs('time_entries'),
      ])
    : [null, null, []]
  const timePolicy = await loadTimePolicy(orgId)
  const requestedReturn = pickString(sp.drawerReturn)
  const closeHref = requestedReturn?.startsWith('/timesheets') ? requestedReturn : '/timesheets'

  // The grid props are checked against the component here so a prop rename
  // fails in this file; the registry spreads the rest through untouched.
  // (`fieldDefs` keeps the native `as never`: server defs and client defs
  // are the same object at runtime.)
  const gridProps =
    pickers && weekPayload && openEmployeeId && openWeek
      ? {
          employeeId: openEmployeeId,
          week: openWeek,
          payload: weekPayload,
          pickers,
          canManage,
          canApprove: can(authz, 'time.approve'),
          canReopen: can(authz, 'time.reopen'),
          requireApproval: timePolicy.requireApproval,
          fieldDefs: lineFieldDefs as never,
          closeHref,
        } satisfies WeeklyGridProps
      : null

  return {
    title: t('list.title'),
    description: t('list.description'),
    canManage,
    currentParams: sp,
    newButton: { href: newHref, label: t('list.newButton') },
    drawer: gridProps
      ? {
          // Remount on identity change so no state can outlive its week.
          remountKey: `${openEmployeeId}:${openWeek}`,
          ...gridProps,
        }
      : null,
  }
}

const f = ref<TimesheetsData>()

export function timesheetsSpec(data: TimesheetsData): PageSpec {
  const newTimesheet = { widget: 'new-timesheet', props: data.newButton }
  return page({
    route: '/timesheets',
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actions: [widget(newTimesheet.widget, newTimesheet.props, f('canManage'))],
      }),
    ],
    body: [
      widgetBlock('entity-list-view', {
        recordType: 'timesheet_week',
        sp: data.currentParams,
        emptyAction: data.canManage ? newTimesheet : null,
        drawer: data.drawer ? [{ widget: 'timesheet-drawer', props: { drawer: data.drawer } }] : [],
      }),
    ],
  })
}
