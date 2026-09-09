import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { lockAndCheckOrgFeature } from '@openbooks/engine/src/org-feature-lock.ts'
import {
  computeScheduledScriptNextRunAt,
  INVALID_SCHEDULED_SCRIPT_CRON_CODE,
} from '@openbooks/engine/src/scripting.ts'
import { validateScriptConfiguration as validate, type ScriptValidationError as ValidationError } from '@openbooks/engine/src/script-config.ts'
import { guardFeaturePermission } from '../../../../lib/feature-gates'

export const runtime = 'nodejs'

function validationResponse(error: ValidationError): NextResponse {
  return NextResponse.json(
    { error: error.message, code: error.code, field: error.field },
    { status: error.code === INVALID_SCHEDULED_SCRIPT_CRON_CODE ? 422 : 400 },
  )
}

export async function POST(req: Request) {
  const gate = await guardFeaturePermission('scripts.manage', 'scripts')
  if (gate instanceof NextResponse) return gate
  const user = gate.user
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as Record<string, unknown>
  const err = validate(body)
  if (err) return validationResponse(err)

  const cron = body.triggerPoint === 'scheduled' ? String(body.cron ?? '').trim() : null
  const nextRunAt = cron && body.isActive !== false ? computeScheduledScriptNextRunAt(cron) : null
  const slug = body.triggerPoint === 'endpoint' ? String(body.endpointSlug ?? '').trim() : null
  // A script can mint or mutate posted documents on every matching event, so
  // its creation is audited with the full row in the same transaction.
  const row = await db.transaction(async (tx) => {
    if (!(await lockAndCheckOrgFeature(tx, user.orgId, 'scripts'))) return NextResponse.json({ error: 'not found' }, { status: 404 })
    const created = (await tx.execute<Record<string, unknown>>(sql`
      insert into user_scripts (org_id, name, trigger_point, document_kind, endpoint_slug, source, cron, next_run_at, timeout_ms, sort_order, is_active)
      values (${user.orgId}, ${body.name}, ${body.triggerPoint}, ${body.documentKind ?? null}, ${slug}, ${body.source},
              ${cron}, ${nextRunAt}, ${body.timeoutMs ?? 2000}, ${body.sortOrder ?? 100}, ${body.isActive !== false})
      returning *
    `))
    await tx.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id, request_id)
      values
        (${user.orgId}, 'user_scripts', ${String(created.rows[0]!.id)}, 'insert',
         ${JSON.stringify({ after: created.rows[0] })}::jsonb,
         ${user.id}, ${req.headers.get('X-Request-Id')})
    `)
    return created.rows[0]!
  })
  if (row instanceof NextResponse) return row
  return NextResponse.json({ id: String(row.id) })
}

export async function PATCH(req: Request) {
  const gate = await guardFeaturePermission('scripts.manage', 'scripts')
  if (gate instanceof NextResponse) return gate
  const user = gate.user
  const parsedBody2 = await parseJsonBody(req, jsonObject);
  if (!parsedBody2.ok) return parsedBody2.response;
  const body = (parsedBody2.data) as Record<string, unknown>
  if (!body.id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  const err = validate(body)
  if (err) return validationResponse(err)

  const cron = body.triggerPoint === 'scheduled' ? String(body.cron ?? '').trim() : null
  const slug = body.triggerPoint === 'endpoint' ? String(body.endpointSlug ?? '').trim() : null
  const missing = await db.transaction(async (tx) => {
    if (!(await lockAndCheckOrgFeature(tx, user.orgId, 'scripts'))) return NextResponse.json({ error: 'not found' }, { status: 404 })
    const before = (await tx.execute<Record<string, unknown>>(sql`
      select * from user_scripts where id = ${body.id} and org_id = ${user.orgId} for update
    `))
    if (!before.rows[0]) return true
    // Derive policy changes against the live locked row. Ordinary edits must
    // retain the scheduler's cursor, including PostgreSQL microseconds.
    const schedulingChanged = before.rows[0].trigger_point !== body.triggerPoint
      || before.rows[0].cron !== cron || before.rows[0].is_active !== (body.isActive !== false)
    const nextRunAt = schedulingChanged
      ? (cron && body.isActive !== false ? computeScheduledScriptNextRunAt(cron) : null)
      : sql`next_run_at`
    const updated = (await tx.execute<Record<string, unknown>>(sql`
      update user_scripts set
        name = ${body.name}, trigger_point = ${body.triggerPoint}, document_kind = ${body.documentKind ?? null},
        endpoint_slug = ${slug},
        source = ${body.source}, cron = ${cron}, next_run_at = ${nextRunAt},
        timeout_ms = ${body.timeoutMs ?? 2000},
        sort_order = ${body.sortOrder ?? 100}, is_active = ${body.isActive !== false}, updated_at = now()
      where id = ${body.id} and org_id = ${user.orgId}
      returning *
    `))
    await tx.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id, request_id)
      values
        (${user.orgId}, 'user_scripts', ${String(updated.rows[0]!.id)}, 'update',
         ${JSON.stringify({ before: before.rows[0], after: updated.rows[0] })}::jsonb,
         ${user.id}, ${req.headers.get('X-Request-Id')})
    `)
    return false
  })
  if (missing instanceof NextResponse) return missing
  if (missing) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
