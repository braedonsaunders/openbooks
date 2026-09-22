import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { REPORT_ENTITY_MAP, defaultRowsQuery, validateReportLayout } from '@openbooks/reports'
import { validateOrgReportQuery } from '@/lib/custom-record-report-catalog'
import { guardPermission } from '../../../lib/authz'
import { isUuid } from '../../../lib/list-params'
import { canRunReportEntity, guardReportEntity } from '../../../lib/report-authz'
import { claimIdempotentCreate, resolveIdempotentReplay } from '../../../lib/api/idempotency'
import { auditSetupChange } from '../../../lib/setup/audit'
import { loadViews, slugifyViewName, uniqueViewSlug, type ViewScope } from '../../../lib/views'

const createViewBodySchema = z.looseObject({
  name: z.string().optional(),
  description: z.string().nullable().optional(),
  query: z.unknown().optional(),
  layout: z.unknown().optional(),
  scope: z.string().optional(),
  allowedRoles: z.unknown().optional(),
})

export const runtime = 'nodejs'

/**
 * List the views visible to the caller (own private + shared).
 *
 * Filtered by the same entity gate the runner applies. Listing a payroll plan
 * to a reader who cannot run it leaks the catalog (names, descriptions and the
 * stored plan itself) and hands out the id that every execution path keys on.
 */
export async function GET() {
  const gate = await guardPermission('reports.read')
  if (gate instanceof NextResponse) return gate
  const { user, permissions } = gate
  const rows = await loadViews(user.orgId, user.id, permissions)
  const visible = []
  for (const row of rows) {
    if (!(await canRunReportEntity(gate, row.query))) continue
    visible.push(row)
  }
  return NextResponse.json({ views: visible })
}

/**
 * Explicit create for a saved view. The New button opens an UNSAVED studio
 * (`?view=new`) and this endpoint runs only on Save: the caller supplies a
 * UUID idempotency key, which becomes the view id, so retrying the same
 * request returns the same view without a duplicate insert or duplicate
 * audit event. Cancel/close writes nothing.
 */
export async function POST(req: Request) {
  const gate = await guardPermission('reports.create')
  if (gate instanceof NextResponse) return gate
  const { user } = gate

  const requestId = req.headers.get('Idempotency-Key')?.trim() ?? ''
  if (!isUuid(requestId)) {
    return NextResponse.json({ error: 'invalid_idempotency_key' }, { status: 400 })
  }

  const parsedBody = await parseJsonBody(req, createViewBodySchema);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data

  const name = body.name?.trim() || 'Untitled view'
  const description = body.description?.trim() || null

  let query = defaultRowsQuery(REPORT_ENTITY_MAP.ledger_lines!)
  if (body.query !== undefined) {
    try {
      query = await validateOrgReportQuery(gate, body.query)
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'Invalid report query' },
        { status: 422 },
      )
    }
    const denied = await guardReportEntity(gate, query)
    if (denied) return denied
  }
  const layout = (validateReportLayout(body.layout) as Record<string, unknown> | null) ?? null

  const scopeValue: unknown = body.scope ?? 'private'
  if (scopeValue !== 'private' && scopeValue !== 'shared') {
    return NextResponse.json({ error: 'Invalid scope' }, { status: 422 })
  }
  const scope: ViewScope = scopeValue
  let allowedRoles: string[] | null = null
  if (body.allowedRoles !== undefined && body.allowedRoles !== null) {
    if (
      !Array.isArray(body.allowedRoles) ||
      body.allowedRoles.some((r) => typeof r !== 'string' || r.trim() === '')
    ) {
      return NextResponse.json({ error: 'Invalid allowedRoles' }, { status: 422 })
    }
    const roles = [...new Set((body.allowedRoles as string[]).map((r) => r.trim()))]
    allowedRoles = roles.length ? roles : null
  }

  const slug = await uniqueViewSlug(user.orgId, slugifyViewName(name))

  const snapshot = {
    id: requestId,
    org_id: user.orgId,
    slug,
    name,
    description,
    query,
    layout,
    scope,
    owner_id: user.id,
    allowed_roles: allowedRoles,
  }
  const match = { name, description, query, layout, scope, owner_id: user.id, allowed_roles: allowedRoles }

  const outcome = await db.transaction(async (tx) => {
    const claim = await claimIdempotentCreate(tx, {
      orgId: user.orgId,
      table: 'saved_views',
      key: requestId,
    })
    if (claim === 'exists') {
      return {
        kind: 'replay' as const,
        result: await resolveIdempotentReplay(tx, {
          orgId: user.orgId,
          table: 'saved_views',
          key: requestId,
          match,
        }),
      }
    }
    const inserted = (await tx.execute<{ id: string; slug: string }>(sql`
      insert into saved_views
        (id, org_id, slug, name, description, query, layout, scope, owner_id,
         allowed_roles, created_by, updated_by)
      values (${requestId}, ${user.orgId}, ${slug}, ${name}, ${description},
              ${JSON.stringify(query)}::jsonb, ${layout ? JSON.stringify(layout) : null}::jsonb,
              ${scope}, ${user.id},
              ${allowedRoles ? JSON.stringify(allowedRoles) : null}::jsonb,
              ${user.id}, ${user.id})
      on conflict (id) do nothing
      returning id, slug
    `))
    if (!inserted.rows[0]) {
      return {
        kind: 'replay' as const,
        result: await resolveIdempotentReplay(tx, {
          orgId: user.orgId,
          table: 'saved_views',
          key: requestId,
          match,
        }),
      }
    }
    await auditSetupChange(
      {
        orgId: user.orgId,
        table: 'saved_views',
        rowId: requestId,
        action: 'insert',
        changes: { before: null, after: snapshot },
        actorId: user.id,
        requestId,
      },
      tx,
    )
    return { kind: 'created' as const, result: inserted.rows[0] }
  })
  if (outcome.kind === 'replay') {
    if (outcome.result === 'conflict') {
      return NextResponse.json({ error: 'invalid_idempotency_key' }, { status: 409 })
    }
    const existing = (await db.execute<{ id: string; slug: string }>(sql`
      select id, slug from saved_views
       where id = ${requestId} and org_id = ${user.orgId}
    `))
    if (!existing.rows[0]) {
      return NextResponse.json({ error: 'invalid_idempotency_key' }, { status: 409 })
    }
    return NextResponse.json({ id: existing.rows[0].id, slug: existing.rows[0].slug }, { status: 200 })
  }
  return NextResponse.json({ id: outcome.result.id, slug: outcome.result.slug }, { status: 201 })
}
