import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { refreshCloseRun, startCloseRun } from "./close.ts";
import { db } from "./db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedDraftDocument,
  seedFlowActors,
} from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test(
  "close controls require an exact document period and never infer one from a date",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actors = await seedFlowActors(org.orgId);
      const calendar = (await db.execute(sql`
        select fiscal_calendar_id
          from accounting_periods
         where id = ${org.periodId}
      `)) as unknown as { rows: { fiscal_calendar_id: string }[] };
      const adjustmentPeriodId = randomUUID();
      await db.execute(sql`
        insert into accounting_periods
          (id, org_id, fiscal_calendar_id, fiscal_year, period_number, name,
           starts_on, ends_on, is_adjustment, custom)
        values (
          ${adjustmentPeriodId}, ${org.orgId},
          ${calendar.rows[0]!.fiscal_calendar_id},
          2026, 13, 'FY26 Adjustment', '2026-07-01', '2026-07-31', true,
          '{}'::jsonb
        )
      `);

      const adjustmentDocumentId = await seedDraftDocument(org.orgId, {
        kind: "vendor_bill",
        createdBy: actors.adminId,
        number: "ADJUSTMENT-DRAFT",
      });
      await db.execute(sql`
        update documents
           set posting_date = ${org.date},
               posting_period_id = ${adjustmentPeriodId},
               updated_at = '2026-07-15 12:00:00+00'
         where id = ${adjustmentDocumentId}
      `);

      const adjustmentFxEntryId = randomUUID();
      await db.execute(sql`
        insert into journal_entries
          (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
           period_id, memo, status, origin)
        values (
          ${adjustmentFxEntryId}, ${org.orgId}, ${org.bookId},
          ${org.subsidiaryId}, 'ADJUSTMENT-FX', ${org.date},
          ${adjustmentPeriodId}, 'Adjustment-period foreign position',
          'draft', 'manual'
        )
      `);
      await db.execute(sql`
        insert into journal_lines
          (org_id, entry_id, line_number, account_id, subsidiary_id,
           amount, currency, txn_amount, fx_rate)
        values
          (${org.orgId}, ${adjustmentFxEntryId}, 1, ${org.accounts.bank},
           ${org.subsidiaryId}, '125', 'USD', '100', '1.25'),
          (${org.orgId}, ${adjustmentFxEntryId}, 2, ${org.accounts.revenue},
           ${org.subsidiaryId}, '-125', 'CAD', '-125', '1')
      `);
      await db.execute(sql`
        update journal_entries
           set status = 'posted', posted_at = now()
         where id = ${adjustmentFxEntryId}
      `);

      const runId = await startCloseRun({
        orgId: org.orgId,
        periodId: org.periodId,
        bookId: org.bookId,
        actorId: actors.adminId,
      });
      const initial = await refreshCloseRun(
        org.orgId,
        runId,
        actors.adminId,
      );
      const initialDrafts = (await db.execute(sql`
        select status, details
          from close_exceptions
         where run_id = ${runId} and code = 'drafts-open'
      `)) as unknown as {
        rows: { status: string; details: { count: number } }[];
      };
      assert.equal(initialDrafts.rows.length, 0);
      const initialFx = (await db.execute(sql`
        select status, details
          from close_exceptions
         where run_id = ${runId} and code = 'fx-unrevalued'
      `)) as unknown as {
        rows: { status: string; details: { count: number } }[];
      };
      assert.equal(initialFx.rows.length, 0);

      await db.execute(sql`
        update documents
           set memo = 'Adjustment evidence updated',
               updated_at = '2026-07-15 12:01:00+00'
         where id = ${adjustmentDocumentId}
      `);
      const afterAdjustmentChange = await refreshCloseRun(
        org.orgId,
        runId,
        actors.adminId,
      );
      assert.equal(afterAdjustmentChange.fingerprint, initial.fingerprint);

      const unassignedDocumentId = await seedDraftDocument(org.orgId, {
        kind: "vendor_bill",
        createdBy: actors.adminId,
        number: "UNASSIGNED-PERIOD-DRAFT",
      });
      await db.execute(sql`
        update documents
           set posting_date = ${org.date},
               posting_period_id = null,
               updated_at = '2026-07-15 12:02:00+00'
         where id = ${unassignedDocumentId}
      `);
      const afterUnassignedDocument = await refreshCloseRun(
        org.orgId,
        runId,
        actors.adminId,
      );
      assert.notEqual(afterUnassignedDocument.fingerprint, initial.fingerprint);
      const exactPeriodDrafts = (await db.execute(sql`
        select status, details
          from close_exceptions
         where run_id = ${runId} and code = 'drafts-open'
      `)) as unknown as {
        rows: { status: string; details: { count: number } }[];
      };
      assert.ok(exactPeriodDrafts.rows.length === 0 || exactPeriodDrafts.rows[0]!.status === "resolved");
      const missingPeriod = (await db.execute(sql`
        select status, details
          from close_exceptions
         where run_id = ${runId} and code = 'posting-period-missing'
      `)) as unknown as {
        rows: { status: string; details: { count: number } }[];
      };
      assert.equal(missingPeriod.rows[0]!.status, "open");
      assert.equal(Number(missingPeriod.rows[0]!.details.count), 1);

      await db.execute(sql`
        update documents
           set posting_period_id = ${adjustmentPeriodId},
               updated_at = '2026-07-15 12:03:00+00'
         where id = ${unassignedDocumentId}
      `);
      const afterExactAdjustmentScope = await refreshCloseRun(
        org.orgId,
        runId,
        actors.adminId,
      );
      assert.equal(afterExactAdjustmentScope.fingerprint, initial.fingerprint);
      const resolvedPeriodIdentity = (await db.execute(sql`
        select status, details
          from close_exceptions
         where run_id = ${runId} and code = 'posting-period-missing'
      `)) as unknown as {
        rows: { status: string; details: { count: number } }[];
      };
      assert.equal(resolvedPeriodIdentity.rows[0]!.status, "resolved");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
