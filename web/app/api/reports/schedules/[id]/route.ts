import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import {
  computeNextRunAt,
  normalizeReportRecipientEmails,
  validateCadenceInput,
} from '@openbooks/reports'
import { guardPermission } from '../../../../../lib/authz'

export const runtime = 'nodejs'

type ScheduleRow = {
  id: string
  cadence: 'daily' | 'weekly' | 'monthly'
  day_of_week: number | null
  day_of_month: number | null
  hour: number
  minute: number
  timezone: string
  recipient_emails: string[]
  active: boolean
}

async function loadSchedule(orgId: string, id: string): Promise<ScheduleRow | null> {
  const r = (await db.execute(sql`
    select id, cadence, day_of_week, day_of_month, hour, minute, timezone, recipient_emails, active
      from report_schedules
     where id = ${id} and org_id = ${orgId}
  `)) as unknown as { rows: ScheduleRow[] }
  return r.rows[0] ?? null
}

/** Update cadence/recipients/active. Any cadence change recomputes next_run_at. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('reports.schedule')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const { id } = await params

  const existing = await loadSchedule(user.orgId, id)
  if (!existing) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const body = (await req.json()) as {
    cadence?: unknown
    dayOfWeek?: unknown
    dayOfMonth?: unknown
    hour?: unknown
    minute?: unknown
    timezone?: unknown
    recipientEmails?: unknown
    active?: boolean
  }

  // Re-validate the whole cadence (falling back to the stored values) so a
  // partial edit never yields an inconsistent day-of-week/day-of-month pair.
  let cadence
  let recipients: string[]
  try {
    cadence = validateCadenceInput({
      cadence: body.cadence ?? existing.cadence,
      dayOfWeek: body.dayOfWeek ?? existing.day_of_week,
      dayOfMonth: body.dayOfMonth ?? existing.day_of_month,
      hour: body.hour ?? existing.hour,
      minute: body.minute ?? existing.minute,
      timezone: body.timezone ?? existing.timezone,
    })
    recipients = normalizeReportRecipientEmails(
      Array.isArray(body.recipientEmails)
        ? (body.recipientEmails as string[])
        : existing.recipient_emails,
    )
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Invalid schedule' },
      { status: 422 },
    )
  }
  const active = body.active !== undefined ? body.active : existing.active
  const nextRunAt = computeNextRunAt(cadence)

  const updated = (await db.execute(sql`
    update report_schedules set
      cadence = ${cadence.cadence}, day_of_week = ${cadence.dayOfWeek}, day_of_month = ${cadence.dayOfMonth},
      hour = ${cadence.hour}, minute = ${cadence.minute}, timezone = ${cadence.timezone},
      recipient_emails = ${JSON.stringify(recipients)}::jsonb,
      next_run_at = ${nextRunAt.toISOString()}, active = ${active},
      updated_at = now(), updated_by = ${user.id}
    where id = ${id} and org_id = ${user.orgId}
    returning id, definition_id, cadence, day_of_week, day_of_month, hour, minute,
              timezone, recipient_emails, next_run_at, active
  `)) as unknown as { rows: unknown[] }
  return NextResponse.json({ schedule: updated.rows[0] })
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('reports.schedule')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const { id } = await params

  const existing = await loadSchedule(user.orgId, id)
  if (!existing) return NextResponse.json({ error: 'not found' }, { status: 404 })
  await db.execute(sql`delete from report_schedules where id = ${id} and org_id = ${user.orgId}`)
  return NextResponse.json({ ok: true })
}

/*
 * WORKER SEAM — scheduled delivery is NOT implemented yet.
 *
 * A background worker (cron/queue) should, on each tick:
 *   1. SELECT * FROM report_schedules
 *        WHERE active AND next_run_at <= now()   -- uses report_schedules_due
 *      FOR UPDATE SKIP LOCKED;
 *   2. For each: load its definition, mergeReportFilters(def.query, schedule.filters),
 *      then recordReportRun({ trigger: 'scheduled', scheduleId, ... }) from
 *      web/lib/custom-reports.ts (same executor the UI uses);
 *   3. Email the resulting CSV to schedule.recipient_emails (no mail transport
 *      is wired in openbooks yet — this is the only missing piece);
 *   4. Advance next_run_at = computeNextRunAt(cadence, new Date()).
 *
 * Everything except steps 3 (email transport) and the worker loop itself is
 * already built and reused here — recordReportRun persists the run + CSV, and
 * computeNextRunAt/validateCadenceInput live in @openbooks/reports.
 */
