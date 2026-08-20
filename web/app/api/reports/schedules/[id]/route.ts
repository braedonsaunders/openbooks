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
  const r = (await db.execute<ScheduleRow>(sql`
    select id, cadence, day_of_week, day_of_month, hour, minute, timezone, recipient_emails, active
      from report_schedules
     where id = ${id} and org_id = ${orgId}
  `))
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
  if (active && recipients.length === 0) {
    return NextResponse.json({ error: 'At least one recipient is required for an active schedule' }, { status: 422 })
  }
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
  `))
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
