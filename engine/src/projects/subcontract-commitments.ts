import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { flowTranslation, translateFlowAmount } from "../fx/translation.ts";
import { add, normalizeMoney } from "../money/money.ts";

/**
 * Revised, unbilled vendor commitments that are not already represented by a
 * purchase order. Linked POs stay exclusively in the order rollup so the same
 * commitment can never be counted twice.
 *
 * Commitments arrive per subcontract currency (change orders and pay
 * applications read in their subcontract's currency) and translate to
 * presentation at the closing spot: an open commitment is a point-in-time
 * balance, valued today like any other balance.
 */
export async function directSubcontractOpenCommitment(
  orgId: string,
  projectId: string,
): Promise<string> {
  const result = (await db.execute<{ func: string | null; committed: string }>(sql`
    select s.currency as func,
      coalesce(sum(greatest(0,
        s.original_commitment + coalesce(changes.approved, 0) - coalesce(apps.billed, 0)
      )), 0) as committed
      from subcontracts s
      left join lateral (
        select sum(amount) filter (where status = 'approved') as approved
          from subcontract_change_orders
         where org_id = s.org_id and subcontract_id = s.id
      ) changes on true
      left join lateral (
        select sum(gross_this_period) filter (where status = 'billed') as billed
          from vendor_pay_applications
         where org_id = s.org_id and subcontract_id = s.id
      ) apps on true
     where s.org_id = ${orgId} and s.project_id = ${projectId}
       and s.status in ('active', 'substantially_complete')
       and s.purchase_order_id is null
     group by 1
  `));
  const today = new Date().toISOString().slice(0, 10);
  const ctx = await flowTranslation(
    orgId,
    result.rows.map((r) => ({ func: r.func ?? null, date: today })),
  );
  let total = "0";
  for (const r of result.rows) {
    total = add(total, translateFlowAmount(String(r.committed ?? 0), r.func ?? null, today, ctx.rateAt));
  }
  return normalizeMoney(total);
}

