import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { syncProjectRevenueContractsInTransaction } from '@openbooks/engine/src/projects/revenue.ts'
import { businessToday } from '@openbooks/engine/src/platform/business-date.ts'
import { lockAndCheckOrgFeature } from '@openbooks/engine/src/organization/org-feature-lock.ts'
import { guardPermission } from '../../../../../lib/authz'
import { isUuid } from '../../../../../lib/list-params'
import { guardProjectsFeature } from '../../../../../lib/projects-gate'
import { subsidiaryVisibleFilter } from '../../../../../lib/subsidiaries'

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
  const body = (parsedBody.data) as { percentComplete?: number | null; expectedPercentComplete?: number | null }
  const pct = body.percentComplete
  if (pct !== null && pct !== undefined && (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0 || pct > 100)) {
    return NextResponse.json({ error: 'percentComplete must be 0–100 or null' }, { status: 422 })
  }
  // Mandatory compare-and-swap evidence on the single scalar being set: two
  // tabs saving absolute overrides must 409 instead of silently re-basing
  // revenue recognition on a stale number. The client sends the override
  // value it rendered (single-scalar variant of the revision-token contract —
  // no token plumbing, no false conflicts, exact intent preservation).
  // Checked after the gates so a missing value never leaks project existence.
  const expected = body.expectedPercentComplete
  if (expected !== null && expected !== undefined && (typeof expected !== 'number' || !Number.isFinite(expected) || expected < 0 || expected > 100)) {
    return NextResponse.json({ error: 'expectedPercentComplete must be 0–100 or null' }, { status: 409 })
  }
  if (expected === undefined) {
    return NextResponse.json({ error: 'A current override value is required; reload the project and try again' }, { status: 409 })
  }

  const orgId = gate.user.orgId
  const today = await businessToday(orgId)

  // The override write and the contract/obligation/multi-book schedule sync are
  // ONE transaction: a failure after the override (or anywhere in the sync)
  // rolls back the whole thing, so the displayed override never disagrees with
  // the obligation or with any book's schedule (audit fnd_mt982zsr_wd4f6o).
  const sync = await db.transaction(async (tx) => {
    if (!(await lockAndCheckOrgFeature(tx, orgId, 'projects'))) {
      return NextResponse.json({ error: 'projects feature is disabled' }, { status: 404 })
    }
    // The row lock serializes concurrent saves; the value decides the winner.
    // A tab that rendered before a sibling's save committed refuses loudly
    // instead of re-basing recognition on its stale number.
    const live = (await tx.execute<{ override: string | null }>(sql`
      select nullif(custom->>'percentCompleteOverride', '') as override
        from projects
       where id = ${id} and org_id = ${orgId}
       ${subsidiaryVisibleFilter(sql`subsidiary_id`, gate.allowedSubsidiaryIds)}
       for update
    `)).rows[0]
    if (!live) return null
    const liveValue = live.override === null ? null : Number(live.override)
    const matches = (liveValue === null && expected === null)
      || (liveValue !== null && expected !== null && Number.isFinite(liveValue) && liveValue === expected)
    if (!matches) {
      return NextResponse.json({ error: 'This override changed after you opened it; reload the project and reapply your value' }, { status: 409 })
    }
    const updated = (await tx.execute<{ id: string }>(sql`
      update projects
         set custom = jsonb_set(coalesce(custom, '{}'::jsonb), '{percentCompleteOverride}',
                                ${pct === null || pct === undefined ? sql`'null'::jsonb` : sql`to_jsonb(${pct}::numeric)`}),
             updated_by = ${gate.user.id}, updated_at = now()
       where id = ${id} and org_id = ${orgId}
       ${subsidiaryVisibleFilter(sql`subsidiary_id`, gate.allowedSubsidiaryIds)}
       returning id`))
    if (!updated.rows[0]) return null
    return syncProjectRevenueContractsInTransaction(tx, orgId, gate.user.id, today, id)
  })
  if (sync instanceof NextResponse) return sync
  if (!sync) return NextResponse.json({ error: 'not found' }, { status: 404 })

  return NextResponse.json({
    ok: true,
    status: sync.synced[0] ?? null,
    problems: sync.problems,
  })
}
