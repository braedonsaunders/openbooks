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
    // The week's header owns the lifecycle: lock it first so a concurrent
    // submission cannot interleave gate creation with this approval, then
    // refuse weeks no approval may consume. The locked status is the audit
    // before-image for the approval evidence written below.
    const header = ((await db.execute<{ id: string; status: string }>(sql`
      select id, status from timesheet_weeks
       where org_id = ${options.orgId}
         and employee_party_id = ${options.employeePartyId}
         and week_start = ${week}::date
       for update
    `)).rows[0])
    // A flow that raised approval gates OWNS the week until they resolve
    // (see the submit route): a direct approval past them would let one
    // approver override the authored routing, quorum, and escalation. Gates
    // name the header as their subject, so a week with no header yet has
    // nothing to own it and the check is vacuous.
    if (header) {
      const openGates = ((await db.execute<{ n: number }>(sql`
        select count(*)::int as n from flow_gates
         where org_id = ${options.orgId}
           and subject_kind = 'timesheet_week'
           and subject_id = ${header.id}
           and status in ('pending', 'escalated')
      `)).rows[0]?.n ?? 0)
      if (openGates > 0) {
        throw new Error('this week is owned by a pending approval workflow — its gates must resolve first')
      }
    }

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

    // The conditional UPDATE is the claim: zero flipped rows means there was
    // nothing submitted to approve (a draft or empty week), and the header
    // must not be stamped approved over it. This also closes the concurrent
    // double-approval race — the loser flips nothing and fails closed.
    if (approved.rows.length === 0) {
      // Zero flips over already-approved entries is a re-approval, not an
      // unsubmitted week: name the prior approval (who/when) and the way
      // back (reopen/amend) instead of misreporting it.
      const prior = ((await db.execute<{ by_name: string | null; by_email: string | null; on: string | null }>(sql`
        select u.name as by_name, u.email as by_email, max(e.approved_at)::date::text as on
          from time_entries e
          left join users u on u.id = e.approved_by
         where e.org_id = ${options.orgId}
           and e.employee_party_id = ${options.employeePartyId}
           and e.worked_on >= ${days[0]}
           and e.worked_on <= ${days[6]}
           and e.status = 'approved'
         group by u.name, u.email
         order by max(e.approved_at) desc
         limit 1
      `)).rows[0])
      if (prior) {
        const who = prior.by_name ?? prior.by_email ?? 'another approver'
        throw new Error(
          `week already approved by ${who}${prior.on ? ` on ${prior.on}` : ''} — reopen or amend the week to change it`,
        )
      }
      throw new Error('no submitted entries to approve — submit the week first')
    }
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
    // Durable approval evidence, part of the same atomic unit: the status
    // flip above throws unless exactly one header row exists for this week,
    // so a header id is known here — prefer the locked row, else read the
    // row the flip just stamped (a concurrent header insert racing our
    // initial read). An audit failure rolls the approval back with it, so an
    // unattributed or unauditable approval of hours that may already have
    // posted labor cost and overhead journals cannot persist.
    const headerId =
      header?.id ??
      ((await db.execute<{ id: string }>(sql`
        select id from timesheet_weeks
         where org_id = ${options.orgId}
           and employee_party_id = ${options.employeePartyId}
           and week_start = ${week}::date
      `)).rows[0]?.id ?? null)
    if (!headerId) throw new Error('timesheet week not found')
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${options.orgId}, 'timesheet_weeks', ${headerId}, 'update', ${JSON.stringify({
        event: 'approved',
        actor: { kind: 'user', userId: options.actorId },
        before: { status: header?.status ?? null },
        after: { status: 'approved' },
        entryIds: ids,
        weekStart: week,
      })}::jsonb, ${options.actorId})
    `)
    return ids
  })
}
