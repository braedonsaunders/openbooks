import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { disposeAsset, remeasureAsset, reverseAssetLifecycleEvent } from "./asset-lifecycle.ts";
import { db } from "./db.ts";
import { buildSchedule, recordDepreciationInput, runDepreciation } from "./depreciation.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "./test-fixtures.ts";

/**
 * Carrying-amount readers honour the continued (opening) accumulated
 * depreciation: disposal gain/loss, impairment delta, the IAS 36 restoration
 * ceiling, the fully-depreciated flip, disposal-reversal restore, and the
 * manual/usage evidence caps all measure off cost − opening − posted, never
 * off cost − posted alone.
 */
const DB = !!process.env.OPENBOOKS_DB_URL;

async function seedMonthlyPeriods(
  orgId: string,
  months: { n: number; name: string; from: string; to: string }[],
): Promise<void> {
  const cal = (await db.execute<{ id: string }>(sql`
    select fiscal_calendar_id as id from accounting_periods where org_id = ${orgId} limit 1`)).rows[0]!.id;
  for (const m of months) {
    await db.execute(sql`
      insert into accounting_periods
        (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
      values (${randomUUID()}, ${orgId}, 2026, ${m.n}, ${m.name}, ${m.from}, ${m.to}, false, ${cal})`);
  }
}

const MONTHS_2026 = [
  { n: 1, name: "2026-01", from: "2026-01-01", to: "2026-01-31" },
  { n: 2, name: "2026-02", from: "2026-02-01", to: "2026-02-28" },
  { n: 3, name: "2026-03", from: "2026-03-01", to: "2026-03-31" },
  { n: 4, name: "2026-04", from: "2026-04-01", to: "2026-04-30" },
  { n: 5, name: "2026-05", from: "2026-05-01", to: "2026-05-31" },
  { n: 6, name: "2026-06", from: "2026-06-01", to: "2026-06-30" },
  { n: 8, name: "2026-08", from: "2026-08-01", to: "2026-08-31" },
  { n: 9, name: "2026-09", from: "2026-09-01", to: "2026-09-30" },
  { n: 10, name: "2026-10", from: "2026-10-01", to: "2026-10-31" },
  { n: 11, name: "2026-11", from: "2026-11-01", to: "2026-11-30" },
  { n: 12, name: "2026-12", from: "2026-12-01", to: "2026-12-31" },
];

async function setFramework(orgId: string, framework: "us_gaap" | "ifrs"): Promise<void> {
  await db.execute(sql`
    update orgs set settings = settings || ${JSON.stringify({ reportingFramework: framework })}::jsonb
     where id = ${orgId}`);
}

/** Straight-line 120k/0/120mo from 2021-06-15 with a gain/loss account. */
async function seedOnboardedAsset(
  orgId: string,
  subsidiaryId: string,
  accounts: { invAsset: string; clearing: string; adjustment: string },
  opening: { amount: string; asOf: string },
  method: "straight_line" | "manual" = "straight_line",
): Promise<string> {
  const categoryId = randomUUID();
  const assetId = randomUUID();
  await db.execute(sql`insert into asset_categories
    (id, org_id, name, asset_account_id, accumulated_depreciation_account_id,
     depreciation_expense_account_id, gain_loss_account_id,
     default_method, default_life_months, default_convention,
     tax_attributes, is_active)
    values (${categoryId}, ${orgId}, 'Equipment', ${accounts.invAsset}, ${accounts.clearing},
            ${accounts.adjustment}, ${accounts.adjustment},
            ${method}, ${method === "manual" ? null : 120}, 'full_month', '{}'::jsonb, true)`);
  await db.execute(sql`insert into fixed_assets
    (id, org_id, subsidiary_id, category_id, asset_number, name, status, acquired_on, in_service_on,
     acquisition_cost, salvage_value, depreciation_method, useful_life_months,
     opening_accumulated_depreciation, opening_accumulated_as_of, custom)
    values (${assetId}, ${orgId}, ${subsidiaryId}, ${categoryId}, 'CARRY-1',
            'Mid-life asset', 'in_service', '2021-06-15', '2021-06-15',
            '120000.0000', '0.0000', ${method}, ${method === "manual" ? null : 120},
            ${opening.amount}, ${opening.asOf}, '{}'::jsonb)`);
  return assetId;
}

async function seedEvidence(orgId: string, assetId: string, actorId: string): Promise<string> {
  const folderId = randomUUID();
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      insert into folders (id, org_id, name, record_table, record_id, created_by, updated_by)
      values (${folderId}, ${orgId}, 'Asset evidence', 'fixed_assets', ${assetId}, ${actorId}, ${actorId})`);
    const fileId = (await tx.execute<{ id: string }>(sql`
      insert into files (org_id, folder_id, name, file_type, content_type, size_bytes, created_by, updated_by)
      values (${orgId}, ${folderId}, 'meter.pdf', 'pdf', 'application/pdf', 1, ${actorId}, ${actorId}) returning id`)).rows[0]!.id;
    await tx.execute(sql`
      insert into file_attachments (org_id, file_id, target_table, target_id, created_by)
      values (${orgId}, ${fileId}, 'fixed_assets', ${assetId}, ${actorId})`);
    return fileId;
  });
}

test("disposal settles against the continued carrying amount", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    await seedMonthlyPeriods(org.orgId, MONTHS_2026);
    const assetId = await seedOnboardedAsset(org.orgId, org.subsidiaryId, org.accounts, {
      amount: "55000.0000",
      asOf: "2025-12-31",
    });
    await buildSchedule(assetId, org.orgId, actorId, org.bookId);
    const run = await runDepreciation(org.orgId, "2026-03-31", actorId, assetId);
    assert.equal(run.totalAmount, "3000.0000");

    // NBV = 120000 − 55000 (opening) − 3000 (posted) = 62000.
    const disposal = await disposeAsset(org.orgId, assetId, {
      proceeds: "70000.0000",
      proceedsAccountId: org.accounts.invAsset,
      date: "2026-03-31",
      actorId,
    });
    assert.equal(disposal.nbv, "62000.0000", `disposal NBV must net the opening figure (got ${disposal.nbv})`);
    assert.equal(disposal.gainLoss, "8000.0000", `gain must be proceeds − continued NBV (got ${disposal.gainLoss})`);
    assert.equal(disposal.status, "disposed");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("impairment delta and the IFRS restoration ceiling use the continued carrying amount", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    await seedMonthlyPeriods(org.orgId, MONTHS_2026);
    await setFramework(org.orgId, "ifrs");
    const assetId = await seedOnboardedAsset(org.orgId, org.subsidiaryId, org.accounts, {
      amount: "55000.0000",
      asOf: "2025-12-31",
    });
    await buildSchedule(assetId, org.orgId, actorId, org.bookId);

    // Continued NBV 65000 → 60000 is a 5000 loss, not a 60000 one.
    const impairment = await remeasureAsset(org.orgId, assetId, {
      newCarryingValue: "60000.0000",
      date: "2026-01-31",
      actorId,
    });
    assert.equal(impairment.kind, "impaired");
    assert.equal(impairment.delta, "-5000.0000", `impairment must measure off the continued NBV (got ${impairment.delta})`);

    // By 2026-06-30 the unimpaired counterfactual is
    // 120000 − 55000 − 6000 (Jan–Jun plan) = 59000: restoring to 64000
    // breaches the IAS 36 ceiling even though it sits inside the 5000 loss.
    await assert.rejects(
      remeasureAsset(org.orgId, assetId, {
        newCarryingValue: "64000.0000",
        date: "2026-06-30",
        actorId,
      }),
      /carrying amount without impairment|caps an impairment reversal/,
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("an asset fully depreciated by its opening figure flips to fully_depreciated", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    await seedMonthlyPeriods(org.orgId, MONTHS_2026);
    const assetId = await seedOnboardedAsset(org.orgId, org.subsidiaryId, org.accounts, {
      amount: "120000.0000",
      asOf: "2025-12-31",
    });
    await buildSchedule(assetId, org.orgId, actorId, org.bookId);
    const run = await runDepreciation(org.orgId, "2026-03-31", actorId, assetId);
    assert.equal(run.posted, 0, "nothing remains to post");
    const status = (await db.execute<{ status: string }>(sql`
      select status from fixed_assets where id = ${assetId} and org_id = ${org.orgId}`)).rows[0]!.status;
    assert.equal(status, "fully_depreciated", `opening-consumed basis must flip status (got ${status})`);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("reversing a disposal restores the continued carrying status", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    await seedMonthlyPeriods(org.orgId, MONTHS_2026);
    const assetId = await seedOnboardedAsset(org.orgId, org.subsidiaryId, org.accounts, {
      amount: "120000.0000",
      asOf: "2025-12-31",
    });
    await buildSchedule(assetId, org.orgId, actorId, org.bookId);
    const disposal = await disposeAsset(org.orgId, assetId, {
      proceeds: "5000.0000",
      proceedsAccountId: org.accounts.invAsset,
      date: "2026-03-31",
      actorId,
    });
    assert.equal(disposal.nbv, "0.0000");
    assert.equal(disposal.gainLoss, "5000.0000");
    const eventId = (await db.execute<{ id: string }>(sql`
      select id from asset_events
       where org_id = ${org.orgId} and asset_id = ${assetId} and kind = 'disposed' limit 1`)).rows[0]!.id;
    const reversal = await reverseAssetLifecycleEvent(org.orgId, eventId, {
      date: "2026-04-15",
      actorId,
      reason: "test reversal of a continued-carry disposal",
    });
    assert.equal(reversal.created, true);
    assert.equal(
      reversal.restoredStatus,
      "fully_depreciated",
      `opening-consumed basis must restore as fully_depreciated (got ${reversal.restoredStatus})`,
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("manual evidence cannot push accumulated depreciation past the opening-adjusted basis", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    await seedMonthlyPeriods(org.orgId, MONTHS_2026);
    const assetId = await seedOnboardedAsset(
      org.orgId,
      org.subsidiaryId,
      org.accounts,
      { amount: "115000.0000", asOf: "2025-12-31" },
      "manual",
    );
    await buildSchedule(assetId, org.orgId, actorId, org.bookId);
    const evidenceFileId = await seedEvidence(org.orgId, assetId, actorId);

    // 115000 (opening) + 6000 would breach the 120000 basis.
    await assert.rejects(
      recordDepreciationInput({
        orgId: org.orgId,
        assetId,
        effectiveDate: "2026-03-15",
        kind: "manual",
        value: "6000.0000",
        memo: "Q1 usage top-up",
        evidenceFileId,
        actorId,
      }),
      /between zero and the salvage floor/,
    );
    // Exactly to the basis is still accepted.
    const ok = await recordDepreciationInput({
      orgId: org.orgId,
      assetId,
      effectiveDate: "2026-03-15",
      kind: "manual",
      value: "5000.0000",
      memo: "Q1 usage top-up",
      evidenceFileId,
      actorId,
    });
    assert.equal(ok.plannedAmount, "5000.0000");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
