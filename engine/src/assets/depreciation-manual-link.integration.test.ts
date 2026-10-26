import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { buildSchedule, linkManualDepreciationEntry, previewDepreciation } from "./depreciation.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "../testing/fixtures.ts";

/**
 * The hand-posted duplicate (S3): when an operator posts a period's
 * depreciation by hand, the preview names the entry and warns that
 * confirming depreciates twice; linking the entry as the line's evidence
 * resolves the line, survives rebuilds, and keeps the run from posting it.
 */
async function seedWorld() {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  await db.execute(sql`insert into accounting_periods
    (org_id,fiscal_calendar_id,fiscal_year,period_number,name,starts_on,ends_on,is_adjustment)
    values (${org.orgId}, (select fiscal_calendar_id from accounting_periods where id=${org.periodId}), 2026, 8, '2026-08', '2026-08-01', '2026-08-31', false)`);
  const categoryId = randomUUID();
  const assetId = randomUUID();
  await db.execute(sql`insert into asset_categories
    (id,org_id,name,asset_account_id,accumulated_depreciation_account_id,depreciation_expense_account_id,gain_loss_account_id,default_method,default_life_months,default_convention)
    values (${categoryId},${org.orgId},'Manual link equipment',${org.accounts.invAsset},${org.accounts.clearing},${org.accounts.adjustment},${org.accounts.adjustment},'straight_line',2,'full_month')`);
  await db.execute(sql`insert into fixed_assets
    (id,org_id,subsidiary_id,category_id,asset_number,name,status,acquired_on,in_service_on,acquisition_cost,salvage_value,depreciation_method,useful_life_months,depreciation_convention)
    values (${assetId},${org.orgId},${org.subsidiaryId},${categoryId},'FA-0001','Manual link mill','in_service','2026-07-01','2026-07-01',95,0,'straight_line',2,'full_month')`);
  await buildSchedule(assetId, org.orgId, actorId, org.bookId);
  const august = (
    await db.execute<{ id: string }>(
      sql`select id from accounting_periods where org_id=${org.orgId} and name='2026-08'`,
      "objects",
    )
  )[0]!.id;
  return { org, actorId, assetId, august };
}

async function postManualEntry(
  orgId: string,
  bookId: string,
  periodId: string,
  subsidiaryId: string,
  actorId: string,
  expenseAccountId: string,
  accumAccountId: string,
  entryNumber: string,
  amount: string,
  status = "posted",
): Promise<string> {
  const entryId = randomUUID();
  await db.execute(sql`insert into journal_entries
    (id,org_id,book_id,period_id,subsidiary_id,entry_number,posting_date,status,origin,created_by,updated_by)
    values (${entryId},${orgId},${bookId},${periodId},${subsidiaryId},${entryNumber},'2026-08-15','draft','manual',${actorId},${actorId})`);
  await db.execute(sql`insert into journal_lines
    (org_id,entry_id,line_number,account_id,amount,currency,txn_amount,subsidiary_id)
    values (${orgId},${entryId},1,${expenseAccountId},${amount},'CAD',${amount},${subsidiaryId}),
           (${orgId},${entryId},2,${accumAccountId},${`-${amount}`},'CAD',${`-${amount}`},${subsidiaryId})`);
  if (status === "posted") {
    await db.execute(sql`update journal_entries set status='posted', posted_at='2026-08-15T12:00:00Z', posted_by=${actorId}
      where org_id=${orgId} and id=${entryId}`);
  }
  return entryId;
}

test(
  "a hand-posted period warns, links, and never posts twice",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const { org, actorId, assetId, august } = await seedWorld();
    try {
      const before = await previewDepreciation(org.orgId, { asOfDate: "2026-08-31" });
      assert.equal(before.totalAmount, "95.0000");
      assert.deepEqual(before.manualEntryCandidates, []);
      // Preview lines name their period by fiscal position, not the stored '2026-08'.
      const augustLine = before.rows.find((row) => row.periodName === "P08 FY2026")!;
      assert.ok(augustLine);
      assert.deepEqual(augustLine.periodRef, {
        fiscalYear: 2026,
        periodNumber: 8,
        adjustment: false,
        startsOn: "2026-08-01",
        endsOn: "2026-08-31",
      });

      const entryId = await postManualEntry(
        org.orgId,
        org.bookId,
        august,
        org.subsidiaryId,
        actorId,
        org.accounts.adjustment,
        org.accounts.clearing,
        "JE-MAN-1",
        "47.50",
      );
      const warned = await previewDepreciation(org.orgId, { asOfDate: "2026-08-31" });
      assert.equal(warned.manualEntryCandidates.length, 1);
      assert.equal(warned.manualEntryCandidates[0]!.entryNumber, "JE-MAN-1");
      assert.equal(warned.manualEntryCandidates[0]!.lineId, augustLine.lineId);
      assert.equal(warned.manualEntryCandidates[0]!.amount, "47.5000");
      assert.equal(warned.manualEntryCandidates[0]!.periodName, "P08 FY2026");
      assert.ok(
        warned.warnings.some(
          (warning) =>
            warning.includes("P08 FY2026: manual entry JE-MAN-1") && warning.includes("twice"),
        ),
      );

      const linked = await linkManualDepreciationEntry(org.orgId, assetId, {
        lineId: augustLine.lineId,
        entryId,
        actorId,
      });
      assert.equal(linked.entryNumber, "JE-MAN-1");
      assert.equal(linked.amount, "47.5000");
      assert.equal(linked.periodName, "P08 FY2026");
      assert.equal(linked.periodRef.periodNumber, 8);

      const resolved = await previewDepreciation(org.orgId, { asOfDate: "2026-08-31" });
      assert.equal(resolved.totalAmount, "47.5000");
      assert.deepEqual(resolved.manualEntryCandidates, []);
      const stored = (
        await db.execute<{ posted_amount: string | null; journal_entry_id: string | null }>(
          sql`
      select posted_amount::text as posted_amount, journal_entry_id::text as journal_entry_id
        from depreciation_schedule_lines where org_id=${org.orgId} and id=${augustLine.lineId}`,
          "objects",
        )
      )[0]!;
      assert.equal(stored.posted_amount, "47.5000");
      assert.equal(stored.journal_entry_id, entryId);

      // Rebuilds preserve posted evidence: the linked line stays posted and the
      // run keeps showing only the genuinely due July line.
      await buildSchedule(assetId, org.orgId, actorId, org.bookId);
      const rebuilt = await previewDepreciation(org.orgId, { asOfDate: "2026-08-31" });
      assert.equal(rebuilt.totalAmount, "47.5000");
      assert.deepEqual(rebuilt.manualEntryCandidates, []);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "linking refuses implausible evidence by name",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const { org, actorId, assetId, august } = await seedWorld();
    try {
      const preview = await previewDepreciation(org.orgId, { asOfDate: "2026-08-31" });
      const augustLine = preview.rows.find((row) => row.periodName === "P08 FY2026")!;
      const julyLine = preview.rows.find((row) => row.periodName === "P07 FY2026")!;
      const entryId = await postManualEntry(
        org.orgId,
        org.bookId,
        august,
        org.subsidiaryId,
        actorId,
        org.accounts.adjustment,
        org.accounts.clearing,
        "JE-MAN-2",
        "47.50",
      );
      const draftId = await postManualEntry(
        org.orgId,
        org.bookId,
        august,
        org.subsidiaryId,
        actorId,
        org.accounts.adjustment,
        org.accounts.clearing,
        "JE-MAN-3",
        "47.50",
        "draft",
      );
      const wrongId = await postManualEntry(
        org.orgId,
        org.bookId,
        august,
        org.subsidiaryId,
        actorId,
        org.accounts.adjustment,
        org.accounts.clearing,
        "JE-MAN-4",
        "10.00",
      );

      await assert.rejects(
        linkManualDepreciationEntry(org.orgId, assetId, {
          lineId: augustLine.lineId,
          entryId: draftId,
          actorId,
        }),
        /only a posted entry/,
      );
      await assert.rejects(
        linkManualDepreciationEntry(org.orgId, assetId, {
          lineId: augustLine.lineId,
          entryId: wrongId,
          actorId,
        }),
        /P08 FY2026 plans 47\.5000, so this entry cannot be its depreciation/,
      );
      await linkManualDepreciationEntry(org.orgId, assetId, {
        lineId: augustLine.lineId,
        entryId,
        actorId,
      });
      const julyEntryId = await postManualEntry(
        org.orgId,
        org.bookId,
        august,
        org.subsidiaryId,
        actorId,
        org.accounts.adjustment,
        org.accounts.clearing,
        "JE-MAN-5",
        "47.50",
      );
      await assert.rejects(
        linkManualDepreciationEntry(org.orgId, assetId, {
          lineId: julyLine.lineId,
          entryId,
          actorId,
        }),
        /already evidences another schedule line/,
      );
      await assert.rejects(
        linkManualDepreciationEntry(org.orgId, assetId, {
          lineId: julyLine.lineId,
          entryId: julyEntryId,
          actorId,
        }),
        /not in this line's book, period, and subsidiary; only the matching entry can evidence .* P07 FY2026$/,
      );
      await assert.rejects(
        linkManualDepreciationEntry(org.orgId, assetId, {
          lineId: augustLine.lineId,
          entryId,
          actorId,
        }),
        / P08 FY2026 is already posted/,
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
