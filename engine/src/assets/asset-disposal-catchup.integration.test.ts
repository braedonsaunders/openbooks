import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { disposeAsset } from "./asset-lifecycle.ts";
import { buildSchedule } from "./depreciation.ts";
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
  "disposing with zero prior runs stays open and books NBV off posted-to-date",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const { assetId, bank } = await seedInServiceAsset(org, actorId, "CATCHUP-DISP");
    try {
      // Deliberate exception (e7944aea3), restored: with zero prior runs
      // there is no posted trail to leapfrog, so the stub tie cannot fire
      // and the disposal stays open. July's 100.00 plan line remains
      // unposted; NBV is cost less posted-to-date (1000), not the
      // schedule-tied 900 a catch-up run would produce.
      const disposal = await disposeAsset(org.orgId, assetId, {
        proceeds: "850",
        proceedsAccountId: bank,
        date: "2026-07-31",
        actorId,
      });
      assert.equal(disposal.nbv, "1000.0000");
      assert.equal(disposal.gainLoss, "-150.0000");
      assert.equal(disposal.status, "disposed");
      const july = (await db.execute<{ posted: string | null }>(sql`
        select l.posted_amount::text as posted
          from depreciation_schedule_lines l
          join depreciation_schedules s on s.id = l.schedule_id and s.org_id = l.org_id
         where l.org_id = ${org.orgId} and s.asset_id = ${assetId}`)).rows;
      assert.ok(july.length > 0 && july.every((line) => line.posted === null));
      const balance = (await db.execute<{ total: string }>(sql`
        select coalesce(sum(l.amount), 0)::text as total
          from journal_lines l
          join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
         where l.org_id = ${org.orgId} and e.id = ${disposal.entryId}`)).rows[0]!;
      assert.equal(balance.total, "0.0000");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
