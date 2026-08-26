import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { PoolClient } from "pg";
import { sql } from "drizzle-orm";
import { closeApprovedRun, refreshCloseRun, startCloseRun } from "./close.ts";
import { db, pool } from "./db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedDraftDocument,
  seedFlowActors,
  type ScratchOrg,
} from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * The advisory key the close service takes exclusively (periodScopeAdvisoryLock)
 * and the kernel's je_guard takes shared (period_posting_fence). Both sides
 * must hash this exact string for the fence to close the posting/close race.
 */
function closeFenceKey(org: Pick<ScratchOrg, "orgId" | "periodId" | "bookId">): string {
  return `period-lock:${org.orgId}:${org.periodId}:${org.bookId}`;
}

/** Poll until some backend has granted, or is waiting on, the scope fence.
 * pg_locks exposes a 64-bit advisory key split across classid (high bits)
 * and objid (low bits, displayed unsigned), so both halves must match. */
async function waitForFenceState(
  key: string,
  want: "granted" | "waiting",
): Promise<boolean> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const rows = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n
        from pg_locks,
             (select hashtextextended(${key}, 0) as h) as k
       where locktype = 'advisory'
         and classid::text = ((k.h >> 32) & 4294967295)::text
         and objid::text = (k.h & 4294967295)::text
         and granted = ${want === "granted"}
    `));
    if ((rows.rows[0]?.n ?? 0) > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

/**
 * A close run driven straight to `approved`, plus the ledger subject for the
 * race. Approval is stamped directly because the serialization contract under
 * test lives between an approved run's final refresh and its lock writes —
 * the approval-routing flow is different machinery.
 */
async function seedApprovedCloseRun(org: ScratchOrg): Promise<{
  runId: string;
  entryId: string;
  actorId: string;
}> {
  const actors = await seedFlowActors(org.orgId);
  const entryId = randomUUID();
  await db.execute(sql`
    insert into journal_entries
      (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
    values (
      ${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId},
      'CLOSE-RACE', ${org.date}, ${org.periodId}, 'close race subject',
      'draft', 'manual'
    )`);
  await db.execute(sql`
    insert into journal_lines
      (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
    values
      (${org.orgId}, ${entryId}, 1, ${org.accounts.bank},
       ${org.subsidiaryId}, '500', 'CAD', '500', '1'),
      (${org.orgId}, ${entryId}, 2, ${org.accounts.revenue},
       ${org.subsidiaryId}, '-500', 'CAD', '-500', '1')
  `);
  const runId = await startCloseRun({
    orgId: org.orgId,
    periodId: org.periodId,
    bookId: org.bookId,
    actorId: actors.adminId,
  });
  await db.execute(sql`
    update close_runs set status = 'approved', current_stage = 'lock', approved_at = now(),
           approved_by = ${actors.adminId}, updated_at = now(), updated_by = ${actors.adminId}
     where id = ${runId} and org_id = ${org.orgId}`);
  return { runId, entryId, actorId: actors.adminId };
}

async function runStatus(runId: string, orgId: string): Promise<string> {
  const rows = (await db.execute<{ status: string }>(sql`
    select status from close_runs where id = ${runId} and org_id = ${orgId}`));
  return rows.rows[0]!.status;
}

/** Every GL lock row for the close scope must read 'closed' after a completed close. */
async function assertScopeLockedClosed(org: ScratchOrg): Promise<void> {
  const rows = (await db.execute<{ module: string; state: string }>(sql`
    select module, state from period_locks
     where org_id = ${org.orgId} and period_id = ${org.periodId} and book_id = ${org.bookId}`));
  assert.ok(rows.rows.length > 0, "a completed close must write module locks");
  for (const row of rows.rows) {
    assert.equal(row.state, "closed", `module ${row.module} must end closed`);
  }
}

test(
  "an in-flight posting that wins the fence lands before the close's final refresh",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    let poster: PoolClient | undefined;
    try {
      const { runId, entryId, actorId } = await seedApprovedCloseRun(org);

      // Session P passes the draft->posted trigger and freezes, uncommitted,
      // holding the shared side of the fence — the audited interleave.
      poster = await pool.connect();
      await poster.query("begin");
      await poster.query(
        "update journal_entries set status = 'posted', posted_at = now() where id = $1",
        [entryId],
      );

      const closing = closeApprovedRun(org.orgId, runId, actorId);
      assert.ok(
        await waitForFenceState(closeFenceKey(org), "waiting"),
        "the close must park on the scope fence behind the in-flight posting instead of evaluating and committing over it",
      );

      // Let the posting win: it commits while the close is still parked, so
      // the close's final refresh runs strictly after the ledger changed.
      await poster.query("commit");

      // The fence held, so the parked close re-reads the ledger only after
      // this posting committed and locks the period with that evaluation —
      // never over a write that was still in flight.
      await closing;
      assert.equal(await runStatus(runId, org.orgId), "closed");
      await assertScopeLockedClosed(org);
      const stored = (await db.execute<{ data_fingerprint: string | null }>(sql`
        select data_fingerprint from close_runs where id = ${runId} and org_id = ${org.orgId}`))
        .rows[0]!.data_fingerprint;
      // Re-evaluating the settled ledger must agree with the stored evidence:
      // if the close had evaluated before the posting committed, its stored
      // fingerprint would drift from this recomputation now.
      const reread = await refreshCloseRun(org.orgId, runId, actorId);
      assert.equal(reread.fingerprint, stored);
      assert.equal(reread.invalidated, 0);
      assert.equal(await runStatus(runId, org.orgId), "closed");
      const posted = (await db.execute<{ status: string }>(sql`
        select status from journal_entries where id = ${entryId}`));
      assert.equal(posted.rows[0]!.status, "posted");
    } finally {
      if (poster) {
        await poster.query("rollback").catch(() => undefined);
        poster.release();
      }
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "an injected close failure rolls back every module lock, run-state write and close event",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actors = await seedFlowActors(org.orgId);
      const entryId = randomUUID();
      await db.execute(sql`
        insert into journal_entries
          (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
        values (
          ${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId},
          'CLOSE-ROLLBACK', ${org.date}, ${org.periodId}, 'close rollback subject',
          'draft', 'manual'
        )`);
      await db.execute(sql`
        insert into journal_lines
          (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
        values
          (${org.orgId}, ${entryId}, 1, ${org.accounts.bank},
           ${org.subsidiaryId}, '500', 'CAD', '500', '1'),
          (${org.orgId}, ${entryId}, 2, ${org.accounts.revenue},
           ${org.subsidiaryId}, '-500', 'CAD', '-500', '1')
      `);
      await db.execute(sql`
        update journal_entries set status = 'posted', posted_at = now()
         where id = ${entryId}`);
      const runId = await startCloseRun({
        orgId: org.orgId,
        periodId: org.periodId,
        bookId: org.bookId,
        actorId: actors.adminId,
      });
      await db.execute(sql`
        update close_runs set status = 'approved', current_stage = 'lock', approved_at = now(),
               approved_by = ${actors.adminId}, updated_at = now(), updated_by = ${actors.adminId}
         where id = ${runId} and org_id = ${org.orgId}`);

      // Sabotage the LAST statement of the close transaction: one 'run.closed'
      // event may exist per run, and one is planted before the close runs, so
      // the close's own event insert fails only after every module lock, task
      // completion and run-state write has already been staged.
      await db.execute(sql`
        create unique index close_events_run_closed_once_regression
          on close_events (run_id) where event_type = 'run.closed'`);
      await db.execute(sql`
        insert into close_events (org_id, run_id, event_type, actor_id, payload)
        values (${org.orgId}, ${runId}, 'run.closed', null, '{}'::jsonb)`);
      try {
        await assert.rejects(
          () => closeApprovedRun(org.orgId, runId, actors.adminId),
          (error: unknown) => {
            // Drizzle wraps the driver error; the constraint name lives on
            // the underlying cause.
            const cause = (error as { cause?: unknown })?.cause ?? error;
            return /close_events_run_closed_once_regression/.test(
              String((cause as { message?: string })?.message ?? cause),
            );
          },
          "the injected failure must be the sabotaged final statement, after all other close writes",
        );
        const closedLocks = (await db.execute<{ n: number }>(sql`
          select count(*)::int as n from period_locks
           where org_id = ${org.orgId} and period_id = ${org.periodId} and book_id = ${org.bookId}
             and state = 'closed'`));
        assert.equal(closedLocks.rows[0]!.n, 0, "every module lock must roll back");
        assert.equal(await runStatus(runId, org.orgId), "approved");
        const runRow = (await db.execute<{ closed_at: Date | null }>(sql`
          select closed_at from close_runs where id = ${runId} and org_id = ${org.orgId}`));
        assert.equal(runRow.rows[0]!.closed_at, null);
        const lockTasks = (await db.execute<{ n: number }>(sql`
          select count(*)::int as n from close_run_tasks
           where run_id = ${runId} and org_id = ${org.orgId}
             and key in ('lock-subledgers', 'lock-gl') and status = 'complete'`));
        assert.equal(lockTasks.rows[0]!.n, 0, "lock task completions must roll back");
        const closedEvents = (await db.execute<{ n: number }>(sql`
          select count(*)::int as n from close_events
           where run_id = ${runId} and org_id = ${org.orgId} and event_type = 'run.closed'`));
        assert.equal(closedEvents.rows[0]!.n, 1, "only the planted event may remain");
      } finally {
        await db.execute(sql`drop index close_events_run_closed_once_regression`);
      }
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "close controls require an exact document period and never infer one from a date",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actors = await seedFlowActors(org.orgId);
      const calendar = (await db.execute<{ fiscal_calendar_id: string }>(sql`
        select fiscal_calendar_id
          from accounting_periods
         where id = ${org.periodId}
      `));
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
      const initialDrafts = (await db.execute<{ status: string; details: { count: number } }>(sql`
        select status, details
          from close_exceptions
         where run_id = ${runId} and code = 'drafts-open'
      `));
      assert.equal(initialDrafts.rows.length, 0);
      const initialFx = (await db.execute<{ status: string; details: { count: number } }>(sql`
        select status, details
          from close_exceptions
         where run_id = ${runId} and code = 'fx-unrevalued'
      `));
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
      const exactPeriodDrafts = (await db.execute<{ status: string; details: { count: number } }>(sql`
        select status, details
          from close_exceptions
         where run_id = ${runId} and code = 'drafts-open'
      `));
      assert.ok(exactPeriodDrafts.rows.length === 0 || exactPeriodDrafts.rows[0]!.status === "resolved");
      const missingPeriod = (await db.execute<{ status: string; details: { count: number } }>(sql`
        select status, details
          from close_exceptions
         where run_id = ${runId} and code = 'posting-period-missing'
      `));
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
      const resolvedPeriodIdentity = (await db.execute<{ status: string; details: { count: number } }>(sql`
        select status, details
          from close_exceptions
         where run_id = ${runId} and code = 'posting-period-missing'
      `));
      assert.equal(resolvedPeriodIdentity.rows[0]!.status, "resolved");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
