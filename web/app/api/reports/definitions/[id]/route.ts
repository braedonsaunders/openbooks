import { z } from 'zod';
import { defineRoute } from '@/lib/api/route';
import { apiErrorResponse } from '@/lib/api/error-response'
import { validateOrgReportQuery } from '@/lib/custom-record-report-catalog'
import { isDocumentRevisionToken } from '../../../../../lib/api/registry-data'
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { auditSetupChange } from '../../../../../lib/setup/audit'
import { validateReportLayout } from '@openbooks/reports'
import { isUuid } from '../../../../../lib/list-params'
import { canAccessReportDefinition } from '../../../../../lib/report-execution-context'
import { canSeeReportDefinition, guardReportEntity } from '../../../../../lib/report-authz'
import {
  loadReportDefinition,
  slugifyReportName,
  uniqueReportSlug,
} from '../../../../../lib/custom-reports'
import { notFound } from "@/lib/api/responses";
const reportLayoutSchema = z.object({
  paperSize: z.enum(['letter', 'legal', 'a4']).optional(),
  orientation: z.enum(['portrait', 'landscape']).optional(), marginMm: z.number().finite().optional(),
  showSummary: z.boolean().optional(), density: z.enum(['compact', 'standard']).optional(),
}).nullable().optional();
const PATCHBodySchema1 = z.object({
  name: z.string().trim().min(1).optional(), description: z.string().nullable().optional(),
  query: z.json().optional(), layout: reportLayoutSchema, expectedUpdatedAt: z.string().min(1).optional(),
});



export const runtime = 'nodejs'

const REPORT_DEFINITION_REVISION = sql`to_char(
  updated_at at time zone 'UTC',
  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
)`

async function loadReportDefinitionRevision(orgId: string, id: string): Promise<string | null> {
  const result = await db.execute<{ updated_at: string }>(sql`
    select ${REPORT_DEFINITION_REVISION} as updated_at
      from report_definitions
     where id = ${id} and org_id = ${orgId}
  `)
  return result.rows[0]?.updated_at ?? null
}

export const GET = defineRoute({
  permission: 'reports.read',
  feature: { none: "The loaded definition is filtered by its effective statement or query entity feature access." },
  handler: async ({ request: _req, authz: routeAuthz, params: routeParams }) => {
    const params = Promise.resolve(routeParams as { id: string });
    const gate = routeAuthz;
    const { id } = await params
    if (!isUuid(id)) return notFound("record")
    const def = await loadReportDefinition(gate.user.orgId, id)
    if (!def) return notFound("record")
    if (!(await canSeeReportDefinition(gate, def))) return notFound("record")
    const updatedAt = await loadReportDefinitionRevision(gate.user.orgId, id)
    return NextResponse.json({ definition: { ...def, updated_at: updatedAt ?? def.updated_at } })
  },
});

/**
 * Autosave/save for a definition. Built-ins are name/query-editable in place
 * too (an org may tune a seeded plan), but the kind is never changed here.
 */
export const PATCH = defineRoute({
  permission: 'reports.create',
  feature: { none: "Updated query plans are checked for their entity feature access before they are saved." },
  body: PATCHBodySchema1,
  handler: async ({ request: _req, authz: routeAuthz, params: routeParams, body: routeBody }) => {
    const params = Promise.resolve(routeParams as { id: string });
    const gate = routeAuthz;
    const { user } = gate
    const { id } = await params
    if (!isUuid(id)) return notFound("record")
    const existing = await loadReportDefinition(user.orgId, id)
    if (!existing) return notFound("record")
    if (!(await canAccessReportDefinition(gate, existing))) return NextResponse.json({ error: 'report access denied' }, { status: 403 })

    const body = (routeBody) as {
        name?: string
        description?: string | null
        query?: unknown
        layout?: unknown
        expectedUpdatedAt?: unknown
      }
    if (!isDocumentRevisionToken(body.expectedUpdatedAt)) {
        return NextResponse.json(
          { error: 'the report definition revision is required; reload and review the latest revision' },
          { status: 409 },
        )
      }
    const expectedUpdatedAt = body.expectedUpdatedAt
    let name = existing.name
    let slug = existing.slug
    if (typeof body.name === 'string') {
        name = body.name.trim()
        if (!name) return NextResponse.json({ error: 'A report name is required' }, { status: 422 })
        if (name !== existing.name) {
          slug = await uniqueReportSlug(user.orgId, slugifyReportName(name), id)
        }
      }
    let queryJson = JSON.stringify(existing.query)
    if (body.query !== undefined) {
        try {
          const query = await validateOrgReportQuery(gate, body.query)
          const denied = await guardReportEntity(gate, query)
          if (denied) return denied
          queryJson = JSON.stringify(query)
        } catch (err) {
          return apiErrorResponse(err, { safeStatus: 422 })
        }
      }
    const layout =
        body.layout !== undefined ? validateReportLayout(body.layout) : existing.layout
    const updated = await db.transaction(async (tx) => {
        const result = await tx.execute<Record<string, unknown>>(sql`
          update report_definitions set
            name = ${name},
            slug = ${slug},
            description = ${body.description !== undefined ? body.description?.trim() || null : existing.description},
            query = ${queryJson}::jsonb,
            layout = ${layout ? JSON.stringify(layout) : null}::jsonb,
            updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond'), updated_by = ${user.id}
          where id = ${id} and org_id = ${user.orgId}
            and ${REPORT_DEFINITION_REVISION} = ${expectedUpdatedAt}
          returning id, kind, report_type, slug, name, description, query, statement,
                    system, layout, created_at, updated_at, created_by, updated_by
        `)
        const after = result.rows[0]
        if (!after) return null
        await auditSetupChange(
          {
            orgId: user.orgId,
            table: 'report_definitions',
            rowId: id,
            action: 'update',
            changes: { before: existing, after },
            actorId: user.id,
          },
          tx,
        )
        return after
      })
    if (!updated) {
        return NextResponse.json(
          { error: 'this report definition changed after you opened it; reload and review the latest revision' },
          { status: 409 },
        )
      }
    const def = await loadReportDefinition(user.orgId, id)
    const updatedAt = await loadReportDefinitionRevision(user.orgId, id)
    return NextResponse.json({ definition: def ? { ...def, updated_at: updatedAt ?? def.updated_at } : def })
  },
});

export const DELETE = defineRoute({
  permission: 'reports.create',
  feature: { none: "Deletion checks access to the selected definition before changing its lifecycle state." },
  handler: async ({ request: _req, authz: routeAuthz, params: routeParams }) => {
    const params = Promise.resolve(routeParams as { id: string });
    const gate = routeAuthz;
    const { user } = gate
    const { id } = await params
    if (!isUuid(id)) return notFound("record")
    const existing = await loadReportDefinition(user.orgId, id)
    if (!existing) return notFound("record")
    if (!(await canAccessReportDefinition(gate, existing))) return NextResponse.json({ error: 'report access denied' }, { status: 403 })
    if (existing.kind === 'built_in') {
        return NextResponse.json(
          { error: 'Built-in reports cannot be deleted — clone it instead.' },
          { status: 422 },
        )
      }
    const archived = await db.transaction(async (tx) => {
        const result = (await tx.execute<Record<string, unknown>>(sql`
          update report_definitions set
            archived_at = clock_timestamp(),
            archived_by = ${user.id},
            updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond'), updated_by = ${user.id}
           where id = ${id} and org_id = ${user.orgId} and kind = 'custom' and archived_at is null
           returning id, kind, report_type, slug, name, description, query, statement,
                     system, layout, created_at, updated_at, created_by, updated_by,
                     archived_at, archived_by
        `))
        const after = result.rows[0]
        if (!after) return null

        await tx.execute(sql`
          update report_schedules set active = false, updated_at = now()
           where org_id = ${user.orgId} and definition_id = ${id} and active
        `)

        await auditSetupChange(
          {
            orgId: user.orgId,
            table: 'report_definitions',
            rowId: id,
            action: 'delete',
            changes: { before: existing, after },
            actorId: user.id,
          },
          tx,
        )
        return after
      })
    if (!archived) return notFound("record")
    return NextResponse.json({ ok: true })
  },
});
