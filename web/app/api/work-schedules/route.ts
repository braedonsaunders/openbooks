import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { loadWorkSchedules } from '@openbooks/engine/src/work-schedules.ts'
import { guardFeaturePermission } from '../../../lib/feature-gates'
import { isUuid } from '../../../lib/list-params'
import { canonicalDecimal, compareDecimal } from '../../../lib/exact-decimal'

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
 * model and .local/handoff-scheduled-hours.md for the rest of the slice.
 *
 * Scheduled hours are ordinary workforce configuration rather than confidential
 * pay data, but they DECIDE a day's holiday pay in several jurisdictions, so
 * they are gated on admin.setup.manage exactly as wages are.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
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
    db.execute(sql`
      select p.id, p.display_name as name
        from employee_roles er
        join parties p on p.id = er.party_id and p.org_id = er.org_id
       where er.org_id = ${orgId}
       order by p.display_name`) as unknown as Promise<{ rows: { id: string; name: string }[] }>,
    db.execute(sql`
      select id, name from trades where org_id = ${orgId} order by name`) as unknown as Promise<{
      rows: { id: string; name: string }[]
    }>,
    db.execute(sql`
      select id, name from departments where org_id = ${orgId} order by name`) as unknown as Promise<{
      rows: { id: string; name: string }[]
    }>,
    db.execute(sql`
      select id, name from subsidiaries where org_id = ${orgId} order by name`) as unknown as Promise<{
      rows: { id: string; name: string }[]
    }>,
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

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
  const action = String(body.action ?? '')

  if (action === 'delete') {
    if (!isUuid(String(body.id ?? ''))) return bad('a schedule id is required')
    // work_schedule_days cascades on the FK, so the pattern never outlives the
    // schedule it describes.
    await db.execute(sql`
      delete from work_schedules where org_id = ${orgId} and id = ${String(body.id)}`)
    return NextResponse.json({ ok: true })
  }

  if (action !== 'save') return bad(`unknown action "${action}"`)

  const scope = readScope(body)
  if (scope.count > 1) {
    return bad('a work schedule applies to exactly one scope — an employee, a job title, a trade, '
      + 'a department, a subsidiary, or the organization. Choose one')
  }

  const effectiveFrom = String(body.effectiveFrom ?? '')
  if (!DATE_RE.test(effectiveFrom)) return bad('a start date is required')
  const effectiveTo = DATE_RE.test(String(body.effectiveTo ?? '')) ? String(body.effectiveTo) : null
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
    if (!DATE_RE.test(cycleAnchor)) return bad('the cycle needs a first day to count from')
    const supplied = Array.isArray(body.days) ? body.days : []
    for (const entry of supplied) {
      if (!entry || typeof entry !== 'object') continue
      const raw = entry as Record<string, unknown>
      const dayIndex = Number(raw.dayIndex)
      if (!Number.isInteger(dayIndex) || dayIndex < 0 || dayIndex >= cycleDays) continue
      const hours = canonicalDecimal(raw.hours, 4)
      if (hours === null) return bad(`"${String(raw.hours)}" is not a number of hours`)
      if (compareDecimal(hours, '0') < 0 || compareDecimal(hours, '24') > 0) {
        return bad('a day holds between 0 and 24 hours')
      }
      // Zero is the same as no row; storing only the working days keeps the
      // table honest about what "scheduled" means.
      if (compareDecimal(hours, '0') === 0) continue
      days.push({ dayIndex, hours })
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
  // would be a pattern nobody wrote, and it would go on paying somebody.
  const saved = await db.transaction(async (tx) => {
    let scheduleId = id
    if (scheduleId) {
      const updated = (await tx.execute(sql`
        update work_schedules
           set name = ${name}, employee_party_id = ${scope.employeePartyId},
               job_title = ${scope.jobTitle}, trade_id = ${scope.tradeId},
               department_id = ${scope.departmentId}, subsidiary_id = ${scope.subsidiaryId},
               pattern = ${pattern}, cycle_days = ${cycleDays}, cycle_anchor = ${cycleAnchor},
               effective_from = ${effectiveFrom}, effective_to = ${effectiveTo},
               notes = ${notes}, is_active = ${isActive},
               updated_at = now(), updated_by = ${actorId}
         where org_id = ${orgId} and id = ${scheduleId}
         returning id`)) as unknown as { rows: { id: string }[] }
      if (updated.rows.length === 0) throw new Error('that work schedule no longer exists')
      await tx.execute(sql`
        delete from work_schedule_days where org_id = ${orgId} and schedule_id = ${scheduleId}`)
    } else {
      const inserted = (await tx.execute(sql`
        insert into work_schedules (org_id, name, employee_party_id, job_title, trade_id,
                                    department_id, subsidiary_id, pattern, cycle_days, cycle_anchor,
                                    effective_from, effective_to, notes, is_active,
                                    created_by, updated_by)
        values (${orgId}, ${name}, ${scope.employeePartyId}, ${scope.jobTitle}, ${scope.tradeId},
                ${scope.departmentId}, ${scope.subsidiaryId}, ${pattern}, ${cycleDays},
                ${cycleAnchor}, ${effectiveFrom}, ${effectiveTo}, ${notes}, ${isActive},
                ${actorId}, ${actorId})
        returning id`)) as unknown as { rows: { id: string }[] }
      scheduleId = inserted.rows[0]!.id
    }
    for (const day of days) {
      await tx.execute(sql`
        insert into work_schedule_days (org_id, schedule_id, day_index, hours, created_by, updated_by)
        values (${orgId}, ${scheduleId}, ${day.dayIndex}, ${day.hours}, ${actorId}, ${actorId})`)
    }
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
