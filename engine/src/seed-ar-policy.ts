import { sql } from "drizzle-orm";
import { db } from "./db.ts";

/**
 * Seed the AR approval policy:
 *   npx tsx engine/src/seed-ar-policy.ts
 *
 * For every org: create an active approval_policies row for target_kind
 * 'customer_invoice' (single controller step, every amount) unless the org
 * already has an active policy for that kind. Idempotent — existing policies
 * are never modified.
 */

const RULES = [{ step: 1, minAmount: 0, approverRole: "controller" }];

const orgs = (await db.execute(sql`select id, name from orgs order by created_at`)) as any;
if (orgs.rows.length === 0) {
  console.error("no orgs found — seed an org before seeding the AR approval policy");
  process.exit(1);
}

for (const org of orgs.rows) {
  const existing = (await db.execute(sql`
    select id from approval_policies
     where org_id = ${org.id} and target_kind = 'customer_invoice' and is_active
  `)) as any;
  if (existing.rows.length > 0) {
    console.log(`org "${org.name}": active customer_invoice policy already present — skipped`);
    continue;
  }
  await db.execute(sql`
    insert into approval_policies (org_id, name, target_kind, rules, is_active)
    values (${org.id}, 'Customer invoice approval', 'customer_invoice', ${JSON.stringify(RULES)}, true)
  `);
  console.log(`org "${org.name}": customer_invoice approval policy created (controller step)`);
}
process.exit(0);
