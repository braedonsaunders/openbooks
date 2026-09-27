import { NextResponse } from 'next/server'
import { z } from 'zod'
import { defineRoute } from '@/lib/api/route'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { syncProjectRevenueContractsInTransaction } from '@openbooks/engine/src/projects/revenue.ts'
import { businessToday } from '@openbooks/engine/src/platform/business-date.ts'
import { lockAndCheckOrgFeature } from '@openbooks/engine/src/organization/org-feature-lock.ts'
import { isUuid } from '../../../../../lib/list-params'
import { subsidiaryVisibleFilter } from '../../../../../lib/subsidiaries'
import { notFound } from "@/lib/api/responses";


/**
 * PUT — set or clear the project's percent-complete OVERRIDE (0–100; null =
 * automatic cost-to-cost). Pure data entry, source platform's percent-complete
 * override equivalent: it refreshes the project's revenue contract schedule,
 * and the central recognition run posts the catch-up. Nothing posts here.
 */
const percentCompleteBody = z.object({
  action: z.literal('set').default('set'),
  percentComplete: z.number().finite().nullable().optional(),
  expectedPercentComplete: z.number().finite().nullable().optional(),
}).strict().refine((body) => Object.keys(body).length > 0, 'A percent-complete action is required.')

export const PUT = defineRoute({
  permission: 'projects.manage',
  feature: 'projects',
  params: z.object({ id: z.string() }),
  body: percentCompleteBody,
  handler: async ({ authz: gate, params: { id }, body }) => {
  if (!isUuid(id)) return notFound("record")

  const pct = body.percentComplete
  if (pct !== null && pct !== undefined && (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0 || pct > 100)) {
    return NextResponse.json({ error: 'percentComplete must be 0–100 or null' }, { status: 422 })
  }
  // An omitted percentComplete with a valid expected token would otherwise
  // fall through to the write below as undefined and persist a JSON null —
  // silently clearing an existing override and resyncing revenue on a value
  // nobody typed. Clearing is an explicit null with intent; a missing key is
  // a client contract error, refused before any read or write runs.
  if (!('percentComplete' in body) || pct === undefined) {
    return NextResponse.json({ error: 'percentComplete is required; pass null to clear the override' }, { status: 422 })
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
  // the obligation or with any book's schedule.
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
                                ${pct === null ? sql`'null'::jsonb` : sql`to_jsonb(${pct}::numeric)`}),
             updated_by = ${gate.user.id}, updated_at = now()
       where id = ${id} and org_id = ${orgId}
       ${subsidiaryVisibleFilter(sql`subsidiary_id`, gate.allowedSubsidiaryIds)}
       returning id`))
    if (!updated.rows[0]) return null
    // The override drives revenue recognition, so the change carries the
    // same before/after audit row every other material project write does —
    // written before the contract sync, in the same transaction, so a sync
    // failure rolls the audit back with the write it evidences.
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'projects', ${id}, 'update',
              ${JSON.stringify({
                percentCompleteOverride: { before: liveValue, after: pct },
                source: 'percent_complete_override',
              })}::jsonb, ${gate.user.id})
    `)
    return syncProjectRevenueContractsInTransaction(tx, orgId, gate.user.id, today, id)
  })
  if (sync instanceof NextResponse) return sync
  if (!sync) return notFound("record")

  // The engine owns the Projects gate and names its skip: an override saved
  // while the sync is skipped must warn, never read back as applied progress.
  return NextResponse.json({
    ok: true,
    status: sync.synced[0] ?? null,
    problems: sync.skipped ? [...sync.problems, sync.skipped] : sync.problems,
  })
  },
})
