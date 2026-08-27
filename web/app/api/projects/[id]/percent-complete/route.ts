import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { syncProjectRevenueContractsInTransaction } from '@openbooks/engine/src/project-revenue.ts'
import { businessToday } from '@openbooks/engine/src/business-date.ts'
import { guardPermission } from '../../../../../lib/authz'
import { isUuid } from '../../../../../lib/list-params'
import { guardProjectsFeature } from '../../../../../lib/projects-gate'

export const runtime = 'nodejs'

/**
 * PUT — set or clear the project's percent-complete OVERRIDE (0–100; null =
 * automatic cost-to-cost). Pure data entry, source platform's percent-complete
 * override equivalent: it refreshes the project's revenue contract schedule,
 * and the central recognition run posts the catch-up. Nothing posts here.
 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('projects.manage')
  if (gate instanceof NextResponse) return gate
  const feature = await guardProjectsFeature(gate.user.orgId)
  if (feature) return feature
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as { percentComplete?: number | null }
  const pct = body.percentComplete
  if (pct !== null && pct !== undefined && (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0 || pct > 100)) {
    return NextResponse.json({ error: 'percentComplete must be 0–100 or null' }, { status: 422 })
  }

  const orgId = gate.user.orgId
  const today = await businessToday(orgId)

  // The override write and the contract/obligation/multi-book schedule sync are
  // ONE transaction: a failure after the override (or anywhere in the sync)
  // rolls back the whole thing, so the displayed override never disagrees with
  // the obligation or with any book's schedule (audit fnd_mt982zsr_wd4f6o).
  const sync = await db.transaction(async (tx) => {
    const updated = (await tx.execute<{ id: string }>(sql`
      update projects
         set custom = jsonb_set(coalesce(custom, '{}'::jsonb), '{percentCompleteOverride}',
                                ${pct === null || pct === undefined ? sql`'null'::jsonb` : sql`to_jsonb(${pct}::numeric)`}),
             updated_by = ${gate.user.id}, updated_at = now()
       where id = ${id} and org_id = ${orgId}
       returning id`))
    if (!updated.rows[0]) return null
    return syncProjectRevenueContractsInTransaction(tx, orgId, gate.user.id, today, id)
  })
  if (!sync) return NextResponse.json({ error: 'not found' }, { status: 404 })

  return NextResponse.json({
    ok: true,
    status: sync.synced[0] ?? null,
    problems: sync.problems,
  })
}
