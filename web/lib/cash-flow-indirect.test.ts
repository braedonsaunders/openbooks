import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { env } from "@openbooks/engine/src/db.ts";

test("indirect cash flow ties to bank balances and net income", { skip: !env.OPENBOOKS_DB_URL }, () => {
  // Web report modules intentionally import `server-only`, so the contract
  // runs in React's server condition (same pattern as reports-posted.test.ts).
  const source = `
    import assert from "node:assert/strict";
    import { sql } from "drizzle-orm";
    import { db, withOrg } from "./engine/src/db.ts";
    import { toUnits } from "./engine/src/money.ts";
    import { cashFlowIndirect, financialTrends } from "./web/lib/reports.ts";

    // Persistent application tenants only — scratch orgs come and go in
    // parallel test files and would race fixture teardown.
    const orgs = await db.execute(sql\`
      select o.id from orgs o
       where exists (select 1 from users u where u.org_id = o.id and u.is_active)
       order by o.id
    \`);
    for (const org of orgs.rows) {
      await withOrg(org.id, async () => {
        const trends = await financialTrends(org.id, 15);
        for (const period of trends) {
          const cf = await cashFlowIndirect(period.starts_on, period.ends_on);

          // The statement reconciles to the proven bank-balance movement.
          assert.ok(
            Math.abs(cf.reconciliationGap) < 0.005,
            org.id + " " + period.name + " reconciliation gap " + cf.reconciliationGap,
          );

          // Sections assemble to the net change.
          const assembled = cf.operating + cf.investingTotal + cf.financingTotal + cf.fxEffectOnCash;
          assert.ok(Math.abs(assembled - cf.netChange) < 0.005, org.id + " " + period.name + " section assembly");

          // Opening + change = closing.
          assert.ok(
            Math.abs(cf.openingCash + cf.netChange - cf.closingCash) < 0.01,
            org.id + " " + period.name + " opening/closing tie",
          );

          // Net income is the posted P&L of the window, no more and no less.
          const expected = await db.execute(sql\`
            select coalesce(-sum(l.amount), 0)::text as ni
              from journal_lines l
              join journal_entries e on e.id = l.entry_id and e.status = 'posted'
              join accounts a on a.id = l.account_id
             where l.org_id = \${org.id}
               and a.type in ('income','income_other','cogs','expense','expense_other','expense_deferred')
               and e.posting_date >= \${period.starts_on} and e.posting_date <= \${period.ends_on}
          \`);
          assert.equal(
            toUnits(cf.netIncome.toFixed(4)),
            toUnits(expected.rows[0].ni),
            org.id + " " + period.name + " net income",
          );

          // Operating = NI + adjustments + working capital (line arithmetic).
          const op =
            cf.netIncome +
            cf.adjustments.reduce((a, l) => a + l.amount, 0) +
            cf.workingCapital.reduce((a, l) => a + l.amount, 0);
          assert.ok(Math.abs(op - cf.operating) < 0.005, org.id + " " + period.name + " operating arithmetic");
        }
      });
    }
  `;
  const result = spawnSync(
    process.execPath,
    ["--conditions=react-server", "--import", "tsx", "--input-type=module", "-e", source],
    { cwd: process.cwd(), env: process.env, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
