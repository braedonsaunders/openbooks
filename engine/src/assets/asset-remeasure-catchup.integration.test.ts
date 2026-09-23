import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { AssetLifecycleError, remeasureAsset } from "./asset-lifecycle.ts";
import { buildSchedule, runDepreciation } from "./depreciation.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
} from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test(
  "remeasuring refuses while an ended period sits unposted, then measures off the posted carrying value",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const categoryId = randomUUID();
    const assetId = randomUUID();
    try {
      await db.execute(sql`
        insert into asset_categories
          (id, org_id, name, asset_account_id, accumulated_depreciation_account_id,
           depreciation_expense_account_id, gain_loss_account_id,
           default_method, default_life_months, default_convention,
           tax_attributes, is_active, created_by, updated_by)
        values
          (${categoryId}, ${org.orgId}, 'Catch-up equipment',
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
          (${assetId}, ${org.orgId}, ${org.subsidiaryId}, ${categoryId}, 'CATCHUP-REMEAS',
           'Catch-up asset', 'in_service',
           '2026-07-15', '2026-07-15', 1000, 0, 'straight_line', 10,
           'full_month', '{}'::jsonb, ${actorId}, ${actorId})
      `);
      await buildSchedule(assetId, org.orgId, actorId);

      // July ended with its charge unposted: measuring off posted-only
      // carrying value (1000) would understate the impairment by 100.
      await assert.rejects(
        remeasureAsset(org.orgId, assetId, {
          newCarryingValue: "800",
          date: "2026-07-31",
          actorId,
        }),
        (error: unknown) =>
          error instanceof AssetLifecycleError &&
          /unposted depreciation/.test(error.message) &&
          /2026-07/.test(error.message),
        "remeasure with an ended-but-unposted period is refused naming the period",
      );

      assert.equal((await runDepreciation(org.orgId, "2026-07-31", actorId, assetId)).totalAmount, "100.0000");
      const impairment = await remeasureAsset(org.orgId, assetId, {
        newCarryingValue: "800",
        date: "2026-07-31",
        actorId,
      });
      assert.equal(impairment.kind, "impaired");
      assert.equal(impairment.delta, "-100.0000");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
