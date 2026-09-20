import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "../platform/db.ts";
import { buildSchedule, runDepreciation } from "./depreciation.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "../testing/fixtures.ts";

/**
 * F-t07-005: a mid-period Run depreciation posts nothing (the period has not
 * ended) and answers 200 with all-zero counters and an empty problems list —
 * no toast, no dialog, no path forward. The zero must explain itself: which
 * as-of date the run evaluated and the next due line with its period end.
 */
const DB = !!process.env.OPENBOOKS_DB_URL;

async function seedStraightLineAsset(
  orgId: string,
  subsidiaryId: string,
  accounts: { invAsset: string; clearing: string; adjustment: string },
): Promise<string> {
  const categoryId = randomUUID();
  const assetId = randomUUID();
  await db.execute(sql`insert into asset_categories
    (id, org_id, name, asset_account_id, accumulated_depreciation_account_id,
     depreciation_expense_account_id, default_method, default_life_months, default_convention,
     tax_attributes, is_active)
    values (${categoryId}, ${orgId}, 'Equipment', ${accounts.invAsset}, ${accounts.clearing},
            ${accounts.adjustment}, 'straight_line', 12, 'full_month', '{}'::jsonb, true)`);
  await db.execute(sql`insert into fixed_assets
    (id, org_id, subsidiary_id, category_id, asset_number, name, status, acquired_on, in_service_on,
     acquisition_cost, salvage_value, depreciation_method, useful_life_months, custom)
    values (${assetId}, ${orgId}, ${subsidiaryId}, ${categoryId}, 'NEXTDUE-1',
            'Mid-period asset', 'in_service', '2026-07-01', '2026-07-01',
            '12000.0000', '0.0000', 'straight_line', 12, '{}'::jsonb)`);
  return assetId;
}

test("a mid-period run names the next due line instead of an all-zero silence", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const seeded = await withBypassContext(async () => {
      const actorId = (await seedFlowActors(org.orgId)).adminId;
      const assetId = await seedStraightLineAsset(org.orgId, org.subsidiaryId, org.accounts);
      return { actorId, assetId };
    });
    // The scratch spine is July 2026 only: one mapped July line (12000 / 12),
    // later months stay beyond the calendared horizon.
    const built = await buildSchedule(seeded.assetId, org.orgId, seeded.actorId, org.bookId);
    assert.equal(built.lineCount, 1);

    // Mid-month the July period has not ended, so nothing posts — but the run
    // must say which as-of it ran for and what is next.
    const mid = await runDepreciation(org.orgId, "2026-07-15", seeded.actorId, seeded.assetId);
    assert.equal(mid.posted, 0);
    assert.equal(mid.skipped, 0);
    assert.deepEqual(mid.problems, []);
    assert.equal(mid.asOfDate, "2026-07-15");
    assert.ok(mid.nextDue, "expected the run to name the next due line");
    assert.equal(mid.nextDue.assetNumber, "NEXTDUE-1");
    assert.equal(mid.nextDue.endsOn, "2026-07-31");
    assert.equal(mid.nextDue.amount, "1000.0000");

    // Control: once the period ends the same line posts, so the engine rule
    // (post only ended periods) is intact — only the silence is fixed.
    const end = await runDepreciation(org.orgId, "2026-07-31", seeded.actorId, seeded.assetId);
    assert.equal(end.posted, 1);
    assert.equal(end.totalAmount, "1000.0000");

    // And with nothing left unposted there is no next line to name.
    const done = await runDepreciation(org.orgId, "2026-07-31", seeded.actorId, seeded.assetId);
    assert.equal(done.posted, 0);
    assert.equal(done.nextDue, null);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
