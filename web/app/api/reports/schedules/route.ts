import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import {
  computeNextRunAt,
  normalizeReportRecipientEmails,
  validateCadenceInput,
} from '@openbooks/reports'
import { guardPermission } from '../../../../lib/authz'
import { loadReportDefinition } from '../../../../lib/custom-reports'

export const runtime = 'nodejs'

/** List schedules for a definition (?definitionId=…). */
export async function GET(req: Request) {
  const gate = await guardPermission('reports.read')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const definitionId = new URL(req.url).searchParams.get('definitionId')

  const rows = (await db.execute(sql`
    select id, definition_id, cadence, day_of_week, day_of_month, hour, minute,
           timezone, recipient_emails, next_run_at, active
      from report_schedules
     where org_id = ${user.orgId}
       ${definitionId ? sql`and definition_id = ${definitionId}` : sql``}
     order by next_run_at
  `)) as unknown as { rows: unknown[] }
  return NextResponse.json({ schedules: rows.rows })
}

/**
 * Create a schedule for a definition. Cadence + recipients are validated by
 * the engine policy, and next_run_at is computed via computeNextRunAt so the
 * worker seam can pick due schedules up by a single index scan.
 */
export async function POST(req: Request) {
  const gate = await guardPermission('reports.schedule')
  if (gate instanceof NextResponse) return gate
  const { user } = gate

  const body = (await req.json()) as {
    definitionId?: string
    cadence?: unknown
    dayOfWeek?: unknown
    dayOfMonth?: unknown
    hour?: unknown
    minute?: unknown
    timezone?: unknown
    recipientEmails?: unknown
    active?: boolean
  }

  if (!body.definitionId) {
    return NextResponse.json({ error: 'definitionId is required' }, { status: 422 })
  }
  const def = await loadReportDefinition(user.orgId, body.definitionId)
  if (!def) return NextResponse.json({ error: 'report not found' }, { status: 404 })

  let cadence
  let recipients: string[]
  try {
    cadence = validateCadenceInput(body)
    recipients = normalizeReportRecipientEmails(
      Array.isArray(body.recipientEmails) ? (body.recipientEmails as string[]) : [],
    )
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Invalid schedule' },
      { status: 422 },
    )
  }
  if (body.active !== false && recipients.length === 0) {
    return NextResponse.json({ error: 'At least one recipient is required for an active schedule' }, { status: 422 })
  }
  const nextRunAt = computeNextRunAt(cadence)

  const inserted = (await db.execute(sql`
    insert into report_schedules (org_id, definition_id, cadence, day_of_week, day_of_month,
                                  hour, minute, timezone, recipient_emails, next_run_at, active,
                                  created_by, updated_by)
    values (${user.orgId}, ${def.id}, ${cadence.cadence}, ${cadence.dayOfWeek}, ${cadence.dayOfMonth},
            ${cadence.hour}, ${cadence.minute}, ${cadence.timezone}, ${JSON.stringify(recipients)}::jsonb,
            ${nextRunAt.toISOString()}, ${body.active !== false}, ${user.id}, ${user.id})
    returning id, definition_id, cadence, day_of_week, day_of_month, hour, minute,
              timezone, recipient_emails, next_run_at, active
  `)) as unknown as { rows: unknown[] }

  return NextResponse.json({ schedule: inserted.rows[0] }, { status: 201 })
}
