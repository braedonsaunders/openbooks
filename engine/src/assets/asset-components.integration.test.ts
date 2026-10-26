import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrgContext } from "../platform/db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  grantScratchPermissions,
  seedFlowActors,
  seedPostingAccount,
} from "../testing/fixtures.ts";
import { AssetRefusal } from "./asset-refusal.ts";
import {
  attachAssetComponent,
  createAssetComponent,
  detachAssetComponent,
  disposeCompoundAsset,
  loadCompoundAsset,
} from "./asset-components.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

type Org = Awaited<ReturnType<typeof createScratchOrg>>;

async function refusedWith(code: string, run: () => Promise<unknown>): Promise<void> {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof AssetRefusal, `expected AssetRefusal ${code}, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
}

async function setup(org: Org) {
  const actors = await seedFlowActors(org.orgId);
  await grantScratchPermissions(org.orgId, actors.adminId, ["assets.manage"]);
  return withOrgContext(org.orgId, async () => {
    await db.execute(sql`
      update orgs set settings = jsonb_set(settings, '{features}',
        coalesce(settings->'features', '{}'::jsonb) || '{"assetComponents": true}'::jsonb)
       where id = ${org.orgId}`);
    const vehicles = await seedPostingAccount(org.orgId, "1620", "Vehicles", "asset_fixed");
    const accumulated = await seedPostingAccount(
      org.orgId,
      "1629",
      "Accumulated depreciation — vehicles",
      "asset_fixed",
    );
    const depreciation = await seedPostingAccount(
      org.orgId,
      "6120",
      "Depreciation — vehicles",
      "expense",
    );
    const gainLoss = await seedPostingAccount(
      org.orgId,
      "7100",
      "Gain or loss on disposal",
      "expense_other",
    );
    const categoryId = randomUUID();
    await db.execute(sql`
      insert into asset_categories
        (id, org_id, name, asset_account_id, accumulated_depreciation_account_id, depreciation_expense_account_id,
         gain_loss_account_id, default_method, default_life_months, default_convention, tax_attributes, is_active)
      values (${categoryId}, ${org.orgId}, 'Vehicles', ${vehicles}, ${accumulated}, ${depreciation}, ${gainLoss},
              'straight_line', 60, 'full_month', '{}'::jsonb, true)`);
    const asset = async (number: string, cost: string, subsidiaryId = org.subsidiaryId) => {
      const id = randomUUID();
      await db.execute(sql`
        insert into fixed_assets
          (id, org_id, subsidiary_id, category_id, asset_number, name, status, acquired_on, in_service_on,
           acquisition_cost, salvage_value, depreciation_method, useful_life_months, depreciation_convention, custom,
           created_by, updated_by)
        values (${id}, ${org.orgId}, ${subsidiaryId}, ${categoryId}, ${number}, ${number}, 'in_service', '2026-07-01', '2026-07-01',
                ${cost}, 0, 'straight_line', 60, 'full_month', '{}'::jsonb, ${actors.adminId}, ${actors.adminId})`);
      return id;
    };
    return { actors, categoryId, vehicles, gainLoss, asset };
  });
}

test(
  "a compound asset rolls up its components and refuses cycles, nesting and cross-entity members",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const { actors, asset, categoryId } = await setup(org);
      const truck = await asset("TRUCK", "60000");
      const engine = await asset("ENGINE", "15000");
      const crane = await asset("CRANE", "25000");
      await attachAssetComponent(org.orgId, {
        parentAssetId: truck,
        componentAssetId: engine,
        actorId: actors.adminId,
      });
      await attachAssetComponent(org.orgId, {
        parentAssetId: truck,
        componentAssetId: engine,
        actorId: actors.adminId,
      });
      await refusedWith("component_self", () =>
        attachAssetComponent(org.orgId, {
          parentAssetId: crane,
          componentAssetId: crane,
          actorId: actors.adminId,
        }),
      );
      await refusedWith("component_cycle", () =>
        attachAssetComponent(org.orgId, {
          parentAssetId: engine,
          componentAssetId: truck,
          actorId: actors.adminId,
        }),
      );
      await refusedWith("component_nesting", () =>
        attachAssetComponent(org.orgId, {
          parentAssetId: engine,
          componentAssetId: crane,
          actorId: actors.adminId,
        }),
      );
      await refusedWith("permission_required", () =>
        attachAssetComponent(org.orgId, {
          parentAssetId: truck,
          componentAssetId: crane,
          actorId: actors.outsiderId,
        }),
      );

      const otherSubsidiary = randomUUID();
      await withOrgContext(org.orgId, () =>
        db.execute(sql`
        insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
        values (${otherSubsidiary}, ${org.orgId}, ${org.subsidiaryId}, 'Second Co', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`),
      );
      const foreign = await asset("FOREIGN", "1000", otherSubsidiary);
      await refusedWith("component_cross_subsidiary", () =>
        attachAssetComponent(org.orgId, {
          parentAssetId: truck,
          componentAssetId: foreign,
          actorId: actors.adminId,
        }),
      );
      // The database refuses the same shape even for a direct write.
      await assert.rejects(
        withOrgContext(org.orgId, () =>
          db.execute(sql`
        update fixed_assets set parent_asset_id = ${truck} where org_id = ${org.orgId} and id = ${foreign}`),
        ),
      );

      const created = await createAssetComponent(org.orgId, {
        parentAssetId: truck,
        actorId: actors.adminId,
        name: "Liftgate",
        categoryId,
        acquisitionCost: "5000.00",
      });
      const view = await loadCompoundAsset(org.orgId, engine);
      assert.ok(view);
      assert.equal(view.parent.id, truck, "a component's view is its parent's family");
      assert.deepEqual(
        view.members.map((member) => member.assetNumber).sort(),
        [created.assetNumber, "ENGINE", "TRUCK"].sort(),
      );
      const primary = view.rollup.find((book) => book.isPrimary);
      assert.equal(primary?.cost, "80000.0000");
      assert.equal(primary?.assets, 3);

      await refusedWith("reason_required", () =>
        detachAssetComponent(org.orgId, {
          componentAssetId: engine,
          reason: " ",
          actorId: actors.adminId,
        }),
      );
      await detachAssetComponent(org.orgId, {
        componentAssetId: engine,
        reason: "Engine sold separately",
        actorId: actors.adminId,
      });
      const after = await loadCompoundAsset(org.orgId, truck);
      assert.equal(after?.members.length, 2);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "disposing the parent disposes every live component in one transaction and refuses with a draft member",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const { actors, asset, categoryId, vehicles } = await setup(org);
      const truck = await asset("TRUCK-2", "60000");
      const engine = await asset("ENGINE-2", "15000");
      await attachAssetComponent(org.orgId, {
        parentAssetId: truck,
        componentAssetId: engine,
        actorId: actors.adminId,
      });
      const draft = await createAssetComponent(org.orgId, {
        parentAssetId: truck,
        actorId: actors.adminId,
        name: "Unplaced toolbox",
        categoryId,
        acquisitionCost: "500",
      });
      await refusedWith("component_draft", () =>
        disposeCompoundAsset(org.orgId, {
          parentAssetId: truck,
          date: "2026-07-01",
          writeOff: true,
          reason: "Total loss",
          actorId: actors.adminId,
        }),
      );
      const statuses = await withOrgContext(org.orgId, () =>
        db.execute<{ status: string }>(
          sql`
        select distinct status from fixed_assets where org_id = ${org.orgId} and id in (${truck}, ${engine})`,
          "objects",
        ),
      );
      assert.deepEqual(statuses, [{ status: "in_service" }], "a refusal disposes nothing");

      await detachAssetComponent(org.orgId, {
        componentAssetId: draft.id,
        reason: "Not part of the truck",
        actorId: actors.adminId,
      });
      const result = await disposeCompoundAsset(org.orgId, {
        parentAssetId: truck,
        date: "2026-07-01",
        writeOff: true,
        reason: "Total loss",
        actorId: actors.adminId,
      });
      assert.deepEqual(
        result.disposals.map((disposal) => disposal.status),
        ["written_off", "written_off"],
      );
      assert.equal(result.disposals.at(-1)?.assetId, truck, "the parent closes last");
      const vehiclesBalance = (
        await withOrgContext(org.orgId, () =>
          db.execute<{ total: string }>(
            sql`
        select coalesce(sum(amount), 0)::numeric(19,4)::text as total from journal_lines where org_id = ${org.orgId} and account_id = ${vehicles}`,
            "objects",
          ),
        )
      )[0]!.total;
      assert.equal(
        vehiclesBalance,
        "-75000.0000",
        "both costs are derecognized from the vehicles account",
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
