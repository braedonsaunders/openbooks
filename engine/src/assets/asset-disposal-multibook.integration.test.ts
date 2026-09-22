import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { disposeAsset } from "./asset-lifecycle.ts";
import { buildSchedule, runDepreciation } from "./depreciation.ts";
import {
  proposeAssetChange,
  applyAssetChange,
  type AssetChangeInput,
} from "./asset-changes.ts";
import { submitFinancialChange } from "../flows/financial-changes-adapter.ts";
import { decideGate } from "../flows/gates.ts";
import { setPeriodLockState } from "../close/period-locks.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
  seedApprovalFlow,
  type ScratchOrg,
} from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

type TwoBook = {
  org: ScratchOrg;
  actorId: string;
  submitterId: string;
  approverId: string;
  assetId: string;
  categoryId: string;
  secondaryBookId: string;
};

async function seedTwoBookDepreciated(postsGl = true): Promise<TwoBook> {
  const org = await createScratchOrg();
  const actors = await seedFlowActors(org.orgId);
  const actorId = actors.adminId;
  const assetId = randomUUID();
  const categoryId = randomUUID();
  const secondaryBookId = randomUUID();
  await db.execute(
    sql`insert into user_permission_overrides(org_id,user_id,permission,effect) values(${org.orgId},${actors.submitterId},'assets.manage','grant')`,
  );
  const calendar = (
    await db.execute<{ id: string }>(
      sql`select fiscal_calendar_id as id from accounting_periods where org_id=${org.orgId} and id=${org.periodId}`,
    )
  ).rows[0]!.id;
  await db.execute(
    sql`insert into accounting_periods(id,org_id,fiscal_calendar_id,fiscal_year,period_number,name,starts_on,ends_on,is_adjustment,custom) values(${randomUUID()},${org.orgId},${calendar},2026,8,'2026-08','2026-08-01','2026-08-31',false,'{}'::jsonb)`,
  );
  await db.execute(sql`
    insert into accounting_books (id, org_id, code, name, is_primary, posts_gl, is_active, created_by, updated_by)
    values (${secondaryBookId}, ${org.orgId}, 'SEC', 'Secondary posting', false, ${postsGl}, true, ${actorId}, ${actorId})
  `);
  await db.execute(sql`
    insert into asset_categories
      (id, org_id, name, asset_account_id,
       accumulated_depreciation_account_id,
       depreciation_expense_account_id, gain_loss_account_id,
       default_method, default_life_months, default_convention,
       tax_attributes, is_active, created_by, updated_by)
    values
      (${categoryId}, ${org.orgId}, 'Two-book equipment',
       ${org.accounts.invAsset}, ${org.accounts.clearing},
       ${org.accounts.adjustment}, ${org.accounts.adjustment},
       'straight_line', 12, 'full_month', '{}'::jsonb, true,
       ${actorId}, ${actorId})
  `);
  await db.execute(sql`
    insert into depreciation_book_policies
      (org_id, book_id, category_id, method, life_months, convention, created_by, updated_by)
    values (${org.orgId}, ${secondaryBookId}, ${categoryId}, 'straight_line', 6, 'full_month', ${actorId}, ${actorId})
  `);
  await db.execute(sql`
    insert into fixed_assets
      (id, org_id, subsidiary_id, category_id, asset_number, name, status,
       acquired_on, in_service_on, acquisition_cost, salvage_value,
       depreciation_method, useful_life_months, depreciation_convention,
       custom, created_by, updated_by)
    values
      (${assetId}, ${org.orgId}, ${org.subsidiaryId}, ${categoryId},
       'ASSET-TWO-BOOK', 'Two-book asset', 'in_service',
       ${org.date}, ${org.date}, 1200, 0, 'straight_line', 12,
       'full_month', '{}'::jsonb, ${actorId}, ${actorId})
  `);
  await buildSchedule(assetId, org.orgId, actorId, org.bookId);
  await buildSchedule(assetId, org.orgId, actorId, secondaryBookId);
  await seedApprovalFlow(org.orgId, {
    subjectKind: "financial_change",
    assignees: [{ type: "user", userId: actors.approver1Id }],
    mode: "any",
    preventSelfApproval: false,
  });
  return {
    org,
    actorId,
    submitterId: actors.submitterId,
    approverId: actors.approver1Id,
    assetId,
    categoryId,
    secondaryBookId,
  };
}

async function approve(orgId: string, changeId: string, submitterId: string, approverId: string) {
  await submitFinancialChange(orgId, changeId, submitterId);
  const gate = (
    await db.execute<{ id: string }>(
      sql`select id from flow_gates where org_id=${orgId} and subject_id=${changeId} and status='pending'`,
    )
  ).rows[0]!;
  await decideGate({ gateId: gate.id, userId: approverId, decision: "approved" });
}

async function bookBalance(orgId: string, bookId: string, accountId: string) {
  return (
    await db.execute<{ total: string }>(sql`
      select coalesce(sum(l.amount), 0)::text as total
        from journal_lines l
        join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
       where l.org_id = ${orgId} and e.book_id = ${bookId}
         and l.account_id = ${accountId}`)
  ).rows[0]!.total;
}

async function assetStatus(orgId: string, assetId: string) {
  return (
    await db.execute<{ status: string }>(
      sql`select status from fixed_assets where org_id=${orgId} and id=${assetId}`,
    )
  ).rows[0]!.status;
}

test(
  "direct disposal refuses when the asset is depreciated in two posting books",
  { skip: !DB },
  async () => {
    const f = await seedTwoBookDepreciated();
    try {
      const posted = await runDepreciation(f.org.orgId, "2026-07-31", f.actorId, f.assetId);
      assert.equal(posted.posted, 2);
      assert.equal(await bookBalance(f.org.orgId, f.org.bookId, f.org.accounts.clearing), "-100.0000");
      assert.equal(await bookBalance(f.org.orgId, f.secondaryBookId, f.org.accounts.clearing), "-200.0000");

      const journalsBefore = (
        await db.execute<{ n: number }>(
          sql`select count(*)::int as n from journal_entries where org_id=${f.org.orgId}`,
        )
      ).rows[0]!.n;
      await assert.rejects(
        () =>
          disposeAsset(f.org.orgId, f.assetId, {
            proceeds: "500",
            proceedsAccountId: f.org.accounts.bank,
            date: "2026-07-31",
            actorId: f.actorId,
          }),
        (error: unknown) => {
          const message = (error as Error).message;
          assert.match(message, /Secondary posting/);
          assert.match(message, /Partial disposal \/ transfer/);
          assert.match(message, /100%/);
          assert.match(message, /write-off/);
          return true;
        },
        "refusal must name the stranded book and the working remedy",
      );
      assert.equal(await assetStatus(f.org.orgId, f.assetId), "in_service");
      assert.equal(
        (
          await db.execute<{ n: number }>(
            sql`select count(*)::int as n from journal_entries where org_id=${f.org.orgId}`,
          )
        ).rows[0]!.n,
        journalsBefore,
        "refusal must post no journals",
      );
      assert.equal(
        (
          await db.execute<{ n: number }>(
            sql`select count(*)::int as n from asset_events where org_id=${f.org.orgId} and asset_id=${f.assetId}`,
          )
        ).rows[0]!.n,
        0,
        "refusal must record no asset events",
      );
    } finally {
      await dropScratchOrg(f.org.orgId);
    }
  },
);

test(
  "approved full partial disposal clears accumulated depreciation in both posting books",
  { skip: !DB },
  async () => {
    const f = await seedTwoBookDepreciated();
    try {
      const posted = await runDepreciation(f.org.orgId, "2026-07-31", f.actorId, f.assetId);
      assert.equal(posted.posted, 2);
      const request: AssetChangeInput = {
        operation: "partial_disposal",
        effectiveOn: "2026-08-01",
        reason: "Sold the entire two-book machine for cash",
        assessment: "Whole asset derecognized in every posting book at its own carrying amount",
        idempotencyKey: randomUUID(),
        portion: { percent: "100" },
        proceeds: "500",
        proceedsAccountId: f.org.accounts.bank,
      };
      const changeId = await proposeAssetChange(f.org.orgId, f.assetId, f.submitterId, request);
      await assert.rejects(
        () => applyAssetChange(f.org.orgId, changeId, f.submitterId),
        /independent approval/,
      );
      await approve(f.org.orgId, changeId, f.submitterId, f.approverId);
      const applied = await applyAssetChange(f.org.orgId, changeId, f.submitterId);
      assert.equal(applied.full, true);
      assert.equal(await assetStatus(f.org.orgId, f.assetId), "disposed");
      for (const bookId of [f.org.bookId, f.secondaryBookId]) {
        const disposals = (
          await db.execute<{ n: number }>(sql`
            select count(*)::int as n from journal_entries
             where org_id=${f.org.orgId} and book_id=${bookId} and origin='disposal' and status='posted'`)
        ).rows[0]!.n;
        assert.ok(disposals >= 1, `clearing journal posted in book ${bookId}`);
        assert.equal(
          await bookBalance(f.org.orgId, bookId, f.org.accounts.clearing),
          "0.0000",
          "accumulated depreciation cleared in every posting book",
        );
      }
      const rerun = await runDepreciation(f.org.orgId, "2026-08-31", f.actorId, f.assetId);
      assert.equal(rerun.posted, 0, "no future run touches the fully disposed asset");
    } finally {
      await dropScratchOrg(f.org.orgId);
    }
  },
);

test(
  "direct disposal refuses when two posting books share one display name",
  { skip: !DB },
  async () => {
    const f = await seedTwoBookDepreciated();
    try {
      // Both books share one display name: a name-keyed guard would see a
      // single book and stay blind, while the identity-keyed guard fires.
      await db.execute(
        sql`update accounting_books set name = 'Secondary posting' where org_id = ${f.org.orgId} and id = ${f.org.bookId}`,
      );
      const posted = await runDepreciation(f.org.orgId, "2026-07-31", f.actorId, f.assetId);
      assert.equal(posted.posted, 2);
      await assert.rejects(
        () =>
          disposeAsset(f.org.orgId, f.assetId, {
            proceeds: "500",
            proceedsAccountId: f.org.accounts.bank,
            date: "2026-07-31",
            actorId: f.actorId,
          }),
        (error: unknown) => {
          const message = (error as Error).message;
          assert.match(message, /Partial disposal \/ transfer/);
          assert.match(message, /100%/);
          return true;
        },
        "identity-keyed guard must fire even when display names collide",
      );
      assert.equal(await assetStatus(f.org.orgId, f.assetId), "in_service");
    } finally {
      await dropScratchOrg(f.org.orgId);
    }
  },
);

test(
  "direct disposal refuses when only a secondary posting book carries a schedule",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = (await seedFlowActors(org.orgId)).adminId;
      const categoryId = randomUUID();
      const assetId = randomUUID();
      const secondaryBookId = randomUUID();
      await db.execute(sql`
        insert into accounting_books (id, org_id, code, name, is_primary, posts_gl, is_active, created_by, updated_by)
        values (${secondaryBookId}, ${org.orgId}, 'SEC', 'Secondary posting', false, true, true, ${actorId}, ${actorId})
      `);
      await db.execute(sql`
        insert into asset_categories
          (id, org_id, name, asset_account_id,
           accumulated_depreciation_account_id,
           depreciation_expense_account_id, gain_loss_account_id,
           default_method, default_life_months, default_convention,
           tax_attributes, is_active, created_by, updated_by)
        values
          (${categoryId}, ${org.orgId}, 'Secondary-only equipment',
           ${org.accounts.invAsset}, ${org.accounts.clearing},
           ${org.accounts.adjustment}, ${org.accounts.adjustment},
           'straight_line', 12, 'full_month', '{}'::jsonb, true,
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
           'ASSET-SEC-ONLY', 'Secondary-only asset', 'in_service',
           ${org.date}, ${org.date}, 1200, 0, 'straight_line', 12,
           'full_month', '{}'::jsonb, ${actorId}, ${actorId})
      `);
      await buildSchedule(assetId, org.orgId, actorId, secondaryBookId);
      const posted = await runDepreciation(org.orgId, "2026-07-31", actorId, assetId);
      assert.equal(posted.posted, 1);
      const journalsBefore = (
        await db.execute<{ n: number }>(
          sql`select count(*)::int as n from journal_entries where org_id=${org.orgId}`,
        )
      ).rows[0]!.n;
      await assert.rejects(
        () =>
          disposeAsset(org.orgId, assetId, {
            proceeds: "500",
            proceedsAccountId: org.accounts.bank,
            date: "2026-07-31",
            actorId,
          }),
        (error: unknown) => {
          const message = (error as Error).message;
          assert.match(message, /Secondary posting/);
          assert.match(message, /Partial disposal \/ transfer/);
          assert.match(message, /100%/);
          return true;
        },
        "a primary journal plus a secondary-only schedule is still two effects",
      );
      assert.equal(await assetStatus(org.orgId, assetId), "in_service");
      assert.equal(
        (
          await db.execute<{ n: number }>(
            sql`select count(*)::int as n from journal_entries where org_id=${org.orgId}`,
          )
        ).rows[0]!.n,
        journalsBefore,
        "refusal must post no journals",
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "direct disposal refuses an inactive posting book and the reactivated book clears through the approved change",
  { skip: !DB },
  async () => {
    const f = await seedTwoBookDepreciated();
    try {
      const posted = await runDepreciation(f.org.orgId, "2026-07-31", f.actorId, f.assetId);
      assert.equal(posted.posted, 2);
      await db.execute(
        sql`update accounting_books set is_active = false where org_id = ${f.org.orgId} and id = ${f.secondaryBookId}`,
      );
      await assert.rejects(
        () =>
          disposeAsset(f.org.orgId, f.assetId, {
            proceeds: "500",
            proceedsAccountId: f.org.accounts.bank,
            date: "2026-07-31",
            actorId: f.actorId,
          }),
        /Secondary posting \(inactive\)/,
        "historical inactive book evidence stays in the refusal",
      );
      assert.equal(await assetStatus(f.org.orgId, f.assetId), "in_service");
      await assert.rejects(
        () =>
          proposeAssetChange(f.org.orgId, f.assetId, f.submitterId, {
            operation: "partial_disposal",
            effectiveOn: "2026-08-01",
            reason: "Attempt the full change while the book is inactive",
            assessment: "Names the reactivation the approved path requires",
            idempotencyKey: randomUUID(),
            portion: { percent: "100" },
            proceeds: "500",
            proceedsAccountId: f.org.accounts.bank,
          }),
        /activate accounting book Secondary posting/,
        "the approved path names the reactivation it requires",
      );
      await db.execute(
        sql`update accounting_books set is_active = true where org_id = ${f.org.orgId} and id = ${f.secondaryBookId}`,
      );
      const changeId = await proposeAssetChange(f.org.orgId, f.assetId, f.submitterId, {
        operation: "partial_disposal",
        effectiveOn: "2026-08-01",
        reason: "Sold the entire two-book machine after reactivation",
        assessment: "Whole asset derecognized in every posting book at its own carrying amount",
        idempotencyKey: randomUUID(),
        portion: { percent: "100" },
        proceeds: "500",
        proceedsAccountId: f.org.accounts.bank,
      });
      await approve(f.org.orgId, changeId, f.submitterId, f.approverId);
      const applied = await applyAssetChange(f.org.orgId, changeId, f.submitterId);
      assert.equal(applied.full, true);
      assert.equal(await assetStatus(f.org.orgId, f.assetId), "disposed");
      for (const bookId of [f.org.bookId, f.secondaryBookId]) {
        assert.equal(
          await bookBalance(f.org.orgId, bookId, f.org.accounts.clearing),
          "0.0000",
          "reactivated book clears through the approved change",
        );
      }
    } finally {
      await dropScratchOrg(f.org.orgId);
    }
  },
);

test(
  "direct disposal still clears a single-book asset",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = (await seedFlowActors(org.orgId)).adminId;
      const categoryId = randomUUID();
      const assetId = randomUUID();
      await db.execute(sql`
        insert into asset_categories
          (id, org_id, name, asset_account_id,
           accumulated_depreciation_account_id,
           depreciation_expense_account_id, gain_loss_account_id,
           default_method, default_life_months, default_convention,
           tax_attributes, is_active, created_by, updated_by)
        values
          (${categoryId}, ${org.orgId}, 'Single-book equipment',
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
           'ASSET-SINGLE', 'Single-book asset', 'in_service',
           ${org.date}, ${org.date}, 1000, 0, 'straight_line', 10,
           'full_month', '{}'::jsonb, ${actorId}, ${actorId})
      `);
      await buildSchedule(assetId, org.orgId, actorId, org.bookId);
      const posted = await runDepreciation(org.orgId, "2026-07-31", actorId, assetId);
      assert.equal(posted.posted, 1);
      const result = await disposeAsset(org.orgId, assetId, {
        proceeds: "100",
        proceedsAccountId: org.accounts.bank,
        date: "2026-07-31",
        actorId,
      });
      assert.equal(result.status, "disposed");
      assert.equal(await bookBalance(org.orgId, org.bookId, org.accounts.clearing), "0.0000");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "direct disposal still clears an asset whose second book is reporting-only",
  { skip: !DB },
  async () => {
    const f = await seedTwoBookDepreciated(false);
    try {
      const posted = await runDepreciation(f.org.orgId, "2026-07-31", f.actorId, f.assetId);
      assert.equal(posted.posted, 1, "only the posting book emits a journal");
      assert.equal(posted.recorded, 1, "the reporting book keeps its own history");
      const result = await disposeAsset(f.org.orgId, f.assetId, {
        proceeds: "100",
        proceedsAccountId: f.org.accounts.bank,
        date: "2026-07-31",
        actorId: f.actorId,
      });
      assert.equal(result.status, "disposed");
      assert.equal(await bookBalance(f.org.orgId, f.org.bookId, f.org.accounts.clearing), "0.0000");
    } finally {
      await dropScratchOrg(f.org.orgId);
    }
  },
);

test(
  "a closed period still refuses a single-book disposal dated inside it",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = (await seedFlowActors(org.orgId)).adminId;
      const categoryId = randomUUID();
      const assetId = randomUUID();
      await db.execute(sql`
        insert into asset_categories
          (id, org_id, name, asset_account_id,
           accumulated_depreciation_account_id,
           depreciation_expense_account_id, gain_loss_account_id,
           default_method, default_life_months, default_convention,
           tax_attributes, is_active, created_by, updated_by)
        values
          (${categoryId}, ${org.orgId}, 'Close-gated equipment',
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
           'ASSET-CLOSE', 'Close-gated asset', 'in_service',
           ${org.date}, ${org.date}, 1000, 0, 'straight_line', 10,
           'full_month', '{}'::jsonb, ${actorId}, ${actorId})
      `);
      await buildSchedule(assetId, org.orgId, actorId, org.bookId);
      await setPeriodLockState({
        orgId: org.orgId,
        periodId: org.periodId,
        bookId: org.bookId,
        module: "gl",
        state: "closed",
        actorId,
        reason: "multibook guard must not weaken the close gate",
      });
      await assert.rejects(
        () =>
          disposeAsset(org.orgId, assetId, {
            proceeds: "0",
            date: org.date,
            actorId,
            writeOff: true,
          }),
        /closed/,
      );
      assert.equal(await assetStatus(org.orgId, assetId), "in_service");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
