import { applyProductionTimeCorrections } from '@openbooks/engine/src/manufacturing/conversion.ts'
import { lockSharedTimeAuthority, type TimeCommandPermission, type TimeWorkFamily } from '@openbooks/engine/src/projects/time-work-target.ts'
import 'server-only'
import { sql } from 'drizzle-orm'
import { db, withOrgTransaction } from '@openbooks/engine/src/platform/db.ts'
import { lockScopeRow } from '@openbooks/engine/src/organization/subsidiary-scope.ts'
import { laborCostingSettings, setPrevailingWageEntryWage, snapshotLaborCostRates } from '@openbooks/engine/src/projects/labor-costing.ts'
// HR-13: register the prevailing-wage resolver for the snapshot hook —
// the projects module never imports hrm, so the web approval path wires
// the HRM implementation here. With the feature off it returns null and
// every entry keeps the standard wage path.
import { prevailingWageForTimeEntry } from '@openbooks/engine/src/hrm/construction/labor-hook.ts'

setPrevailingWageEntryWage(prevailingWageForTimeEntry)
import { applyOverheadForTime } from '@openbooks/engine/src/allocations/overhead-post.ts'
import { postProjectLaborCost } from '@openbooks/engine/src/projects/recognition.ts'
import { setTimesheetWeekStatus, weekWindow } from '../app/api/timesheets/_lib'
import { snapshotTimeBillRates } from './item-rates'
import { isFeatureEnabled } from './features'
import { TimeApprovalRefusal } from './time-approval-refusal'

export { TimeApprovalRefusal }
export type { TimeApprovalRefusalCode, UncoveredTimeEntry } from './time-approval-refusal'

/** Where the labor-costing policy lives for the wage-rate remedy. */
export const LABOR_COSTING_SETUP_HREF = '/admin/setup/labor-costing'

/** Where the time-approval policy lives for the self-approval remedy. */
export const TIME_APPROVAL_POLICY_SETUP_HREF = '/admin/setup/time-approval-policies'

/** The operator remedy for a self-approval refusal. */
export const SELF_APPROVAL_REMEDY =
  'Ask another approver to approve your time, or have an administrator allow self-approval in Time settings.'

/**
 * Whether the org's time-approval policy prevents self-approval as of a
 * date. Resolution is the latest active row covering the date; an org with
 * no row keeps the safe default — prevention ON — so a sole proprietor
 * opts out explicitly in Time settings instead of inheriting silence.
 */
export async function timeSelfApprovalPrevented(orgId: string, asOf: string): Promise<boolean> {
  const row = (await db.execute<{ prevent: boolean }>(sql`
    select prevent_self_approval as prevent from time_approval_policies
     where org_id = ${orgId} and is_active
       and effective_from <= ${asOf}::date
       and (effective_to is null or effective_to >= ${asOf}::date)
     order by effective_from desc
     limit 1
  `)).rows[0]
  return row?.prevent ?? true
}

/**
 * The actor's own person party in this org, if their login links to one.
 * Null for logins with no person (service and cross-org admin actors) —
 * with no person they can never BE the week's employee, so there is no
 * self-approval to prevent.
 */
export async function actorPersonPartyId(orgId: string, actorId: string): Promise<string | null> {
  return (await db.execute<{ partyId: string | null }>(sql`
    select party_id as "partyId" from users where id = ${actorId} and org_id = ${orgId} for share
  `)).rows[0]?.partyId ?? null
}

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
export async function runTimeApprovalEffects(orgId: string, actorId: string, timeEntryIds: string[], permission: TimeCommandPermission = 'time.approve'): Promise<void> {
  if (timeEntryIds.length === 0) return
  const targets = (await db.execute<{ id: string; project_id: string | null; work_order_id: string | null }>(sql`
    select id,project_id,work_order_id from time_entries where org_id=${orgId} and id=any(${`{${timeEntryIds.join(',')}}`}::uuid[]) for share`)).rows
  if (targets.length !== new Set(timeEntryIds).size) {
    throw new TimeApprovalRefusal(
      'One or more time entries are unavailable. Reload before approving time.',
      'entries_unavailable', 409,
      'Reload the week and try again — an entry changed while the approval was prepared.',
    )
  }
  if (targets.some(row => row.project_id && row.work_order_id)) {
    throw new TimeApprovalRefusal(
      'Time must name one cost object. Split project and production time before approval.',
      'mixed_cost_objects', 422,
      'Split the mixed lines so each names either a project or a production order, then approve again.',
    )
  }
  const productionIds = targets.filter(row => row.work_order_id).map(row => row.id)
  const projectsEnabled = await isFeatureEnabled(orgId, 'projects')
  const projectIds = projectsEnabled ? targets.filter(row => !row.work_order_id).map(row => row.id) : []
  if (productionIds.length && !(await isFeatureEnabled(orgId, 'manufacturing'))) {
    throw new TimeApprovalRefusal(
      'Manufacturing is turned off. Enable it before approving production time.',
      'manufacturing_off', 409,
      'Turn Manufacturing back on in Company Settings → Features, then approve again.',
    )
  }
  if (!projectsEnabled && targets.some(row => row.project_id)) {
    throw new TimeApprovalRefusal(
      'Projects is turned off. Enable it before approving project time.',
      'projects_off', 409,
      'Turn Projects back on in Company Settings → Features, then approve again.',
    )
  }
  if (!projectsEnabled && !productionIds.length) return
  const settings = await laborCostingSettings(orgId)
  await snapshotLaborCostRates(orgId, timeEntryIds, { actorId })
  // The snapshot stamps every entry a wage row covers and skips the rest —
  // its stamped count is not the verdict. An entry still rateless after the
  // snapshot has NO covering wage row: approving it would create approved
  // time without its cost evidence. Refuse by name instead, unless the org
  // explicitly allows unrated time.
  // Every caller runs this inside the approval transaction before stamping
  // the header, so the refusal rolls the entry flips back with it.
  const uncovered = (await db.execute<{ employee_name: string | null; worked_on: string; party_kind: string | null }>(sql`
    select p.display_name as employee_name, te.worked_on::text as worked_on, p.kind as party_kind
      from time_entries te
      left join parties p on p.id = te.employee_party_id and p.org_id = te.org_id
     where te.org_id = ${orgId}
       and te.id = any(${`{${timeEntryIds.join(',')}}`}::uuid[])
       and te.cost_rate is null
     order by p.display_name, te.worked_on
  `)).rows
  if (uncovered.length > 0 && !settings.allowUnratedTime) {
    const shown = uncovered.slice(0, 10).map((row) => `${row.employee_name ?? 'unknown employee'} on ${row.worked_on}`)
    const more = uncovered.length > shown.length ? `, and ${uncovered.length - shown.length} more` : ''
    // Partners and owners keep time as people, never as employments: their
    // remedy names the cost rate, never an employment or compensation
    // record. Employees keep the wage-row remedy.
    const personOnly = uncovered.every((row) => row.party_kind === 'person')
    const remedy = personOnly
      ? 'Add a cost rate for them in Labor costing setup — they need no employment or compensation record — or allow unrated time.'
      : 'Add a wage row covering those dates in Labor costing setup, or allow unrated time.'
    throw new TimeApprovalRefusal(
      `cannot approve ${uncovered.length === 1 ? 'a time entry' : `${uncovered.length} time entries`} with no covering cost rate: ${shown.join('; ')}${more} — ${remedy}`,
      'no_covering_wage_rate', 422,
      remedy,
      {
        uncovered: uncovered.map((row) => ({ employeeName: row.employee_name, workedOn: row.worked_on })),
        setupHref: LABOR_COSTING_SETUP_HREF,
      },
    )
  }
  if (productionIds.length) await applyProductionTimeCorrections(db,orgId,actorId,productionIds,permission)
  // Production captures payroll evidence here; its released operation owns absorption into WIP.
  // Project posting and billing receive only project-side entries, so the same hours cannot be charged twice.
  if (projectIds.length) {
    await snapshotTimeBillRates(orgId, projectIds)
    if (settings.mode === 'post') await postProjectLaborCost(orgId, actorId, projectIds)
    await applyOverheadForTime(orgId, actorId, projectIds)
  }
}

export interface ApproveSubmittedTimeEntriesOptions {
  orgId: string
  actorId: string
  employeePartyId: string
  weekStart: string
  workFamily?: TimeWorkFamily
  allowedSubsidiaryIds: ReadonlySet<string> | null
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
    await lockSharedTimeAuthority(db, options.orgId, options.actorId, { employeeId: options.employeePartyId, from: days[0]!, through: days[6]!, requestedScope: options.allowedSubsidiaryIds, permission: "time.approve", workFamily: options.workFamily })
    // Parties precede their dependent week headers in the canonical lock
    // order. The route's preliminary pin can go stale while this transaction
    // starts, so recheck the employee's current scope under a shared lock and
    // hold it through costing and posting.
    await lockScopeRow(
      db,
      options.orgId,
      'party',
      options.employeePartyId,
      options.allowedSubsidiaryIds,
      'share',
    )
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
        throw new TimeApprovalRefusal(
          'this week is owned by a pending approval workflow — its gates must resolve first',
          'week_owned_by_workflow', 409,
          'Decide the week through its approval flow instead of approving it directly.',
        )
      }
    }
    // Separation of duties on the direct path: the actor whose person party
    // owns the week cannot approve it while the org's time-approval policy
    // prevents self-approval (the default). Flow-gated weeks never reach
    // here — the gate excludes the submitter at creation — so this guards
    // direct, bulk and inbox-direct approvals alike. "Entered by" is not
    // authorship: a bookkeeper entering a coworker's sheet never matches
    // the employee check, so assisting entry stays allowed.
    if (await timeSelfApprovalPrevented(options.orgId, week)) {
      const own = await actorPersonPartyId(options.orgId, options.actorId)
      if (own !== null && own === options.employeePartyId) {
        throw new TimeApprovalRefusal(
          'you cannot approve your own timesheet — another approver must approve your time',
          'self_approval_prevented', 422,
          SELF_APPROVAL_REMEDY,
          { setupHref: TIME_APPROVAL_POLICY_SETUP_HREF },
        )
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
    // A week declared as having no hours (leave, no work) is submitted with
    // no entries at all: approving it approves the declaration — the header
    // is stamped and audited, and there is no time to cost.
    const declaredNoHours = approved.rows.length === 0 && header?.status === 'submitted' && ((await db.execute<{ n: number }>(sql`
      select count(*)::int as n from time_entries
       where org_id = ${options.orgId} and employee_party_id = ${options.employeePartyId}
         and worked_on >= ${days[0]} and worked_on <= ${days[6]}
    `)).rows[0]?.n ?? 0) === 0
    if (approved.rows.length === 0 && !declaredNoHours) {
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
        throw new TimeApprovalRefusal(
          `week already approved by ${who}${prior.on ? ` on ${prior.on}` : ''} — reopen or amend the week to change it`,
          'already_approved', 409,
          'Reopen or amend the week to change approved hours.',
          { approvedBy: who, approvedOn: prior.on ?? null },
        )
      }
      throw new TimeApprovalRefusal(
        'no submitted entries to approve — submit the week first',
        'nothing_submitted', 422,
        'Submit the week before approving it.',
      )
    }
    const ids = approved.rows.map((row) => row.id)
    if (ids.length > 0) await runTimeApprovalEffects(options.orgId, options.actorId, ids)
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
