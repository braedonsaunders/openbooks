import { sql } from "drizzle-orm";
import { db } from "./db.ts";

/**
 * Seed the expense-report approval policy:
 *   npx tsx engine/src/seed-expense-policy.ts
 *
 * For every org: create an active approval_policies row for target_kind
 * 'expense_report' with a single controller step (mirrors the vendor-bill
 * routing — every report goes to the controller regardless of amount).
 *
 * Idempotent — orgs that already have an active expense_report policy are
 * left untouched, so custom routing survives re-runs.
 */

const RULES = [{ step: 1, minAmount: 0, approverRole: "controller" }];

const orgs = (await db.execute(sql`select id, name from orgs order by created_at`)) as unknown as {
  rows: { id: string; name: string }[];
};
if (orgs.rows.length === 0) {
  console.error("no orgs found — seed an org before seeding approval policies");
  process.exit(1);
}

for (const org of orgs.rows) {
  const existing = (await db.execute(sql`
    select id from approval_policies
     where org_id = ${org.id} and target_kind = 'expense_report' and is_active
  `)) as unknown as { rows: { id: string }[] };
  if (existing.rows[0]) {
    console.log(`org "${org.name}": active expense_report policy already exists — skipped`);
    continue;
  }
  await db.execute(sql`
    insert into approval_policies (org_id, name, target_kind, rules, is_active)
    values (${org.id}, 'Expense report approval', 'expense_report', ${JSON.stringify(RULES)}, true)
  `);
  console.log(`org "${org.name}": expense_report approval policy created (controller step)`);
}
process.exit(0);
