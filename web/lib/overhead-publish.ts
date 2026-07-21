import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { trueCostData } from './analytics/true-cost-data'

/**
 * Publish per-department overhead $/hr rates into the effective-dated
 * `overhead_rates` card — the ONE code path for all three lifecycle modes:
 * a human clicking Publish (manual), the worker's period tick (scheduled),
 * and the wizard's explicit rates. Closes open per-hour rows so rates never
 * stack, deletes any future-dated rows past the new start, and inserts the
 * new standard rows.
 */
export interface PublishedRate {
  departmentId: string
  ratePerHour: number
}

export async function computeLiveOverheadRates(orgId: string): Promise<PublishedRate[]> {
  const to = new Date()
  const from = new Date(to)
  from.setFullYear(from.getFullYear() - 1)
  const iso = (d: Date) => d.toISOString().slice(0, 10)
  const tc = await trueCostData(orgId, { from: iso(from), to: iso(to), label: 'TTM' })
  return tc.departments
    .filter((d) => d.composite > 0)
    .map((d) => ({ departmentId: d.id, ratePerHour: Math.round(d.composite * 100) / 100 }))
}

export async function publishOverheadRates(
  orgId: string,
  actorId: string | null,
  effectiveFrom: string,
  rates?: PublishedRate[],
): Promise<{ published: number }> {
  let toPublish = rates ?? []
  if (toPublish.length === 0) toPublish = await computeLiveOverheadRates(orgId)
  if (toPublish.length === 0) return { published: 0 }

  for (const r of toPublish) {
    await db.execute(sql`
      update overhead_rates set effective_to = (${effectiveFrom}::date - 1)
       where org_id = ${orgId} and department_id = ${r.departmentId} and rate_kind = 'per_hour'
         and (effective_to is null or effective_to >= ${effectiveFrom}::date)
         and effective_from < ${effectiveFrom}::date`)
    await db.execute(sql`
      delete from overhead_rates
       where org_id = ${orgId} and department_id = ${r.departmentId} and rate_kind = 'per_hour'
         and effective_from >= ${effectiveFrom}::date`)
    await db.execute(sql`
      insert into overhead_rates (org_id, department_id, category, method, rate_kind, rate_percent, effective_from, created_by, updated_by)
      values (${orgId}, ${r.departmentId}, 'Published', 'standard', 'per_hour', ${r.ratePerHour}, ${effectiveFrom}, ${actorId}, ${actorId})`)
  }
  await db.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'overhead_rates', ${orgId}, 'insert',
            ${JSON.stringify({ publish: { effectiveFrom, rates: toPublish, actor: actorId ?? 'scheduler' } })}, ${actorId})`)
  return { published: toPublish.length }
}

/** Current published per-hour rate per department (open row covering today). */
export async function currentPublishedRates(orgId: string): Promise<Map<string, number>> {
  const r = (await db.execute(sql`
    select department_id, rate_percent from overhead_rates
     where org_id = ${orgId} and rate_kind = 'per_hour' and effective_from <= current_date
       and (effective_to is null or effective_to >= current_date)`)) as unknown as {
    rows: { department_id: string | null; rate_percent: string }[]
  }
  const out = new Map<string, number>()
  for (const row of r.rows) if (row.department_id) out.set(row.department_id, Number(row.rate_percent))
  return out
}
