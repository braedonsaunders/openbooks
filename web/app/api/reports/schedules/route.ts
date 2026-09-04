import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db, withOrgTransaction } from '@openbooks/engine/src/db.ts'
import {
  computeNextRunAt,
  normalizeReportRecipientEmails,
  validateCadenceInput,
} from '@openbooks/reports'
import { can, guardPermission } from '../../../../lib/authz'
import { canAccessReportArtifact, canAccessReportDefinition, snapshotReportAuthorization } from '../../../../lib/report-execution-context'
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
           timezone, recipient_emails, next_run_at, active, authorization_snapshot
      from report_schedules
     where org_id = ${user.orgId}
       ${definitionId ? sql`and definition_id = ${definitionId}` : sql``}
     order by next_run_at
  `))
  const schedules = []
  for (const row of rows.rows) {
    const def = await loadReportDefinition(user.orgId, String(row.definition_id))
    if (def && await canAccessReportDefinition(gate, def) &&
        (row.authorization_snapshot == null || await canAccessReportArtifact(gate, row.authorization_snapshot))) {
      const visible = { ...row }
      delete visible.authorization_snapshot
      schedules.push(visible)
    }
  }
  return NextResponse.json({
    schedules,
    canSchedule: can(gate, 'reports.schedule') || can(gate, '*'),
  })
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

  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as {
    definitionId?: string
    cadence?: unknown
    dayOfWeek?: unknown
    dayOfMonth?: unknown
    hour?: unknown
    minute?: unknown
    timezone?: unknown
    recipientEmails?: unknown
    active?: boolean
    statementParams?: unknown
  }

  if (!body.definitionId) {
    return NextResponse.json({ error: 'definitionId is required' }, { status: 422 })
  }
  const def = await loadReportDefinition(user.orgId, body.definitionId)
  if (!def) return NextResponse.json({ error: 'report not found' }, { status: 404 })
  if (!(await canAccessReportDefinition(gate, def))) return NextResponse.json({ error: 'report access denied' }, { status: 403 })

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

  // Statement pages snapshot their current filter params onto the schedule
  // (stored under filters.statementParams; the render pipeline applies them).
  // Only meaningful for statement definitions; short string values only.
  let filters: Record<string, unknown> | null = null
  if (body.statementParams !== undefined) {
    if (def.report_type !== 'statement') {
      return NextResponse.json({ error: 'statementParams only apply to statement reports' }, { status: 422 })
    }
    const raw = body.statementParams
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return NextResponse.json({ error: 'invalid statementParams' }, { status: 422 })
    }
    const clean: Record<string, string> = {}
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!/^[a-zA-Z][a-zA-Z0-9_.:-]{0,63}$/.test(key)) {
        return NextResponse.json({ error: `invalid statement param ${key}` }, { status: 422 })
      }
      if (typeof value !== 'string' || value.length > 256) {
        return NextResponse.json({ error: `invalid value for statement param ${key}` }, { status: 422 })
      }
      if (value) clean[key] = value
    }
    if (Object.keys(clean).length > 0) filters = { statementParams: clean }
  }
  const nextRunAt = computeNextRunAt(cadence)

  return withOrgTransaction(user.orgId, async () => {
  const inserted = (await db.execute(sql`
    insert into report_schedules (org_id, definition_id, cadence, day_of_week, day_of_month,
                                  hour, minute, timezone, recipient_emails, filters, next_run_at, active,
                                  created_by, updated_by, authorization_snapshot)
    values (${user.orgId}, ${def.id}, ${cadence.cadence}, ${cadence.dayOfWeek}, ${cadence.dayOfMonth},
            ${cadence.hour}, ${cadence.minute}, ${cadence.timezone}, ${JSON.stringify(recipients)}::jsonb,
            ${filters ? JSON.stringify(filters) : null}::jsonb,
            ${nextRunAt.toISOString()}, ${body.active !== false}, ${user.id}, ${user.id}, ${JSON.stringify(snapshotReportAuthorization(gate, def))}::jsonb)
    returning id, definition_id, cadence, day_of_week, day_of_month, hour, minute,
              timezone, recipient_emails, next_run_at, active
  `))

  const created = inserted.rows[0]
  await db.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id, at, request_id)
    values (${user.orgId}, 'report_schedules', ${created!.id}, 'insert',
      ${JSON.stringify({ reason: 'report schedule created', before: null,
        after: { ...created, authorization_snapshot: snapshotReportAuthorization(gate, def) } })}::jsonb,
      ${user.id}, now(), ${req.headers.get('X-Request-Id')})
  `)
  return NextResponse.json({ schedule: created }, { status: 201 })
  })
}
