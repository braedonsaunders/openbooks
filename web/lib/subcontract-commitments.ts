import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { normalizeMoney } from "@openbooks/engine/src/money.ts";

/**
 * Revised, unbilled vendor commitments that are not already represented by a
 * purchase order. Linked POs stay exclusively in the order rollup so the same
 * commitment can never be counted twice.
 */
export async function directSubcontractOpenCommitment(
  orgId: string,
  projectId: string,
): Promise<string> {
  const result = (await db.execute<{ committed: string | null }>(sql`
    select coalesce(sum(greatest(0,
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
  `));
  return normalizeMoney(result.rows[0]?.committed ?? "0");
}

