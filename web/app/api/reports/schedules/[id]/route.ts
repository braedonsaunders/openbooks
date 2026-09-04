import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db, withOrgTransaction } from '@openbooks/engine/src/db.ts'
import {
  computeNextRunAt,
  normalizeReportRecipientEmails,
  validateCadenceInput,
} from '@openbooks/reports'
import { loadReportDefinition } from '../../../../../lib/custom-reports'
import { canAccessReportArtifact, canAccessReportDefinition, snapshotReportAuthorization } from '../../../../../lib/report-execution-context'
import { guardPermission } from '../../../../../lib/authz'

export const runtime = 'nodejs'

type ScheduleRow = {
  id: string
  definition_id: string
  cadence: 'daily' | 'weekly' | 'monthly'
  day_of_week: number | null
  day_of_month: number | null
  hour: number
  minute: number
  timezone: string
  recipient_emails: string[]
  next_run_at: string
  active: boolean
  [key: string]: unknown
}

/** Client-supplied reason, or a deterministic fallback for existing callers. */
function scheduleReason(raw: unknown, fallback: string): string {
  return typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, 500) : fallback
}

/** Update cadence/recipients/active. Any cadence change recomputes next_run_at. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('reports.schedule')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const { id } = await params

  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as {
    cadence?: unknown
    dayOfWeek?: unknown
    dayOfMonth?: unknown
    hour?: unknown
    minute?: unknown
    timezone?: unknown
    recipientEmails?: unknown
    active?: boolean
    reason?: unknown
  }

  return withOrgTransaction(user.orgId, async () => {
    // Lock and snapshot the tenant-owned row before deriving any fallback
    // values. The mutation and its audit evidence then share this pinned
    // transaction, so a concurrent edit cannot be silently overwritten.
    const existing = (await db.execute<ScheduleRow>(sql`
      select * from report_schedules
       where id = ${id} and org_id = ${user.orgId}
       for update
    `)).rows[0]
    if (!existing) return NextResponse.json({ error: 'not found' }, { status: 404 })
    const def = await loadReportDefinition(user.orgId, existing.definition_id)
    if (!def || !(await canAccessReportDefinition(gate, def))) return NextResponse.json({ error: 'report access denied' }, { status: 403 })
    if (existing.authorization_snapshot != null && !(await canAccessReportArtifact(gate, existing.authorization_snapshot))) return NextResponse.json({ error: 'original report scope access denied' }, { status: 403 })

    // Re-validate the whole cadence (falling back to the locked stored values)
    // so a partial edit never yields an inconsistent day pair.
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
    const updated = (await db.execute<ScheduleRow>(sql`
      update report_schedules set
        cadence = ${cadence.cadence}, day_of_week = ${cadence.dayOfWeek}, day_of_month = ${cadence.dayOfMonth},
        hour = ${cadence.hour}, minute = ${cadence.minute}, timezone = ${cadence.timezone},
        recipient_emails = ${JSON.stringify(recipients)}::jsonb,
        next_run_at = ${nextRunAt.toISOString()}, active = ${active},
        authorization_snapshot = ${JSON.stringify(snapshotReportAuthorization(gate, def))}::jsonb,
        updated_at = now(), updated_by = ${user.id}
      where id = ${id} and org_id = ${user.orgId}
      returning *
    `)).rows[0]
    if (!updated) return NextResponse.json({ error: 'not found' }, { status: 404 })

    await db.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id, at, request_id)
      values
        (${user.orgId}, 'report_schedules', ${id}, 'update',
         ${JSON.stringify({
           reason: scheduleReason(body.reason, 'report schedule updated'),
           before: existing,
           after: updated,
         })}::jsonb,
         ${user.id}, now(), ${req.headers.get('X-Request-Id')})
    `)
    return NextResponse.json({ schedule: updated })
  })
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('reports.schedule')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const { id } = await params

  let reason: unknown
  // DELETE historically accepted an empty body; only invoke the strict JSON
  // boundary when a body was actually supplied so that callers need not send
  // an otherwise-useless `{}` just to retire a schedule.
  if (req.body) {
    const parsedBody = await parseJsonBody(req, jsonObject)
    if (!parsedBody.ok) return parsedBody.response
    reason = (parsedBody.data as { reason?: unknown }).reason
  }

  return withOrgTransaction(user.orgId, async () => {
    // A delete is terminal for the schedule's delivery configuration. Keep the
    // exact locked row in the same transaction as both the delete and audit.
    const existing = (await db.execute<ScheduleRow>(sql`
      select * from report_schedules
       where id = ${id} and org_id = ${user.orgId}
       for update
    `)).rows[0]
    if (!existing) return NextResponse.json({ error: 'not found' }, { status: 404 })
    const def = await loadReportDefinition(user.orgId, existing.definition_id)
    if (!def || !(await canAccessReportDefinition(gate, def))) return NextResponse.json({ error: 'report access denied' }, { status: 403 })
    if (existing.authorization_snapshot != null && !(await canAccessReportArtifact(gate, existing.authorization_snapshot))) return NextResponse.json({ error: 'original report scope access denied' }, { status: 403 })

    await db.execute(sql`
      delete from report_schedules where id = ${id} and org_id = ${user.orgId}
    `)
    await db.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id, at, request_id)
      values
        (${user.orgId}, 'report_schedules', ${id}, 'delete',
         ${JSON.stringify({
           reason: scheduleReason(reason, 'report schedule deleted'),
           before: existing,
           after: null,
         })}::jsonb,
         ${user.id}, now(), ${req.headers.get('X-Request-Id')})
    `)
    return NextResponse.json({ ok: true })
  })
}
