import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { buildSchedule, recordDepreciationInput, runDepreciation } from "./depreciation.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

async function seedAsset(
  method: "manual" | "units_of_production",
  unitsTotal?: string,
): Promise<{ org: Awaited<ReturnType<typeof createScratchOrg>>; assetId: string; actorId: string }> {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  const categoryId = randomUUID();
  const assetId = randomUUID();
  await db.execute(sql`
    insert into asset_categories
      (id, org_id, name, asset_account_id, accumulated_depreciation_account_id,
       depreciation_expense_account_id, default_method, default_life_months, default_convention,
       tax_attributes, is_active)
    values (${categoryId}, ${org.orgId}, 'Equipment', ${org.accounts.invAsset}, ${org.accounts.clearing},
            ${org.accounts.adjustment}, ${method}, null, 'full_month', '{}'::jsonb, true)`);
  await db.execute(sql`
    insert into fixed_assets
      (id, org_id, subsidiary_id, category_id, asset_number, name, status,
       acquired_on, in_service_on, acquisition_cost, salvage_value,
       depreciation_method, depreciation_units_total, custom)
    values (${assetId}, ${org.orgId}, ${org.subsidiaryId}, ${categoryId}, ${`ASSET-${method}`},
            ${method}, 'in_service', ${org.date}, ${org.date}, '12000.0000', '2000.0000',
            ${method}, ${unitsTotal ?? null}, '{}'::jsonb)`);
  await buildSchedule(assetId, org.orgId, actorId, org.bookId);
  return { org, assetId, actorId };
}

test("manual evidence replacement is append-preserved and concurrent runs post once", { skip: !DB }, async () => {
  const { org, assetId, actorId } = await seedAsset("manual");
  try {
    const first = await recordDepreciationInput({
      orgId: org.orgId, assetId, effectiveDate: org.date, kind: "manual", value: "100.0000",
      memo: "Approved manual adjustment", evidenceReference: "FILE-100", actorId,
    });
    const second = await recordDepreciationInput({
      orgId: org.orgId, assetId, effectiveDate: org.date, kind: "manual", value: "125.4321",
      memo: "Controller-approved correction", evidenceReference: "FILE-101", actorId,
    });
    assert.equal(second.replacedInputId, first.inputId);
    assert.equal(second.plannedAmount, "125.4321");

    const evidence = (await db.execute(sql`
      select count(*)::int as total,
             count(*) filter (where voided_at is not null)::int as voided
        from depreciation_inputs where org_id = ${org.orgId}`)) as unknown as {
      rows: { total: number; voided: number }[];
    };
    assert.deepEqual(evidence.rows[0], { total: 2, voided: 1 });

    const runs = await Promise.all([
      runDepreciation(org.orgId, "2026-07-31", actorId, assetId),
      runDepreciation(org.orgId, "2026-07-31", actorId, assetId),
    ]);
    assert.equal(runs.reduce((total, run) => total + run.posted, 0), 1);
    const ledger = (await db.execute(sql`
      select count(distinct je.id)::int as entries, coalesce(sum(jl.amount), 0)::text as balance,
             min(l.posted_amount)::text as posted_amount
        from depreciation_schedule_lines l
        join journal_entries je on je.id = l.journal_entry_id
        join journal_lines jl on jl.entry_id = je.id
       where l.org_id = ${org.orgId} and l.id = ${second.scheduleLineId}`)) as unknown as {
      rows: { entries: number; balance: string; posted_amount: string }[];
    };
    assert.deepEqual(ledger.rows[0], { entries: 1, balance: "0.0000", posted_amount: "125.4321" });

    await assert.rejects(
      db.execute(sql`update depreciation_inputs set memo = 'tampered' where id = ${second.inputId}`),
      (error: unknown) => {
        const wrapped = error as { message?: string; cause?: { message?: string } };
        return /posted depreciation input evidence is immutable/.test(`${wrapped.message ?? ""} ${wrapped.cause?.message ?? ""}`);
      },
    );

    const correction = await recordDepreciationInput({
      orgId: org.orgId, assetId, effectiveDate: org.date, kind: "manual", value: "-25.4321",
      memo: "Controller-approved correction", evidenceReference: "FILE-102", actorId,
    });
    assert.equal(correction.replacedInputId, null, "posted evidence remains intact instead of being superseded");
    const correctionRun = await runDepreciation(org.orgId, "2026-07-31", actorId, assetId);
    assert.equal(correctionRun.posted, 1);
    const corrected = (await db.execute(sql`
      select coalesce(sum(posted_amount), 0)::text as accumulated,
             count(*) filter (where posted_amount is not null)::int as postings
        from depreciation_schedule_lines
       where org_id = ${org.orgId} and schedule_id = (
         select schedule_id from depreciation_schedule_lines where id = ${second.scheduleLineId})
    `)) as unknown as { rows: { accumulated: string; postings: number }[] };
    assert.deepEqual(corrected.rows[0], { accumulated: "100.0000", postings: 2 });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("production evidence calculates exact charges and refuses lifetime overrun", { skip: !DB }, async () => {
  const { org, assetId, actorId } = await seedAsset("units_of_production", "1000.0000");
  try {
    const result = await recordDepreciationInput({
      orgId: org.orgId, assetId, effectiveDate: org.date, kind: "production_usage", value: "333.3333",
      memo: "July meter delta", evidenceReference: "METER-2026-07", actorId,
    });
    assert.equal(result.plannedAmount, "3333.3330");
    await assert.rejects(
      recordDepreciationInput({
        orgId: org.orgId, assetId, effectiveDate: "2026-07-20", kind: "production_usage", value: "1000.0001",
        memo: "Invalid replacement", evidenceReference: "METER-OVER", actorId,
      }),
      /recorded production must remain between zero and expected lifetime units/,
    );
    const stored = (await db.execute(sql`
      select l.source, l.planned_amount::text, i.production_units::text, i.evidence_reference
        from depreciation_schedule_lines l join depreciation_inputs i on i.id = l.input_id
       where l.id = ${result.scheduleLineId}`)) as unknown as {
      rows: { source: string; planned_amount: string; production_units: string; evidence_reference: string }[];
    };
    assert.deepEqual(stored.rows[0], {
      source: "production_usage", planned_amount: "3333.3330",
      production_units: "333.3333", evidence_reference: "METER-2026-07",
    });

    await runDepreciation(org.orgId, "2026-07-31", actorId, assetId);
    const correction = await recordDepreciationInput({
      orgId: org.orgId, assetId, effectiveDate: org.date, kind: "production_usage", value: "-33.3333",
      memo: "Corrected meter delta", evidenceReference: "METER-2026-07-CORR", actorId,
    });
    assert.equal(correction.plannedAmount, "-333.3330");
    await db.execute(sql`
      insert into period_locks
        (org_id, period_id, book_id, subsidiary_id, module, state, locked_at, locked_by, reason, created_by, updated_by)
      values (${org.orgId}, ${org.periodId}, ${org.bookId}, ${org.subsidiaryId}, 'assets', 'closed', now(),
              ${actorId}, 'Depreciation contract test', ${actorId}, ${actorId})
    `);
    await assert.rejects(
      recordDepreciationInput({
        orgId: org.orgId, assetId, effectiveDate: org.date, kind: "production_usage", value: "1.0000",
        memo: "Late meter reading", evidenceReference: "METER-LATE", actorId,
      }),
      /asset or GL period is closed/,
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
