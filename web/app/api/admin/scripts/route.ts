import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import {
  computeScheduledScriptNextRunAt,
  InvalidScheduledScriptCronError,
  INVALID_SCHEDULED_SCRIPT_CRON_CODE,
} from '@openbooks/engine/src/scripting.ts'
import { guardFeaturePermission } from '../../../../lib/feature-gates'

export const runtime = 'nodejs'

const TRIGGERS = ['before_submit', 'before_post', 'after_post', 'before_void', 'scheduled', 'endpoint', 'bulk', 'client']
const SLUG_RE = /^[a-z][a-z0-9-]*$/

type ValidationError = { message: string; code?: string; field?: string }

function validate(body: Record<string, unknown>): ValidationError | null {
  if (!body.name || String(body.name).length > 200) return { message: 'name required' }
  if (!TRIGGERS.includes(String(body.triggerPoint))) return { message: 'invalid trigger point' }
  const src = String(body.source ?? '')
  if (!src || src.length > 100_000) return { message: 'source required (max 100k chars)' }
  if (!/function\s+main\s*\(/.test(src)) return { message: 'script must define function main(ctx)' }
  if (String(body.triggerPoint) === 'scheduled') {
    const cron = String(body.cron ?? '').trim()
    if (!cron) {
      return {
        message: 'scheduled scripts require a cron expression',
        code: INVALID_SCHEDULED_SCRIPT_CRON_CODE,
        field: 'cron',
      }
    }
    if (cron.length > 200) {
      return {
        message: 'cron expression too long',
        code: INVALID_SCHEDULED_SCRIPT_CRON_CODE,
        field: 'cron',
      }
    }
    try {
      computeScheduledScriptNextRunAt(cron)
    } catch (error) {
      if (!(error instanceof InvalidScheduledScriptCronError)) throw error
      return {
        message: error.message,
        code: INVALID_SCHEDULED_SCRIPT_CRON_CODE,
        field: 'cron',
      }
    }
  }
  if (String(body.triggerPoint) === 'endpoint') {
    const slug = String(body.endpointSlug ?? '').trim()
    if (!slug) return { message: 'endpoint scripts require a URL slug' }
    if (slug.length > 80 || !SLUG_RE.test(slug)) return { message: 'slug must be lowercase letters, digits, hyphens' }
  }
  return null
}

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
    const created = (await tx.execute<Record<string, unknown>>(sql`
      insert into user_scripts (org_id, name, trigger_point, document_kind, endpoint_slug, source, cron, next_run_at, timeout_ms, sort_order, is_active)
      values (${user.orgId}, ${body.name}, ${body.triggerPoint}, ${body.documentKind ?? null}, ${slug}, ${body.source},
              ${cron}, ${nextRunAt}, ${Math.min(Number(body.timeoutMs) || 2000, 10_000)}, ${Number(body.sortOrder) || 100}, ${body.isActive !== false})
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
  const nextRunAt = cron && body.isActive !== false ? computeScheduledScriptNextRunAt(cron) : null
  const slug = body.triggerPoint === 'endpoint' ? String(body.endpointSlug ?? '').trim() : null
  const missing = await db.transaction(async (tx) => {
    const before = (await tx.execute<Record<string, unknown>>(sql`
      select * from user_scripts where id = ${body.id} and org_id = ${user.orgId}
    `))
    if (!before.rows[0]) return true
    const updated = (await tx.execute<Record<string, unknown>>(sql`
      update user_scripts set
        name = ${body.name}, trigger_point = ${body.triggerPoint}, document_kind = ${body.documentKind ?? null},
        endpoint_slug = ${slug},
        source = ${body.source}, cron = ${cron}, next_run_at = ${nextRunAt},
        timeout_ms = ${Math.min(Number(body.timeoutMs) || 2000, 10_000)},
        sort_order = ${Number(body.sortOrder) || 100}, is_active = ${body.isActive !== false}, updated_at = now()
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
  if (missing) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
