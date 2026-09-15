import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { setPeriodLockState } from "./close.ts";
import {
  disposeAsset,
  remeasureAsset,
  reverseAssetLifecycleEvent,
} from "./asset-lifecycle.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
  type ScratchOrg,
} from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * Fraud probe, same class as the inventory close-period defect: asset
 * lifecycle events (disposals, remeasurements, reversals) post their GL legs
 * through raw draft→posted flips that never call the posting kernel. A
 * disposal or impairment backdated into a GL-closed period must fail fast
 * with a named AssetLifecycleError — not survive to the flip where only the
 * je_guard Postgres backstop refuses it with a raw driver error (HTTP 500).
 */

async function seedAsset(org: ScratchOrg, actorId: string, tag: string): Promise<string> {
  const categoryId = randomUUID();
  const assetId = randomUUID();
  await db.execute(sql`insert into asset_categories
    (id,org_id,name,asset_account_id,accumulated_depreciation_account_id,depreciation_expense_account_id,
     gain_loss_account_id,default_method,default_life_months,default_convention,tax_attributes,is_active)
    values(${categoryId},${org.orgId},${`Close equipment ${tag}`},${org.accounts.invAsset},${org.accounts.clearing},
      ${org.accounts.adjustment},${org.accounts.adjustment},'straight_line',10,'full_month','{}'::jsonb,true)`);
  await db.execute(sql`insert into fixed_assets
    (id,org_id,subsidiary_id,category_id,asset_number,name,status,acquired_on,in_service_on,acquisition_cost,
     salvage_value,depreciation_method,useful_life_months,depreciation_convention,custom,created_by,updated_by)
    values(${assetId},${org.orgId},${org.subsidiaryId},${categoryId},
      ${`ASSET-CLOSE-${tag}`},${`Close asset ${tag}`},'in_service',${org.date},${org.date},1000,0,'straight_line',10,'full_month',
      '{}'::jsonb,${actorId},${actorId})`);
  return assetId;
}

async function journalCount(orgId: string): Promise<number> {
  const r = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from journal_entries where org_id = ${orgId}`));
  return r.rows[0]!.n;
}

async function closeGl(org: ScratchOrg, actorId: string): Promise<void> {
  await setPeriodLockState({
    orgId: org.orgId,
    periodId: org.periodId,
    bookId: org.bookId,
    module: "gl",
    state: "closed",
    actorId,
    reason: "fraud probe: GL closed for the period",
  });
}

test("a GL-closed period refuses asset disposals dated inside it", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const assetId = await seedAsset(org, actorId, "disp");
    await closeGl(org, actorId);
    const before = await journalCount(org.orgId);
    await assert.rejects(
      disposeAsset(org.orgId, assetId, { writeOff: true, date: org.date, actorId }),
      /closed/i,
      "a disposal into a GL-closed period must be refused",
    );
    assert.equal(await journalCount(org.orgId), before, "refused disposal left GL residue");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a GL-closed period refuses asset remeasurements dated inside it", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const assetId = await seedAsset(org, actorId, "reme");
    await closeGl(org, actorId);
    const before = await journalCount(org.orgId);
    await assert.rejects(
      remeasureAsset(org.orgId, assetId, { newCarryingValue: "800", date: org.date, actorId }),
      /closed/i,
      "a remeasurement into a GL-closed period must be refused",
    );
    assert.equal(await journalCount(org.orgId), before, "refused remeasurement left GL residue");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a GL-closed period refuses asset reversals dated inside it", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const assetId = await seedAsset(org, actorId, "reve");
    // Dispose while the period is still open, then close it.
    await disposeAsset(org.orgId, assetId, { writeOff: true, date: org.date, actorId });
    const event = (await db.execute<{ id: string }>(sql`
      select id from asset_events where org_id = ${org.orgId} and asset_id = ${assetId}
       order by created_at desc limit 1`)).rows[0]!;
    await closeGl(org, actorId);
    const before = await journalCount(org.orgId);
    await assert.rejects(
      reverseAssetLifecycleEvent(org.orgId, event.id, {
        date: org.date,
        actorId,
        reason: "fraud probe: backdated asset reversal",
      }),
      /closed/i,
      "a reversal into a GL-closed period must be refused",
    );
    assert.equal(await journalCount(org.orgId), before, "refused reversal left GL residue");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
