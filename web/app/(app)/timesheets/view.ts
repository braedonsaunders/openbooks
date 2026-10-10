import { withOrgTransaction } from '@openbooks/engine/src/platform/db.ts'
import { lockSharedTimeAuthority, type TimeWorkFamily } from '@openbooks/engine/src/projects/time-work-target.ts'
import 'server-only'

import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { page, pageHeader, ref, widget, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { can, getAuthz, requirePermission } from '../../../lib/authz'
import { ownTimeOnly, supervisesTime as supervisesTimeCommand, timeCommandGrants } from '../../../lib/time-workspace'
import { isFeatureEnabled } from '../../../lib/features'
import { requireFeatureEnabled } from '../../../lib/feature-gates'
import { isUuid, pickString } from '../../../lib/list-params'
import { loadFieldDefs } from '../../../lib/custom-fields'
import { loadOpenFlagsForWeek, type WeekFlagChip } from '../../../lib/hrm/ai-rails'
import { loadTimePolicy } from '../../../lib/time-policy'
// HR-20: approver flag chips over the week's clock pairs.
import { approvalFlags } from '@openbooks/engine/src/hrm/field-time/reads.ts'
import { subsidiaryVisibleFilter } from '../../../lib/subsidiaries'
import {
  currentWeekStart,
  isIsoDate,
  loadPickers,
  loadWeek,
  pinTimekeeper,
  userEmployeeId,
  weekStart,
  weekWindow,
} from '../../api/timesheets/_lib'
import type { WeeklyGrid } from './WeeklyGrid'
import { managesOthersTime, resolveNewTimesheetStart } from './new-timesheet'

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
  workFamily: TimeWorkFamily
  basePath: string
  description: string
  canManage: boolean
  /** True when New timesheet has a week it may open for this user. */
  canStartTimesheet: boolean
  /** Why New timesheet is withdrawn for a time enterer, with the remedy. */
  newNotice: string | null
  currentParams: Record<string, string | string[] | undefined>
  newButton: { href: string; label: string }
  drawer: (Record<string, unknown> & { remountKey: string }) | null
  // HR-20: field-time nav under Timesheets — office orgs never see these.
  showClockLink: boolean
  clockButton: { href: string; label: string }
  showCrewLink: boolean
  crewButton: { href: string; label: string }
}

export async function loadTimesheets(
  sp: Record<string, string | string[] | undefined>,
  workFamily: TimeWorkFamily = 'project',
): Promise<TimesheetsData> {
  const t = await getTranslations('timesheets')

  // Supervisors read everyone's weeks (time.read, or time.manage which
  // implies it). A caller holding only an own-scope grant sees the weeks of
  // the person linked to their own login: time.self also enters and
  // submits them, time.clock reads them. The list, the drawer, the pickers
  // and every timesheet API (through the shared time authority) agree, and
  // the grants come from the declared permission implications.
  const viewer = await getAuthz()
  const selfOnly = !!viewer && ownTimeOnly(viewer, 'time.read')
  const readGrants = timeCommandGrants('time.read')
  const heldReadGrant = viewer
    ? (selfOnly ? readGrants.own : readGrants.all).find((grant) => can(viewer, grant)) ?? 'time.read'
    : 'time.read'
  const authz = await requirePermission(heldReadGrant)
  await requireFeatureEnabled(authz.user.orgId, workFamily === 'production' ? 'manufacturing' : 'timeTracking')
  if (workFamily === 'production') await requirePermission('manufacturing.read')
  const basePath = workFamily === 'production' ? '/manufacturing/time' : '/timesheets'
  const orgId = authz.user.orgId
  const ownEmployeeId = await userEmployeeId(orgId, authz.user.id)
  const productionAvailable = can(authz,'manufacturing.read') && await isFeatureEnabled(authz.user.orgId,'manufacturing')
  // A person's own week books to the projects in their scope without the
  // project-read grant; reading other people's project time still needs it.
  // The project dimension shows only while Projects is on — Time Tracking
  // stands alone, and writes naming a project refuse while it is off.
  const projectAvailable = (can(authz,'projects.read') || selfOnly) && await isFeatureEnabled(authz.user.orgId,'projects')
  const supervisesTime = supervisesTimeCommand(authz, 'time.manage')
  const entersOwnTime = ownTimeOnly(authz, 'time.manage')
  const canManage = supervisesTime || entersOwnTime

  // Timekeeper filter — the same person-or-employed set the editor uses.
  const employees = (await db.execute<{ id: string; name: string | null }>(sql`
    select p.id, p.display_name as name
         from parties p
         where p.org_id = ${orgId} and p.is_active
           ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, authz.allowedSubsidiaryIds)}
           ${selfOnly ? sql`and p.id = ${ownEmployeeId}` : sql``}
           and p.kind in ('person', 'employee')
           and (p.kind = 'person' or exists (select 1 from employee_roles r where r.party_id = p.id and r.org_id = p.org_id and r.is_active))
         order by p.display_name`))

  // "New timesheet" opens the current user's own week when the login is
  // linked to an in-scope employee. Only someone who manages other people's
  // time may instead start from the first active employee as a picker seed;
  // a self-service login is never handed another person's timesheet. When
  // there is nothing to open, the action is withdrawn and the page names the
  // reason and its remedy instead of linking back to itself.
  const timesheetStart = await resolveNewTimesheetStart({
    canManage,
    managesOthersTime: managesOthersTime((permission) => can(authz, permission)),
    linkedEmployeeId: ownEmployeeId,
    pinInScope: (employeeId) => pinTimekeeper(orgId, employeeId, authz.allowedSubsidiaryIds),
    firstActiveEmployeeId: employees.rows[0]?.id ?? null,
  })
  const newHref = timesheetStart.employeeId
    ? (`${basePath}?timesheet=${timesheetStart.employeeId}:${await currentWeekStart(orgId)}` as const)
    : basePath
  const newNotice = timesheetStart.refusal ? t(`list.newRefusal.${timesheetStart.refusal}`) : null

  // Flyout: ?timesheet=<employeeId>:<weekStart>, the id the list emits.
  const openParam = pickString(sp.timesheet)
  const [openEmployee, openWeekRaw] = openParam ? openParam.split(':') : []
  const requestedEmployeeId = openEmployee && isUuid(openEmployee) ? openEmployee : null
  // A self-service caller never opens a coworker's week: the drawer stays
  // closed and the page names the rule instead.
  const othersWeekRefused = selfOnly && requestedEmployeeId !== null && requestedEmployeeId !== ownEmployeeId
  const openEmployeeId = requestedEmployeeId && !othersWeekRefused
    ? await pinTimekeeper(orgId, requestedEmployeeId, authz.allowedSubsidiaryIds)
    : null
  const openWeek = openWeekRaw && isIsoDate(openWeekRaw) ? weekStart(openWeekRaw) : null
  if (openEmployeeId && openWeek) {
    const days = weekWindow(openWeek)
    await withOrgTransaction(orgId, () => lockSharedTimeAuthority(db,orgId,authz.user.id,{ employeeId:openEmployeeId,from:days[0]!,through:days[6]!,requestedScope:authz.allowedSubsidiaryIds,permission:'time.read',workFamily }))
  }
  const [pickers, weekPayload, lineFieldDefs] = openEmployeeId && openWeek
    ? await Promise.all([
        loadPickers(orgId, openEmployeeId, authz.allowedSubsidiaryIds).then((loaded) => selfOnly
          ? { ...loaded, employees: loaded.employees.filter((option) => option.value === ownEmployeeId) }
          : loaded),
        loadWeek(orgId, openEmployeeId, openWeek, authz.allowedSubsidiaryIds),
        loadFieldDefs('time_entries'),
      ])
    : [null, null, []]
  const timePolicy = await loadTimePolicy(orgId)
  const requestedReturn = pickString(sp.drawerReturn)
  const closeHref = requestedReturn?.startsWith(basePath + '?') || requestedReturn === basePath ? requestedReturn : basePath

  // The grid props are checked against the component here so a prop rename
  // fails in this file; the registry spreads the rest through untouched.
  // (`fieldDefs` keeps the native `as never`: server defs and client defs
  // are the same object at runtime.)
  // Field flags for the drawer — geo/photo/auto-close chips over
  // the week's clock pairs. Coordinates stay out; the drawer shows flags.
  // No .catch here: a failed flags query must fail the page, not quietly
  // render a drawer with no chips — that swallow hid a hard 42803 SQL
  // error behind "no flags" for weeks.
  const fieldTimeOnEarly = workFamily === 'project' && await isFeatureEnabled(orgId, 'fieldTime')
  const fieldFlags =
    fieldTimeOnEarly && openEmployeeId && openWeek
      ? await approvalFlags(orgId, { weekStart: openWeek, employeePartyId: openEmployeeId })
      : []
  // Open anomaly flags overlapping this week ride into the grid as
  // approval chips. Empty while the actor lacks the flag read scope — the
  // grid renders unchanged.
  let anomalyFlags: WeekFlagChip[] = []
  if (openEmployeeId && openWeek) {
    const weekEnd = new Date(`${openWeek}T00:00:00Z`)
    weekEnd.setUTCDate(weekEnd.getUTCDate() + 6)
    anomalyFlags = await loadOpenFlagsForWeek(authz, openEmployeeId, openWeek, weekEnd.toISOString().slice(0, 10))
  }
  const gridProps =
    pickers && weekPayload && openEmployeeId && openWeek
      ? {
          employeeId: openEmployeeId,
          workFamily,
          quickProjectId: projectAvailable && isUuid(pickString(sp.job) ?? '') && pickers.projects.some(project=>project.value===pickString(sp.job)) ? pickString(sp.job) : undefined,
          productionAvailable,
          projectAvailable,
          week: openWeek,
          payload: weekPayload,
          pickers: projectAvailable ? pickers : { ...pickers, projects: [] },
          // Entering a week: anyone's with time.manage, one's own with time.self.
          canManage: supervisesTime || (entersOwnTime && openEmployeeId === ownEmployeeId),
          canApprove: can(authz, 'time.approve'),
          canReopen: can(authz, 'time.reopen'),
          requireApproval: timePolicy.requireApproval,
          fieldDefs: lineFieldDefs as never,
          closeHref,
          fieldFlags,
          anomalyFlags,
        } satisfies WeeklyGridProps
      : null

  const fieldTimeOn = fieldTimeOnEarly

  return {
    workFamily,
    basePath,
    // Production time is Manufacturing's view of the same weekly time; it
    // names itself as such instead of borrowing the project timesheet title.
    title: workFamily === 'production' ? t('list.productionTitle') : t('list.title'),
    description: workFamily === 'production' ? t('list.productionDescription') : t('list.description'),
    canManage,
    canStartTimesheet: timesheetStart.employeeId !== null,
    newNotice: othersWeekRefused ? t('list.selfOnly') : newNotice,
    currentParams: sp,
    newButton: { href: newHref, label: t('list.newButton') },
    showClockLink: fieldTimeOn && can(authz, 'time.clock'),
    clockButton: { href: '/time/clock', label: t('field.clockTab') },
    showCrewLink: fieldTimeOn && (can(authz, 'time.crew.enter') || can(authz, 'time.read')),
    crewButton: { href: '/time/crew', label: t('field.crewTab') },
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
    route: data.basePath,
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        // HR-20: field-time nav rides the header behind its own switches.
        actions: [
          widget(newTimesheet.widget, newTimesheet.props, f('canStartTimesheet')),
          widget('link-button', { href: f('clockButton.href'), label: f('clockButton.label'), variant: 'outline' }, f('showClockLink')),
          widget('link-button', { href: f('crewButton.href'), label: f('crewButton.label'), variant: 'outline' }, f('showCrewLink')),
        ],
      }),
    ],
    body: [
      widgetBlock('page-notice', { message: data.newNotice ?? '' }, f('newNotice')),
      widgetBlock('entity-list-view', {
        recordType: 'timesheet_week',
        timeWorkFamily: data.workFamily,
        sp: data.currentParams,
        emptyAction: data.canStartTimesheet ? newTimesheet : null,
        drawer: data.drawer ? [{ widget: 'timesheet-drawer', props: { drawer: data.drawer } }] : [],
      }),
    ],
  })
}
