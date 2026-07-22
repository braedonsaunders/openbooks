import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { syncProjectRevenueContracts } from '@openbooks/engine/src/project-revenue.ts'
import { guardPermission } from '../../../../../lib/authz'
import { isUuid } from '../../../../../lib/list-params'

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
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const body = (await req.json().catch(() => ({}))) as { percentComplete?: number | null }
  const pct = body.percentComplete
  if (pct !== null && pct !== undefined && (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0 || pct > 100)) {
    return NextResponse.json({ error: 'percentComplete must be 0–100 or null' }, { status: 422 })
  }

  const orgId = gate.user.orgId
  const updated = (await db.execute(sql`
    update projects
       set custom = jsonb_set(coalesce(custom, '{}'::jsonb), '{percentCompleteOverride}',
                              ${pct === null || pct === undefined ? sql`'null'::jsonb` : sql`to_jsonb(${pct}::numeric)`}),
           updated_by = ${gate.user.id}, updated_at = now()
     where id = ${id} and org_id = ${orgId}
     returning id`)) as unknown as { rows: { id: string }[] }
  if (!updated.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const today = new Date().toISOString().slice(0, 10)
  const sync = await syncProjectRevenueContracts(orgId, gate.user.id, today, id)
  return NextResponse.json({
    ok: true,
    status: sync.synced[0] ?? null,
    problems: sync.problems,
  })
}
