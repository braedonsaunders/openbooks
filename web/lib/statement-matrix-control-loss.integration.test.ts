import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only")
      return { shortCircuit: true, url: "data:text/javascript,export {}" };
    return next(specifier, context);
  },
});
const { sql } = await import("drizzle-orm");
const { db, env, withBypass, withOrgContext } =
  await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, dropScratchOrg } =
  await import("@openbooks/engine/src/testing/fixtures.ts");
const { statementMatrix } = await import("./statement-matrix");
import type { StatementSubsidiaryContext } from "./statement-matrix";

test(
  "disposed foreign subsidiary retains pre-disposal income and frozen balances without future rates",
  { skip: !env.OPENBOOKS_DB_URL },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    try {
      const child = randomUUID(),
        equity = randomUUID();
      await withBypass(async () => {
        await db.execute(
          sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country,is_active,is_elimination) values(${child},${org.orgId},${org.subsidiaryId},'Disposed foreign entity','USD','US',true,false)`,
        );
        await db.execute(
          sql`insert into accounts(id,org_id,number,name,type,is_active,is_summary) values(${equity},${org.orgId},'LOSS-EQ','Historic equity','equity',true,false)`,
        );
        for (const [date, amount, credit] of [
          ["2026-07-01", "1000", equity],
          ["2026-07-15", "100", org.accounts.revenue],
          ["2026-07-25", "900", org.accounts.revenue],
        ]) {
          const id = randomUUID();
          await db.execute(
            sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin) values(${id},${org.orgId},${org.bookId},${child},${id},${date},${org.periodId},'draft','manual')`,
          );
          await db.execute(
            sql`insert into journal_lines(org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate) values(${org.orgId},${id},1,${org.accounts.bank},${child},${amount},'USD',${amount},1),(${org.orgId},${id},2,${credit},${child},-${amount}::numeric,'USD',-${amount}::numeric,1)`,
          );
          await db.execute(
            sql`update journal_entries set status='posted',posted_at=now() where org_id=${org.orgId} and id=${id}`,
          );
        }
      });
      const subsidiary: StatementSubsidiaryContext = {
        ids: [org.subsidiaryId, child],
        rates: [
          {
            subsidiaryId: child,
            currency: "USD",
            periodFrom: "2026-07-01",
            periodTo: "2026-07-31",
            averageRate: "1.2",
            currentRate: "1.3",
            historicalRate: "0.9",
          },
        ],
        controlLosses: [
          {
            subsidiaryId: child,
            through: "2026-07-20",
            closingRate: "1.1",
            factor: "1",
          },
        ],
      };
      await withBypass(() =>
        withOrgContext(org.orgId, async () => {
          const flow = await statementMatrix({
            orgId: org.orgId,
            types: ["income"],
            mode: "flow",
            period: { from: "2026-07-01", to: "2026-08-31" },
            periodLabel: "Through August",
            subsidiary,
          });
          assert.deepEqual(
            flow.rows.find((r) => r.id === org.accounts.revenue)?.values,
            ["120.0000"],
          );
          const later = await statementMatrix({
            orgId: org.orgId,
            types: ["income"],
            mode: "flow",
            period: { from: "2026-08-01", to: "2026-08-31" },
            periodLabel: "August",
            subsidiary,
          });
          assert.ok(
            !later.rows.find((r) => r.id === org.accounts.revenue) ||
              later.rows
                .find((r) => r.id === org.accounts.revenue)!
                .values.every((value) => value === "0.0000"),
          );
          const balance = await statementMatrix({
            orgId: org.orgId,
            types: ["asset_bank", "equity"],
            mode: "balance",
            period: { from: "2026-08-01", to: "2026-08-31" },
            periodLabel: "August",
            subsidiary,
          });
          assert.deepEqual(
            balance.rows.find((r) => r.id === org.accounts.bank)?.values,
            ["1210.0000"],
          );
          assert.deepEqual(balance.rows.find((r) => r.id === equity)?.values, [
            "900.0000",
          ]);
          // A comparative before disposal still translates using its own period.
          const before = await statementMatrix({
            orgId: org.orgId,
            types: ["asset_bank"],
            mode: "balance",
            period: { from: "2026-07-01", to: "2026-07-10" },
            periodLabel: "Before sale",
            subsidiary,
          });
          assert.deepEqual(
            before.rows.find((r) => r.id === org.accounts.bank)?.values,
            ["1300.0000"],
          );
          // Missing pre-disposal history must still refuse; a cutoff is no waiver.
          await assert.rejects(
            () =>
              statementMatrix({
                orgId: org.orgId,
                types: ["income"],
                mode: "flow",
                period: { from: "2026-06-01", to: "2026-08-31" },
                periodLabel: "Missing June",
                subsidiary,
              }),
            /exchange rates/,
          );
        }),
      );
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);
