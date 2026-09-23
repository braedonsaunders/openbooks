import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  assertPostableDepreciationStatus,
  buildSchedule,
  DepreciationRefusalError,
  runDepreciation,
} from "./depreciation.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
} from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test("only in-service assets own postable schedules", () => {
  assertPostableDepreciationStatus("in_service", "A-1");
  assertPostableDepreciationStatus("fully_depreciated", "A-1");
  for (const status of ["draft", "disposed", "written_off", "archived", ""]) {
    assert.throws(
      () => assertPostableDepreciationStatus(status, "A-1"),
      (error: unknown) =>
        error instanceof DepreciationRefusalError &&
        /A-1/.test(error.message) &&
        new RegExp(status || "status").test(error.message),
      `status ${status || "<empty>"} must refuse`,
    );
  }
});

test(
  "a draft builds no schedule and its lines never post",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const categoryId = randomUUID();
    const draftId = randomUUID();
    try {
      await db.execute(sql`
        insert into asset_categories
          (id, org_id, name, asset_account_id, accumulated_depreciation_account_id,
           depreciation_expense_account_id, gain_loss_account_id,
           default_method, default_life_months, default_convention,
           tax_attributes, is_active, created_by, updated_by)
        values
          (${categoryId}, ${org.orgId}, 'Draft equipment',
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
          (${draftId}, ${org.orgId}, ${org.subsidiaryId}, ${categoryId}, 'DRAFT-NOSCHED',
           'Draft asset', 'draft',
           '2026-07-15', '2026-07-15', 1000, 0, 'straight_line', 10,
           'full_month', '{}'::jsonb, ${actorId}, ${actorId})
      `);

      // A draft carrying full schedule inputs still builds nothing.
      await assert.rejects(
        buildSchedule(draftId, org.orgId, actorId, org.bookId),
        (error: unknown) =>
          error instanceof DepreciationRefusalError && /must be in service/.test(error.message),
        "building a schedule for a draft asset is refused",
      );
      const schedules = (
        await db.execute(sql`
          select 1 from depreciation_schedules where org_id = ${org.orgId} and asset_id = ${draftId} limit 1
        `)
      ).rows;
      assert.equal(schedules.length, 0, "no schedule row may exist for the draft");

      // Even a hand-planted draft line (legacy data, or a writer bypassing
      // the build gate) is invisible to the posting run.
      const scheduleId = randomUUID();
      await db.execute(sql`
        insert into depreciation_schedules (id, org_id, asset_id, book_id, method, created_by, updated_by)
        values (${scheduleId}, ${org.orgId}, ${draftId}, ${org.bookId}, 'straight_line', ${actorId}, ${actorId})
      `);
      await db.execute(sql`
        insert into depreciation_schedule_lines
          (id, org_id, schedule_id, period_id, sequence, planned_amount, source, created_by, updated_by)
        values (${randomUUID()}, ${org.orgId}, ${scheduleId}, ${org.periodId}, 1, '100.0000', 'formula', ${actorId}, ${actorId})
      `);
      const run = await runDepreciation(org.orgId, "2026-07-31", actorId, draftId);
      assert.equal(run.posted, 0, "the run must post nothing for a draft asset");
      const line = (
        await db.execute<{ posted_amount: string | null }>(sql`
          select posted_amount from depreciation_schedule_lines
           where org_id = ${org.orgId} and schedule_id = ${scheduleId}
        `)
      ).rows[0]!;
      assert.equal(line.posted_amount, null, "the draft line stays unposted");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
