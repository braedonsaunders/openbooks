import { validateOrgReportQuery } from '@/lib/custom-record-report-catalog'
import { parseJsonBody } from '@/lib/api/json'
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { validateReportLayout } from '@openbooks/reports'
import { guardPermission } from '../../../../lib/authz'
import { canSeeReportDefinition, guardReportEntity } from '../../../../lib/report-authz'
import { slugifyReportName, uniqueReportSlug } from '../../../../lib/custom-reports'
import { ensureReportDefinitions } from '@openbooks/engine/src/reports/ensure-report-definitions.ts'
import { claimIdempotentCreate, resolveIdempotentReplay } from '../../../../lib/api/idempotency'
import { isUuid } from '../../../../lib/list-params'
import { auditSetupChange } from '../../../../lib/setup/audit'

const createReportBodySchema = z.looseObject({
  name: z.string().optional(),
  description: z.string().nullable().optional(),
  query: z.unknown().optional(),
  layout: z.unknown().optional(),
})

export const runtime = 'nodejs'

/**
 * List report definitions for the org (built-in + custom).
 *
 * Filtered by the same entity gate the runner applies. Listing a payroll plan
 * to a reader who cannot run it leaks the catalog (names, descriptions and the
 * stored plan itself) and hands out the id that every execution path keys on.
 */
export async function GET() {
  const gate = await guardPermission('reports.read')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  await ensureReportDefinitions(user.orgId)
  const rows = (await db.execute<{ report_type: string | null; query: unknown; statement: { kind?: string } | null }>(sql`
    select id, kind, report_type, slug, name, description, query, statement, updated_at
      from report_definitions
     where org_id = ${user.orgId} and archived_at is null
     order by kind, name
  `))
  const visible = []
  for (const row of rows.rows) {
    // Statements answer the statement feature gate and query plans the
    // entity gate; the entity gate alone hides every built-in statement.
    if (!(await canSeeReportDefinition(gate, row))) continue
    visible.push(row)
  }
  return NextResponse.json({
    definitions: visible,
  })
}

/**
 * Explicit create for the unsaved report builder. The caller's UUID
 * Idempotency-Key becomes the definition id, so Save retries replay the same
 * tenant-scoped row and audit event. Opening/cancelling `builder/new` never
 * calls this endpoint and therefore allocates nothing.
 */
export async function POST(req: Request) {
  const gate = await guardPermission('reports.create')
  if (gate instanceof NextResponse) return gate
  const { user } = gate

  const requestId = req.headers.get('Idempotency-Key')?.trim() ?? ''
  if (!isUuid(requestId)) {
    return NextResponse.json({ error: 'invalid_idempotency_key' }, { status: 400 })
  }

  const parsedBody = await parseJsonBody(req, createReportBodySchema);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data
  const name = (body.name ?? '').trim()
  if (!name) return NextResponse.json({ error: 'A report name is required' }, { status: 422 })

  let query
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
  const description = body.description?.trim() || null
  const layout = (validateReportLayout(body.layout) as Record<string, unknown> | null) ?? null
  const slug = await uniqueReportSlug(user.orgId, slugifyReportName(name))

  const snapshot = {
    id: requestId,
    org_id: user.orgId,
    kind: 'custom',
    report_type: 'query',
    slug,
    name,
    description,
    query,
    layout,
    system: false,
    created_by: user.id,
    updated_by: user.id,
  }
  const match = { name, description, query, layout }

  const outcome = await db.transaction(async (tx) => {
    const claim = await claimIdempotentCreate(tx, {
      orgId: user.orgId,
      table: 'report_definitions',
      key: requestId,
    })
    if (claim === 'exists') {
      return {
        kind: 'replay' as const,
        result: await resolveIdempotentReplay(tx, {
          orgId: user.orgId,
          table: 'report_definitions',
          key: requestId,
          match,
        }),
      }
    }
    // A concurrent retry can win the UUID insert after this transaction claims
    // the same key. That collision is benign only after the audited payload is
    // re-resolved below; every other collision is returned as a 409 refusal.
    const inserted = (await tx.execute<Record<string, unknown>>(sql`
      insert into report_definitions
        (id, org_id, kind, report_type, slug, name, description, query, layout,
         system, created_by, updated_by)
      values (${requestId}, ${user.orgId}, 'custom', 'query', ${slug}, ${name}, ${description},
              ${JSON.stringify(query)}::jsonb, ${layout ? JSON.stringify(layout) : null}::jsonb,
              false, ${user.id}, ${user.id})
      on conflict (id) do nothing
      returning id, kind, slug, name, description, query, layout, updated_at
    `))
    if (!inserted.rows[0]) {
      return {
        kind: 'replay' as const,
        result: await resolveIdempotentReplay(tx, {
          orgId: user.orgId,
          table: 'report_definitions',
          key: requestId,
          match,
        }),
      }
    }
    await auditSetupChange(
      {
        orgId: user.orgId,
        table: 'report_definitions',
        rowId: requestId,
        action: 'insert',
        changes: { before: null, after: snapshot },
        actorId: user.id,
        requestId,
      },
      tx,
    )
    return { kind: 'created' as const, definition: inserted.rows[0] }
  })

  if (outcome.kind === 'replay') {
    if (outcome.result === 'conflict') {
      return NextResponse.json({ error: 'invalid_idempotency_key' }, { status: 409 })
    }
    const existing = (await db.execute<Record<string, unknown>>(sql`
      select id, kind, slug, name, description, query, layout, updated_at
        from report_definitions
       where id = ${requestId} and org_id = ${user.orgId}
    `)).rows[0]
    if (!existing) {
      return NextResponse.json({ error: 'invalid_idempotency_key' }, { status: 409 })
    }
    return NextResponse.json({ definition: existing }, { status: 200 })
  }

  return NextResponse.json({ definition: outcome.definition }, { status: 201 })
}
