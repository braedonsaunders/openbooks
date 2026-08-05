import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { buildAllSchedules, buildSchedule, recordDepreciationInput, runDepreciation } from "./depreciation.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

async function seedAsset(
  method: "manual" | "units_of_production",
  unitsTotal?: string,
): Promise<{ org: Awaited<ReturnType<typeof createScratchOrg>>; assetId: string; actorId: string; evidenceFileId: string }> {
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
  const folderId = randomUUID();
  const evidenceFileId = randomUUID();
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      insert into folders (id, org_id, name, record_table, record_id, created_by, updated_by)
      values (${folderId}, ${org.orgId}, 'Asset evidence', 'fixed_assets', ${assetId}, ${actorId}, ${actorId})`);
    await tx.execute(sql`
      insert into files (id, org_id, folder_id, name, file_type, content_type, size_bytes, created_by, updated_by)
      values (${evidenceFileId}, ${org.orgId}, ${folderId}, 'meter-evidence.pdf', 'pdf', 'application/pdf', 1, ${actorId}, ${actorId})`);
    await tx.execute(sql`
      insert into file_attachments (org_id, file_id, target_table, target_id, created_by)
      values (${org.orgId}, ${evidenceFileId}, 'fixed_assets', ${assetId}, ${actorId})`);
  });
  return { org, assetId, actorId, evidenceFileId };
}

test("manual evidence replacement is append-preserved and concurrent runs post once", { skip: !DB }, async () => {
  const { org, assetId, actorId, evidenceFileId } = await seedAsset("manual");
  try {
    const unattachedFileId = randomUUID();
    const schedule = (await db.execute(sql`
      select id from depreciation_schedules where org_id=${org.orgId} and asset_id=${assetId} and book_id=${org.bookId}
    `)) as unknown as { rows: { id: string }[] };
    await db.execute(sql`
      insert into files (id, org_id, folder_id, name, file_type, content_type, size_bytes, created_by, updated_by)
      select ${unattachedFileId}, ${org.orgId}, folder_id, 'unattached.pdf', 'pdf', 'application/pdf', 1, ${actorId}, ${actorId}
        from files where id=${evidenceFileId}
    `);
    await assert.rejects(
      db.execute(sql`
        insert into depreciation_inputs
          (org_id, schedule_id, period_id, kind, manual_amount, memo, evidence_file_id, created_by, updated_by)
        values (${org.orgId}, ${schedule.rows[0]!.id}, ${org.periodId}, 'manual', '1.0000',
                'Attempted unattached evidence', ${unattachedFileId}, ${actorId}, ${actorId})
      `),
      (error: unknown) => {
        const wrapped = error as { message?: string; cause?: { message?: string } };
        return /depreciation evidence file must be attached to the owning fixed asset/.test(
          `${wrapped.message ?? ""} ${wrapped.cause?.message ?? ""}`,
        );
      },
    );

    const first = await recordDepreciationInput({
      orgId: org.orgId, assetId, effectiveDate: org.date, kind: "manual", value: "100.0000",
      memo: "Approved manual adjustment", evidenceFileId, actorId,
    });
    const attachment = (await db.execute(sql`
      select id from file_attachments where org_id=${org.orgId} and file_id=${evidenceFileId} and target_id=${assetId}`)) as unknown as { rows: { id: string }[] };
    await assert.rejects(
      db.execute(sql`delete from file_attachments where id=${attachment.rows[0]!.id}`),
      (error: unknown) => {
        const wrapped = error as { message?: string; cause?: { message?: string } };
        return /file attachment is retained by depreciation evidence/.test(
          `${wrapped.message ?? ""} ${wrapped.cause?.message ?? ""}`,
        );
      },
    );
    const second = await recordDepreciationInput({
      orgId: org.orgId, assetId, effectiveDate: org.date, kind: "manual", value: "125.4321",
      memo: "Controller-approved correction", evidenceFileId, actorId,
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
      memo: "Controller-approved correction", evidenceFileId, actorId,
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

test("custom formulas operate independently on an alternate depreciation book", { skip: !DB }, async () => {
  const { org, assetId, actorId } = await seedAsset("manual");
  try {
    const formulaId = randomUUID();
    const alternateBookId = randomUUID();
    await db.execute(sql`
      insert into depreciation_methods (id, org_id, code, name, formula, end_of_life, is_active, created_by, updated_by)
      values (${formulaId}, ${org.orgId}, 'ALT-SL', 'Alternate straight line', '(OC-RV)/AL', 'fully_depreciate', true, ${actorId}, ${actorId})`);
    await db.execute(sql`
      insert into accounting_books (id, org_id, code, name, is_primary, posts_gl, is_active, created_by, updated_by)
      values (${alternateBookId}, ${org.orgId}, 'ALT', 'Alternate reporting', false, false, true, ${actorId}, ${actorId})`);
    const category = (await db.execute(sql`select category_id from fixed_assets where id=${assetId}`)) as unknown as { rows: { category_id: string }[] };
    await db.execute(sql`update fixed_assets set useful_life_months=12 where id=${assetId}`);
    await db.execute(sql`
      insert into depreciation_book_policies
        (org_id, book_id, category_id, method, depreciation_method_id, life_months, convention, created_by, updated_by)
      values (${org.orgId}, ${alternateBookId}, ${category.rows[0]!.category_id}, 'straight_line', ${formulaId}, 12, 'full_month', ${actorId}, ${actorId})`);

    const results = await buildAllSchedules(assetId, org.orgId, actorId);
    assert.equal(results.length, 2);
    const alternate = (await db.execute(sql`
      select s.depreciation_method_id, count(l.id)::int as lines, coalesce(sum(l.planned_amount),0)::text as total
        from depreciation_schedules s left join depreciation_schedule_lines l on l.schedule_id=s.id
       where s.asset_id=${assetId} and s.book_id=${alternateBookId}
       group by s.id`)) as unknown as { rows: { depreciation_method_id: string; lines: number; total: string }[] };
    assert.deepEqual(alternate.rows[0], { depreciation_method_id: formulaId, lines: 1, total: "833.3333" });
    await assert.rejects(
      db.execute(sql`update depreciation_methods set formula='OC/AL' where id=${formulaId}`),
      (error: unknown) => {
        const wrapped = error as { message?: string; cause?: { message?: string } };
        return /a depreciation formula used by a schedule is immutable/.test(
          `${wrapped.message ?? ""} ${wrapped.cause?.message ?? ""}`,
        );
      },
    );
    const nonPostingRun = await runDepreciation(org.orgId, "2026-07-31", actorId, assetId, undefined, alternateBookId);
    assert.equal(nonPostingRun.posted, 0, "a reporting-only book never leaks entries into the GL");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("production evidence calculates exact charges and refuses lifetime overrun", { skip: !DB }, async () => {
  const { org, assetId, actorId, evidenceFileId } = await seedAsset("units_of_production", "1000.0000");
  try {
    const result = await recordDepreciationInput({
      orgId: org.orgId, assetId, effectiveDate: org.date, kind: "production_usage", value: "333.3333",
      memo: "July meter delta", evidenceFileId, actorId,
    });
    assert.equal(result.plannedAmount, "3333.3330");
    await assert.rejects(
      recordDepreciationInput({
        orgId: org.orgId, assetId, effectiveDate: "2026-07-20", kind: "production_usage", value: "1000.0001",
        memo: "Invalid replacement", evidenceFileId, actorId,
      }),
      /recorded production must remain between zero and expected lifetime units/,
    );
    const stored = (await db.execute(sql`
      select l.source, l.planned_amount::text, i.production_units::text, f.name as evidence_file_name
        from depreciation_schedule_lines l join depreciation_inputs i on i.id = l.input_id
        join files f on f.id=i.evidence_file_id
       where l.id = ${result.scheduleLineId}`)) as unknown as {
      rows: { source: string; planned_amount: string; production_units: string; evidence_file_name: string }[];
    };
    assert.deepEqual(stored.rows[0], {
      source: "production_usage", planned_amount: "3333.3330",
      production_units: "333.3333", evidence_file_name: "meter-evidence.pdf",
    });

    await runDepreciation(org.orgId, "2026-07-31", actorId, assetId);
    const correction = await recordDepreciationInput({
      orgId: org.orgId, assetId, effectiveDate: org.date, kind: "production_usage", value: "-33.3333",
      memo: "Corrected meter delta", evidenceFileId, actorId,
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
        memo: "Late meter reading", evidenceFileId, actorId,
      }),
      /asset or GL period is closed/,
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
