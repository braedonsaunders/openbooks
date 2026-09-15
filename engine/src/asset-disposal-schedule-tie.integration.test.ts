import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { disposeAsset, AssetLifecycleError } from "./asset-lifecycle.ts";
import { buildSchedule, runDepreciation } from "./depreciation.ts";
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * A disposal must tie to the depreciation schedule: the asset held through
 * August has August's planned charge in its carrying amount before the
 * gain or loss is struck. Disposing mid-period with the stub period's plan
 * line still unposted used to book NBV 900 on a $1,000 asset with $100
 * posted — turning a $50 gain (proceeds $850 against NBV $800) into a $50
 * loss. The disposal now refuses while a planned-but-unposted line covers
 * the disposal date; posting the period first restores the tie.
 */
test(
  "disposing with the stub period unposted is refused; posting it first ties NBV to the schedule",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = (await seedFlowActors(org.orgId)).adminId;
      const calendarId = (await db.execute<{ id: string }>(sql`
        select fiscal_calendar_id as id from accounting_periods where id = ${org.periodId}`)).rows[0]!.id;
      for (let i = 1; i < 10; i++) {
        const start = new Date(Date.UTC(2026, 6 + i, 1));
        const end = new Date(Date.UTC(2026, 7 + i, 0));
        await db.execute(sql`insert into accounting_periods
          (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
          values (${randomUUID()}, ${org.orgId}, ${start.getUTCFullYear()}, ${start.getUTCMonth() + 1},
                  ${start.toISOString().slice(0, 7)}, ${start.toISOString().slice(0, 10)},
                  ${end.toISOString().slice(0, 10)}, false, ${calendarId})`);
      }
      const categoryId = randomUUID();
      const assetId = randomUUID();
      await db.execute(sql`insert into asset_categories
        (id, org_id, name, asset_account_id, accumulated_depreciation_account_id,
         depreciation_expense_account_id, gain_loss_account_id,
         default_method, default_life_months, default_convention)
        values (${categoryId}, ${org.orgId}, 'Audit equipment', ${org.accounts.invAsset},
                ${org.accounts.clearing}, ${org.accounts.adjustment}, ${org.accounts.adjustment},
                'straight_line', 10, 'full_month')`);
      await db.execute(sql`insert into fixed_assets
        (id, org_id, subsidiary_id, category_id, asset_number, name, status, acquired_on, in_service_on,
         acquisition_cost, salvage_value, depreciation_method, useful_life_months, depreciation_convention)
        values (${assetId}, ${org.orgId}, ${org.subsidiaryId}, ${categoryId}, 'AUDIT-DISP-1', 'Audit asset',
                'in_service', ${org.date}, ${org.date}, 1000, '0', 'straight_line', 10, 'full_month')`);
      await buildSchedule(assetId, org.orgId, actorId, org.bookId);
      assert.equal(
        (await runDepreciation(org.orgId, "2026-07-31", actorId, assetId)).totalAmount,
        "100.0000",
      );

      // Mid-August, August's 100.00 plan line still unposted: refuse, naming the period.
      await assert.rejects(
        disposeAsset(org.orgId, assetId, {
          proceeds: "850", proceedsAccountId: org.accounts.bank, date: "2026-08-15", actorId,
        }),
        (error: unknown) =>
          error instanceof AssetLifecycleError &&
          /unposted depreciation|stub period|2026-08/i.test(error.message),
        "disposal with the stub period unposted is refused",
      );

      // Post August, then dispose at month-end: NBV 800, proceeds 850, a 50.00 gain.
      assert.equal(
        (await runDepreciation(org.orgId, "2026-08-31", actorId, assetId)).totalAmount,
        "100.0000",
      );
      const disposal = await disposeAsset(org.orgId, assetId, {
        proceeds: "850", proceedsAccountId: org.accounts.bank, date: "2026-08-31", actorId,
      });
      assert.equal(disposal.nbv, "800.0000");
      assert.equal(disposal.gainLoss, "50.0000");
      assert.equal(disposal.status, "disposed");
      const gl = (await db.execute<{ accountId: string; amount: string }>(sql`
        select l.account_id as "accountId", l.amount::text as amount
          from journal_lines l
          join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
         where l.org_id = ${org.orgId} and e.id = ${disposal.entryId}
         order by l.line_number`));
      assert.deepEqual(
        gl.rows.map((r) => [r.accountId, r.amount]),
        [
          [org.accounts.invAsset, "-1000.0000"],
          [org.accounts.clearing, "200.0000"],
          [org.accounts.bank, "850.0000"],
          [org.accounts.adjustment, "-50.0000"],
        ],
        "disposal clears cost and accumulated, books proceeds, and credits the gain",
      );
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);
