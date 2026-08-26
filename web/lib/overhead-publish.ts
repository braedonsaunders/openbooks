import 'server-only'
import { sql } from 'drizzle-orm'
import { db, inDbTransaction } from '@openbooks/engine/src/db.ts'
import { formatMoney } from '@openbooks/engine/src/money.ts'
import { businessToday } from '@openbooks/engine/src/business-date.ts'
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
  ratePerHour: string
}

export async function computeLiveOverheadRates(orgId: string): Promise<PublishedRate[]> {
  const to = await businessToday(orgId)
  const [y, m, d] = to.split('-').map(Number)
  const from = `${(y ?? 0) - 1}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  const tc = await trueCostData(orgId, { from, to, label: 'TTM' })
  return tc.departments
    .filter((d) => d.composite > 0)
    .map((d) => ({ departmentId: d.id, ratePerHour: formatMoney(String(d.composite), 2) }))
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

  // Every department's close/delete/insert AND the audit row are one atomic
  // unit: a failure on any department must leave the previous rate card fully
  // intact, never a mixed-generation card with some rows replaced and others
  // untouched and no canonical publish audit. Joins an org boundary's pinned
  // transaction when the caller already owns one.
  await inDbTransaction(async (tx) => {
    for (const r of toPublish) {
      await tx.execute(sql`
        update overhead_rates set effective_to = (${effectiveFrom}::date - 1)
         where org_id = ${orgId} and department_id = ${r.departmentId} and rate_kind = 'per_hour'
           and (effective_to is null or effective_to >= ${effectiveFrom}::date)
           and effective_from < ${effectiveFrom}::date`)
      await tx.execute(sql`
        delete from overhead_rates
         where org_id = ${orgId} and department_id = ${r.departmentId} and rate_kind = 'per_hour'
           and effective_from >= ${effectiveFrom}::date`)
      await tx.execute(sql`
        insert into overhead_rates (org_id, department_id, category, method, rate_kind, rate_percent, effective_from, created_by, updated_by)
        values (${orgId}, ${r.departmentId}, 'Published', 'standard', 'per_hour', ${r.ratePerHour}, ${effectiveFrom}, ${actorId}, ${actorId})`)
    }
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'overhead_rates', ${orgId}, 'insert',
              ${JSON.stringify({ publish: { effectiveFrom, rates: toPublish, actor: actorId ?? 'scheduler' } })}, ${actorId})`)
  })
  return { published: toPublish.length }
}

/** Current published per-hour rate per department (open row covering today). */
export async function currentPublishedRates(orgId: string): Promise<Map<string, number>> {
  const today = await businessToday(orgId)
  const r = (await db.execute<{ department_id: string | null; rate_percent: string }>(sql`
    select department_id, rate_percent from overhead_rates
     where org_id = ${orgId} and rate_kind = 'per_hour' and effective_from <= ${today}
       and (effective_to is null or effective_to >= ${today})`))
  const out = new Map<string, number>()
  for (const row of r.rows) if (row.department_id) out.set(row.department_id, Number(row.rate_percent))
  return out
}
