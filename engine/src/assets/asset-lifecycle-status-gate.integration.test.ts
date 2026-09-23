import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  AssetLifecycleError,
  assertAssetLifecycleOperable,
  disposeAsset,
  remeasureAsset,
} from "./asset-lifecycle.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
} from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test("the lifecycle status gate is exhaustive: only in-service assets operate", () => {
  assertAssetLifecycleOperable("in_service", "A-1", "dispose");
  assertAssetLifecycleOperable("fully_depreciated", "A-1", "remeasure");
  for (const status of ["draft", "disposed", "written_off", "archived", ""]) {
    assert.throws(
      () => assertAssetLifecycleOperable(status, "A-1", "dispose"),
      (error: unknown) =>
        error instanceof AssetLifecycleError &&
        /A-1/.test(error.message) &&
        new RegExp(status || "status").test(error.message),
      `status ${status || "<empty>"} must refuse`,
    );
  }
  assert.throws(
    () => assertAssetLifecycleOperable("draft", "A-9", "remeasure"),
    (error: unknown) =>
      error instanceof AssetLifecycleError &&
      /A-9/.test(error.message) &&
      /in service/.test(error.message),
    "a draft asset must be told to place it in service first",
  );
});

test(
  "a draft asset can be neither disposed nor remeasured, and posts nothing",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const categoryId = randomUUID();
    const assetId = randomUUID();
    try {
      await db.execute(sql`
        insert into asset_categories
          (id, org_id, name, asset_account_id,
           accumulated_depreciation_account_id,
           depreciation_expense_account_id, gain_loss_account_id,
           default_method, default_life_months, default_convention,
           tax_attributes, is_active, created_by, updated_by)
        values
          (${categoryId}, ${org.orgId}, 'Draft equipment',
           ${org.accounts.invAsset}, ${org.accounts.clearing},
           ${org.accounts.adjustment}, ${org.accounts.adjustment},
           'straight_line', 10, 'full_month', '{}'::jsonb, true,
           ${actorId}, ${actorId})
      `);
      await db.execute(sql`
        insert into fixed_assets
          (id, org_id, subsidiary_id, category_id, asset_number, name, status,
           acquired_on, in_service_on, acquisition_cost, salvage_value,
           depreciation_method, useful_life_months, depreciation_convention,
           custom, created_by, updated_by)
        values
          (${assetId}, ${org.orgId}, ${org.subsidiaryId}, ${categoryId},
           'ASSET-DRAFT-GATE', 'Draft asset', 'draft',
           ${org.date}, ${org.date}, 1000, 0, 'straight_line', 10,
           'full_month', '{}'::jsonb, ${actorId}, ${actorId})
      `);

      await assert.rejects(
        disposeAsset(org.orgId, assetId, {
          proceeds: "100",
          proceedsAccountId: org.accounts.bank,
          date: org.date,
          actorId,
        }),
        (error: unknown) =>
          error instanceof AssetLifecycleError &&
          /must be in service/.test(error.message) &&
          /draft/.test(error.message),
        "disposing a draft asset is refused",
      );
      await assert.rejects(
        remeasureAsset(org.orgId, assetId, {
          newCarryingValue: "900",
          date: org.date,
          actorId,
        }),
        (error: unknown) =>
          error instanceof AssetLifecycleError &&
          /must be in service/.test(error.message) &&
          /draft/.test(error.message),
        "remeasuring a draft asset is refused",
      );

      const status = (
        await db.execute<{ status: string }>(sql`
          select status from fixed_assets where id = ${assetId} and org_id = ${org.orgId}
        `)
      ).rows[0]!.status;
      assert.equal(status, "draft");
      const journals = (
        await db.execute(sql`
          select 1 from journal_entries e
            join asset_events v on v.journal_entry_id = e.id and v.org_id = e.org_id
           where v.org_id = ${org.orgId} and v.asset_id = ${assetId}
           limit 1
        `)
      ).rows;
      assert.equal(journals.length, 0, "no journals or events may exist for the refused draft");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
