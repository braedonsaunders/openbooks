import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  buildSchedule,
  DepreciationRefusalError,
  recordDepreciationInput,
} from "./depreciation.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
} from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test(
  "schedule builds and depreciation inputs enforce the subsidiary scope inside their locks",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const categoryId = randomUUID();
    const assetId = randomUUID();
    const foreignSubId = randomUUID();
    try {
      await db.execute(sql`
        insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
        values (${foreignSubId}, ${org.orgId}, ${org.subsidiaryId}, 'Restricted holder', 'CAD', 'CA')
      `);
      await db.execute(sql`
        insert into asset_categories
          (id, org_id, name, asset_account_id, accumulated_depreciation_account_id,
           depreciation_expense_account_id, gain_loss_account_id,
           default_method, default_life_months, default_convention,
           tax_attributes, is_active, created_by, updated_by)
        values
          (${categoryId}, ${org.orgId}, 'Scoped equipment',
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
          (${assetId}, ${org.orgId}, ${org.subsidiaryId}, ${categoryId}, 'SCOPED-BUILD',
           'Scoped asset', 'in_service',
           '2026-07-15', '2026-07-15', 1000, 0, 'straight_line', 10,
           'full_month', '{}'::jsonb, ${actorId}, ${actorId})
      `);

      // A scope excluding the asset's subsidiary refuses inside the locked
      // build — the route's visibility precheck alone would race a concurrent
      // PATCH moving the asset across subsidiaries.
      await assert.rejects(
        buildSchedule(assetId, org.orgId, actorId, org.bookId, [foreignSubId]),
        (error: unknown) =>
          error instanceof DepreciationRefusalError &&
          /outside your subsidiary scope/.test(error.message),
        "an out-of-scope schedule build is refused",
      );
      // Positive control: the owning scope still builds.
      const built = await buildSchedule(assetId, org.orgId, actorId, org.bookId, [org.subsidiaryId]);
      assert.ok(built.lineCount > 0, "the owning scope builds the schedule");

      // With a schedule in place, an input carrying a scope that excludes the
      // asset's subsidiary refuses against the locked row — the shape a
      // concurrent cross-subsidiary PATCH would otherwise slip through.
      await assert.rejects(
        recordDepreciationInput({
          orgId: org.orgId,
          assetId,
          effectiveDate: "2026-07-15",
          kind: "manual",
          value: "10",
          memo: "scope probe",
          evidenceFileId: randomUUID(),
          actorId,
          allowedSubsidiaryIds: [foreignSubId],
        }),
        (error: unknown) =>
          error instanceof DepreciationRefusalError &&
          /outside your subsidiary scope/.test(error.message),
        "an out-of-scope depreciation input is refused",
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
