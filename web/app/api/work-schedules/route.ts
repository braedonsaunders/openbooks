import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { loadWorkSchedules } from '@openbooks/engine/src/work-schedules.ts'
import { guardFeaturePermission } from '../../../lib/feature-gates'
import { isUuid } from '../../../lib/list-params'
import { parseCycleDays } from '../../../lib/work-schedule-days'
import { isIsoCalendarDate } from '@openbooks/engine/src/business-date.ts'

export const dynamic = 'force-dynamic'

/**
 * Work schedules — the hours and days an employee is normally scheduled to
 * work. One route for the whole surface:
 *
 *   GET                       every schedule, with its cycle days, plus the
 *                             scope options the editor offers.
 *   POST { action:'save' }    create or replace one schedule and ITS DAYS, in
 *                             a single transaction — a parent whose day rows
 *                             half-applied would be a pattern nobody wrote.
 *   POST { action:'delete' }
 *
 * Not a generic setup-registry entity, deliberately: the registry does
 * single-table CRUD, and a pattern is a parent plus a repeating list of hours
 * that must be written together. See engine/src/work-schedules.ts for the
 * model.
 *
 * Scheduled hours are ordinary workforce configuration rather than confidential
 * pay data, but they DECIDE a day's holiday pay in several jurisdictions, so
 * they are gated on admin.setup.manage exactly as wages are.
 */

const MAX_CYCLE_DAYS = 366

const bad = (error: string) => NextResponse.json({ error }, { status: 422 })

/** The one scope key a row may carry, or null for the organization default.
 *  Mirrors labor_cost_rates: zero or one, never two. */
function readScope(body: Record<string, unknown>) {
  const employeePartyId = isUuid(String(body.employeePartyId ?? '')) ? String(body.employeePartyId) : null
  const tradeId = isUuid(String(body.tradeId ?? '')) ? String(body.tradeId) : null
  const departmentId = isUuid(String(body.departmentId ?? '')) ? String(body.departmentId) : null
  const subsidiaryId = isUuid(String(body.subsidiaryId ?? '')) ? String(body.subsidiaryId) : null
  const jobTitle = typeof body.jobTitle === 'string' && body.jobTitle.trim()
    ? body.jobTitle.trim().slice(0, 120)
    : null
  const set = [employeePartyId, jobTitle, tradeId, departmentId, subsidiaryId].filter(Boolean)
  return { employeePartyId, jobTitle, tradeId, departmentId, subsidiaryId, count: set.length }
}

export async function GET() {
  const gate = await guardFeaturePermission('admin.setup.manage', 'payroll')
  if (gate instanceof NextResponse) return gate
  const orgId = gate.user.orgId

  const [schedules, employees, trades, departments, subsidiaries] = await Promise.all([
    loadWorkSchedules(db, orgId),
    db.execute<{ id: string; name: string }>(sql`
      select p.id, p.display_name as name
        from employee_roles er
        join parties p on p.id = er.party_id and p.org_id = er.org_id
       where er.org_id = ${orgId}
       order by p.display_name`),
    db.execute<{ id: string; name: string }>(sql`
      select id, name from trades where org_id = ${orgId} order by name`),
    db.execute<{ id: string; name: string }>(sql`
      select id, name from departments where org_id = ${orgId} order by name`),
    db.execute<{ id: string; name: string }>(sql`
      select id, name from subsidiaries where org_id = ${orgId} order by name`),
  ])

  return NextResponse.json({
    schedules,
    options: {
      employees: employees.rows,
      trades: trades.rows,
      departments: departments.rows,
      subsidiaries: subsidiaries.rows,
    },
  })
}

export async function POST(request: Request) {
  const gate = await guardFeaturePermission('admin.setup.manage', 'payroll')
  if (gate instanceof NextResponse) return gate
  const orgId = gate.user.orgId
  const actorId = gate.user.id

  const parsedBody = await parseJsonBody(request, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as Record<string, unknown>
  const action = String(body.action ?? '')

  if (action === 'delete') {
    if (!isUuid(String(body.id ?? ''))) return bad('a schedule id is required')
    const id = String(body.id)
    // Snapshot the pattern and its days first: they decide holiday pay, and a
    // bare delete leaves no trace of what an absent employee was owed.
    await db.transaction(async (tx) => {
      const existing = (await tx.execute(sql`
        select * from work_schedules where org_id = ${orgId} and id = ${id}`)
      ).rows[0] as Record<string, unknown> | undefined
      if (!existing) return
      const days = (await tx.execute(sql`
        select * from work_schedule_days where org_id = ${orgId} and schedule_id = ${id} order by day_index`)
      ).rows
      // work_schedule_days cascades on the FK, so the pattern never outlives
      // the schedule it describes.
      await tx.execute(sql`
        delete from work_schedules where org_id = ${orgId} and id = ${id}`)
      await tx.execute(sql`
        insert into audit_log
          (org_id, table_name, row_id, action, changes, actor_id)
        values
          (${orgId}, 'work_schedules', ${id}, 'delete',
           ${JSON.stringify({ before: { ...existing, days } })}::jsonb,
           ${actorId})
      `)
    })
    return NextResponse.json({ ok: true })
  }

  if (action !== 'save') return bad(`unknown action "${action}"`)

  const scope = readScope(body)
  if (scope.count > 1) {
    return bad('a work schedule applies to exactly one scope — an employee, a job title, a trade, '
      + 'a department, a subsidiary, or the organization. Choose one')
  }

  // All three dates land in date columns and the save maps any failure to a
  // conflict message, so a shape-valid non-day would surface the raw driver
  // failure. Refuse anything that is not a real calendar day up front.
  const effectiveFrom = String(body.effectiveFrom ?? '')
  if (!isIsoCalendarDate(effectiveFrom)) return bad('a start date is required')
  const effectiveToRaw = body.effectiveTo === undefined || body.effectiveTo === null || body.effectiveTo === '' ? null : String(body.effectiveTo)
  if (effectiveToRaw !== null && !isIsoCalendarDate(effectiveToRaw)) return bad('the end date must be a real calendar date (YYYY-MM-DD)')
  const effectiveTo = effectiveToRaw
  if (effectiveTo && effectiveTo < effectiveFrom) {
    return bad('the end date cannot precede the start date')
  }

  const pattern = body.pattern === 'varies' ? 'varies' : 'cycle'
  let cycleDays: number | null = null
  let cycleAnchor: string | null = null
  const days: { dayIndex: number; hours: string }[] = []

  if (pattern === 'cycle') {
    cycleDays = Number(body.cycleDays)
    if (!Number.isInteger(cycleDays) || cycleDays < 1 || cycleDays > MAX_CYCLE_DAYS) {
      return bad(`the cycle must be between 1 and ${MAX_CYCLE_DAYS} days long`)
    }
    cycleAnchor = String(body.cycleAnchor ?? '')
    if (!isIsoCalendarDate(cycleAnchor)) return bad('the cycle needs a first day to count from')
    const supplied = Array.isArray(body.days) ? body.days : []
    // A row the server cannot place refuses the save: silently dropping a
    // day would store a pattern nobody wrote, and it would go on paying
    // somebody.
    try {
      days.push(...parseCycleDays(supplied, cycleDays).days)
    } catch (error) {
      return bad(error instanceof Error ? error.message : 'invalid days')
    }
    if (days.length === 0) {
      return bad('a work schedule must have at least one working day. If the employee has no '
        + 'regular schedule, record that their hours vary instead — the two are different facts '
        + 'and several jurisdictions pay them differently')
    }
  }

  const id = isUuid(String(body.id ?? '')) ? String(body.id) : null
  const name = typeof body.name === 'string' && body.name.trim()
    ? body.name.trim().slice(0, 120)
    : null
  const notes = typeof body.notes === 'string' ? body.notes.trim().slice(0, 2000) || null : null
  const isActive = body.isActive !== false

  // Parent and days in ONE transaction: a schedule whose day rows half-applied
  // would be a pattern nobody wrote, and it would go on paying somebody. The
  // audit row lands in the same transaction so it never describes a state that
  // did not commit.
  const saved = await db.transaction(async (tx) => {
    let scheduleId = id
    let before: Record<string, unknown> | null = null
    let afterRow: Record<string, unknown>
    if (scheduleId) {
      const existing = (await tx.execute(sql`
        select * from work_schedules where org_id = ${orgId} and id = ${scheduleId}`)
      ).rows[0] as Record<string, unknown> | undefined
      if (!existing) throw new Error('that work schedule no longer exists')
      const beforeDays = (await tx.execute(sql`
        select * from work_schedule_days where org_id = ${orgId} and schedule_id = ${scheduleId} order by day_index`)
      ).rows
      const updated = (await tx.execute<Record<string, unknown>>(sql`
        update work_schedules
           set name = ${name}, employee_party_id = ${scope.employeePartyId},
               job_title = ${scope.jobTitle}, trade_id = ${scope.tradeId},
               department_id = ${scope.departmentId}, subsidiary_id = ${scope.subsidiaryId},
               pattern = ${pattern}, cycle_days = ${cycleDays}, cycle_anchor = ${cycleAnchor},
               effective_from = ${effectiveFrom}, effective_to = ${effectiveTo},
               notes = ${notes}, is_active = ${isActive},
               updated_at = now(), updated_by = ${actorId}
         where org_id = ${orgId} and id = ${scheduleId}
         returning *`))
      before = { ...existing, days: beforeDays }
      scheduleId = updated.rows[0]!.id as string
      afterRow = updated.rows[0]!
      await tx.execute(sql`
        delete from work_schedule_days where org_id = ${orgId} and schedule_id = ${scheduleId}`)
    } else {
      const inserted = (await tx.execute<Record<string, unknown>>(sql`
        insert into work_schedules (org_id, name, employee_party_id, job_title, trade_id,
                                    department_id, subsidiary_id, pattern, cycle_days, cycle_anchor,
                                    effective_from, effective_to, notes, is_active,
                                    created_by, updated_by)
        values (${orgId}, ${name}, ${scope.employeePartyId}, ${scope.jobTitle}, ${scope.tradeId},
                ${scope.departmentId}, ${scope.subsidiaryId}, ${pattern}, ${cycleDays},
                ${cycleAnchor}, ${effectiveFrom}, ${effectiveTo}, ${notes}, ${isActive},
                ${actorId}, ${actorId})
        returning *`))
      scheduleId = inserted.rows[0]!.id as string
      afterRow = inserted.rows[0]!
    }
    const afterDays: Record<string, unknown>[] = []
    for (const day of days) {
      const dayRow = (await tx.execute<Record<string, unknown>>(sql`
        insert into work_schedule_days (org_id, schedule_id, day_index, hours, created_by, updated_by)
        values (${orgId}, ${scheduleId}, ${day.dayIndex}, ${day.hours}, ${actorId}, ${actorId})
        returning *`))
      afterDays.push(dayRow.rows[0]!)
    }
    const after = { ...afterRow, days: afterDays }
    await tx.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id)
      values
        (${orgId}, 'work_schedules', ${scheduleId}, ${before ? 'update' : 'insert'},
         ${JSON.stringify(before ? { before, after } : { after })}::jsonb,
         ${actorId})
    `)
    return scheduleId
  }).catch((error: unknown) => {
    const message = (error as Error).message
    // The one-row-per-scope-per-start-date index, surfaced as the sentence an
    // operator can act on rather than a constraint name.
    if (/work_schedules_scope_from/.test(message)) {
      return { conflict: 'a work schedule for this scope already starts on that date' }
    }
    return { conflict: message }
  })

  if (typeof saved === 'object' && saved !== null && 'conflict' in saved) {
    return bad(String(saved.conflict))
  }
  return NextResponse.json({ ok: true, id: saved })
}
