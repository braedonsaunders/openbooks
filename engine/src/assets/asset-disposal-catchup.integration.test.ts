import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { AssetLifecycleError, disposeAsset } from "./asset-lifecycle.ts";
import { buildSchedule, runDepreciation } from "./depreciation.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
} from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

async function seedInServiceAsset(
  org: { orgId: string; subsidiaryId: string; accounts: Record<string, string> },
  actorId: string,
  tag: string,
) {
  const orgId = org.orgId;
  const categoryId = randomUUID();
  const assetId = randomUUID();
  await db.execute(sql`
    insert into asset_categories
      (id, org_id, name, asset_account_id, accumulated_depreciation_account_id,
       depreciation_expense_account_id, gain_loss_account_id,
       default_method, default_life_months, default_convention,
       tax_attributes, is_active, created_by, updated_by)
    values
      (${categoryId}, ${orgId}, 'Catch-up equipment',
       ${org.accounts.invAsset}, ${org.accounts.clearing},
       ${org.accounts.adjustment}, ${org.accounts.adjustment},
       'straight_line', 10, 'full_month', '{}'::jsonb, true, ${actorId}, ${actorId})
  `);
  await db.execute(sql`
    insert into fixed_assets
      (id, org_id, subsidiary_id, category_id, asset_number, name, status,
       acquired_on, in_service_on, acquisition_cost, salvage_value,
       depreciation_method, useful_life_months, depreciation_convention,
       custom, created_by, updated_by)
    values
      (${assetId}, ${orgId}, ${org.subsidiaryId}, ${categoryId}, ${tag},
       'Catch-up asset', 'in_service',
       '2026-07-15', '2026-07-15', 1000, 0, 'straight_line', 10,
       'full_month', '{}'::jsonb, ${actorId}, ${actorId})
  `);
  await buildSchedule(assetId, orgId, actorId);
  return { assetId, bank: org.accounts.bank };
}

test(
  "disposing with zero prior runs refuses while an ended period sits unposted, then succeeds after the catch-up run",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const { assetId, bank } = await seedInServiceAsset(org, actorId, "CATCHUP-DISP");
    try {
      // July ended with its 100.00 plan line still unposted and no run has
      // ever posted: the old stub guard needs a posted trail to fire, so
      // without the due-unposted rule this disposal would book NBV 1000.
      await assert.rejects(
        disposeAsset(org.orgId, assetId, {
          proceeds: "850",
          proceedsAccountId: bank,
          date: "2026-07-31",
          actorId,
        }),
        (error: unknown) =>
          error instanceof AssetLifecycleError &&
          /unposted depreciation/.test(error.message) &&
          /2026-07/.test(error.message) &&
          /post the depreciation run/.test(error.message),
        "disposal with an ended-but-unposted period is refused naming the period",
      );

      // The explicit operator choice: post the catch-up first, then dispose.
      assert.equal((await runDepreciation(org.orgId, "2026-07-31", actorId, assetId)).totalAmount, "100.0000");
      const disposal = await disposeAsset(org.orgId, assetId, {
        proceeds: "850",
        proceedsAccountId: bank,
        date: "2026-07-31",
        actorId,
      });
      assert.equal(disposal.nbv, "900.0000");
      assert.equal(disposal.gainLoss, "-50.0000");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
