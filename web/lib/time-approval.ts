import 'server-only'
import { sql } from 'drizzle-orm'
import { db, withOrgTransaction } from '@openbooks/engine/src/db.ts'
import { laborCostingSettings, snapshotLaborCostRates } from '@openbooks/engine/src/labor-costing.ts'
import { applyOverheadForTime } from '@openbooks/engine/src/overhead-apply.ts'
import { postProjectLaborCost } from '@openbooks/engine/src/project-recognition.ts'
import { setTimesheetWeekStatus, weekWindow } from '../app/api/timesheets/_lib'
import { snapshotTimeBillRates } from './item-rates'
import { isFeatureEnabled } from './features'

/**
 * The ONE set of side-effects that fire when time becomes approved — shared by
 * the personal weekly timesheet approval and field-ticket approval so hours
 * are costed identically no matter how they were captured:
 *   1. cost-rate snapshot (wage × time-type multiplier + estimate components)
 *   2. bill-rate snapshot (rate books, per-time-type tiers)
 *   3. standard labor posting (DR labor WIP / CR clearing) when mode is on
 *   4. the overhead net-zero pair (rides with the hours)
 * Everything is inert-until-configured. Callers must run the status transition
 * and these effects in one transaction and fail closed: approved time may not
 * exist without the rate/cost/GL evidence its configured policy requires.
 */
export async function runTimeApprovalEffects(orgId: string, actorId: string, timeEntryIds: string[]): Promise<void> {
  if (timeEntryIds.length === 0) return
  if (!(await isFeatureEnabled(orgId, 'projects'))) return
  const settings = await laborCostingSettings(orgId)
  await snapshotLaborCostRates(orgId, timeEntryIds)
  await snapshotTimeBillRates(orgId, timeEntryIds)
  if (settings.mode === 'post') await postProjectLaborCost(orgId, actorId, timeEntryIds)
  await applyOverheadForTime(orgId, actorId, timeEntryIds)
}

export interface ApproveSubmittedTimeEntriesOptions {
  orgId: string
  actorId: string
  employeePartyId: string
  weekStart: string
}

/**
 * Approve one submitted week and materialize every configured accounting
 * effect as one tenant-scoped unit. The week header is the final write inside
 * the same transaction: any snapshot, posting, or header failure rolls every
 * approval write back together.
 *
 * `withOrgTransaction` participates in an ambient tenant transaction, so a
 * flow-gate release keeps this work inside the gate decision's pinned unit
 * while a direct API call gets the same request-sized boundary.
 */
export async function approveSubmittedTimeEntries(
  options: ApproveSubmittedTimeEntriesOptions,
): Promise<string[]> {
  const days = weekWindow(options.weekStart)
  const week = days[0]!
  return withOrgTransaction(options.orgId, async () => {
    const approved = (await db.execute<{ id: string }>(sql`
      update time_entries
         set status = 'approved',
             approved_by = ${options.actorId},
             approved_at = now(),
             updated_at = now(),
             updated_by = ${options.actorId}
       where org_id = ${options.orgId}
         and employee_party_id = ${options.employeePartyId}
         and worked_on >= ${days[0]}
         and worked_on <= ${days[6]}
         and status = 'submitted'
       returning id
    `))

    const ids = approved.rows.map((row) => row.id)
    await runTimeApprovalEffects(options.orgId, options.actorId, ids)
    await setTimesheetWeekStatus(
      options.orgId,
      options.employeePartyId,
      week,
      'approved',
      options.actorId,
      null,
    )
    return ids
  })
}
