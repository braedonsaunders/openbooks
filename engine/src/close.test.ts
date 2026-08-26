import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import {
  decidePeriodReopen,
  requestPeriodReopen,
  setPeriodLockState,
  periodLockBlocksPosting,
} from "./close.ts";
import { db } from "./db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
  type ScratchOrg,
} from "./test-fixtures.ts";

const now = new Date("2026-07-20T12:00:00Z");

test("historical replay bypasses only source-imported period locks", () => {
  assert.equal(periodLockBlocksPosting({
    state: "closed",
    reopenExpiresAt: null,
    reason: "close.importedPeriodLockReason",
  }, false, now), true);
  assert.equal(periodLockBlocksPosting({
    state: "closed",
    reopenExpiresAt: null,
    reason: "close.importedPeriodLockReason",
  }, true, now), false);
  assert.equal(periodLockBlocksPosting({
    state: "closed",
    reopenExpiresAt: null,
    reason: "controller_close",
  }, true, now), true);
});

test("expired temporary reopening closes again", () => {
  assert.equal(periodLockBlocksPosting({
    state: "open",
    reopenExpiresAt: "2026-07-20T11:59:59Z",
    reason: "controller_reopen",
  }, false, now), true);
  assert.equal(periodLockBlocksPosting({
    state: "open",
    reopenExpiresAt: "2026-07-20T12:00:01Z",
    reason: "controller_reopen",
  }, false, now), false);
});

const DB = !!process.env.OPENBOOKS_DB_URL;

function errorChainMatches(error: unknown, pattern: RegExp): boolean {
  const messages: string[] = [];
  for (
    let current: unknown = error;
    current && typeof current === "object";
    current = (current as { cause?: unknown }).cause
  ) {
    messages.push(String((current as { message?: unknown }).message ?? ""));
  }
  return pattern.test(messages.join(" "));
}

const CLOSE_REASON = "slice year-end close";

async function closeAllGlobally(
  org: ScratchOrg,
  actorId: string,
): Promise<void> {
  for (const module of ["ar", "ap", "banking", "assets", "tax"] as const) {
    await setPeriodLockState({
      orgId: org.orgId,
      periodId: org.periodId,
      bookId: org.bookId,
      module,
      state: "closed",
      actorId,
      reason: CLOSE_REASON,
    });
  }
  await setPeriodLockState({
    orgId: org.orgId,
    periodId: org.periodId,
    bookId: org.bookId,
    module: "gl",
    state: "closed",
    actorId,
    reason: CLOSE_REASON,
  });
}

/** The kernel's own storage guard for one subsidiary scope. */
async function storageBlocksWrite(
  org: ScratchOrg,
  module: string,
): Promise<boolean> {
  const result = (await db.execute<{ blocked: boolean }>(sql`
    select period_module_blocks_write(
             ${org.orgId}::uuid, ${org.periodId}::uuid, ${org.bookId}::uuid,
             ${org.subsidiaryId}::uuid, ${module}, false) as blocked`));
  return result.rows[0]!.blocked;
}

async function lockChangeCounts(
  org: ScratchOrg,
): Promise<{ locks: number; events: number; audits: number }> {
  const result = (await db.execute<{
    locks: number;
    events: number;
    audits: number;
  }>(sql`
    select
      (select count(*)::int from period_locks where org_id = ${org.orgId}) as locks,
      (select count(*)::int from close_events
        where org_id = ${org.orgId} and event_type = 'period.lock_changed') as events,
      (select count(*)::int from audit_log
        where org_id = ${org.orgId} and table_name = 'period_locks') as audits`));
  return result.rows[0]!;
}

test(
  "a scoped lock relaxation cannot shadow an effective org-wide close",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actors = await seedFlowActors(org.orgId);
      await closeAllGlobally(org, actors.adminId);
      assert.equal(await storageBlocksWrite(org, "gl"), true);
      const baseline = await lockChangeCounts(org);

      await assert.rejects(
        setPeriodLockState({
          orgId: org.orgId,
          periodId: org.periodId,
          bookId: org.bookId,
          subsidiaryId: org.subsidiaryId,
          module: "gl",
          state: "open",
          actorId: actors.adminId,
          reason: "routine scope tweak",
        }),
        (error: unknown) =>
          errorChainMatches(error, /approved reopen request/),
      );
      await assert.rejects(
        setPeriodLockState({
          orgId: org.orgId,
          periodId: org.periodId,
          bookId: org.bookId,
          subsidiaryId: org.subsidiaryId,
          module: "ar",
          state: "soft_closed",
          actorId: actors.adminId,
          reason: "routine scope tweak",
        }),
        (error: unknown) =>
          errorChainMatches(error, /approved reopen request/),
      );
      await assert.rejects(
        setPeriodLockState({
          orgId: org.orgId,
          periodId: org.periodId,
          bookId: org.bookId,
          module: "gl",
          state: "soft_closed",
          actorId: actors.adminId,
          reason: "routine scope tweak",
        }),
        (error: unknown) =>
          errorChainMatches(error, /approved reopen request/),
      );

      const after = await lockChangeCounts(org);
      assert.deepEqual(after, baseline);
      assert.equal(await storageBlocksWrite(org, "gl"), true);
      assert.equal(await storageBlocksWrite(org, "ar"), true);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "an active approved reopen window cannot be rewritten by routine administration",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actors = await seedFlowActors(org.orgId);
      await closeAllGlobally(org, actors.adminId);
      const requestId = await requestPeriodReopen({
        orgId: org.orgId,
        periodId: org.periodId,
        bookId: org.bookId,
        subsidiaryId: org.subsidiaryId,
        modules: ["gl"],
        reason: "auditor requested corrections",
        actorId: actors.adminId,
      });
      await decidePeriodReopen({
        orgId: org.orgId,
        requestId,
        actorId: actors.approver1Id,
        approve: true,
      });
      const reopened = (await db.execute<{ state: string }>(sql`
        select state from period_locks
         where org_id = ${org.orgId} and period_id = ${org.periodId}
           and book_id = ${org.bookId} and subsidiary_id = ${org.subsidiaryId}::uuid
           and module = 'gl'`));
      assert.equal(reopened.rows[0]!.state, "open");

      await assert.rejects(
        setPeriodLockState({
          orgId: org.orgId,
          periodId: org.periodId,
          bookId: org.bookId,
          subsidiaryId: org.subsidiaryId,
          module: "gl",
          state: "open",
          actorId: actors.adminId,
          reason: "routine scope tweak",
        }),
        (error: unknown) => errorChainMatches(error, /active reopen window/),
      );
      await assert.rejects(
        setPeriodLockState({
          orgId: org.orgId,
          periodId: org.periodId,
          bookId: org.bookId,
          subsidiaryId: org.subsidiaryId,
          module: "gl",
          state: "soft_closed",
          actorId: actors.adminId,
          reason: "routine scope tweak",
        }),
        (error: unknown) => errorChainMatches(error, /active reopen window/),
      );

      // Tightening the reopened scope is always allowed.
      await setPeriodLockState({
        orgId: org.orgId,
        periodId: org.periodId,
        bookId: org.bookId,
        subsidiaryId: org.subsidiaryId,
        module: "gl",
        state: "closed",
        actorId: actors.adminId,
        reason: "corrections complete",
      });
      const reclosed = (await db.execute<{ state: string }>(sql`
        select state from period_locks
         where org_id = ${org.orgId} and period_id = ${org.periodId}
           and book_id = ${org.bookId} and subsidiary_id = ${org.subsidiaryId}::uuid
           and module = 'gl'`));
      assert.equal(reclosed.rows[0]!.state, "closed");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "an expired reopen window is an effective close for lock administration",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actors = await seedFlowActors(org.orgId);
      await closeAllGlobally(org, actors.adminId);
      const requestId = await requestPeriodReopen({
        orgId: org.orgId,
        periodId: org.periodId,
        bookId: org.bookId,
        subsidiaryId: org.subsidiaryId,
        modules: ["gl"],
        reason: "short controlled window",
        actorId: actors.adminId,
      });
      await decidePeriodReopen({
        orgId: org.orgId,
        requestId,
        actorId: actors.approver1Id,
        approve: true,
        hours: 1,
      });
      await db.execute(sql`
        update period_locks
           set reopen_expires_at = now() - interval '1 minute'
         where org_id = ${org.orgId} and period_id = ${org.periodId}
           and book_id = ${org.bookId} and subsidiary_id = ${org.subsidiaryId}::uuid
           and module = 'gl'`);
      assert.equal(await storageBlocksWrite(org, "gl"), true);

      await assert.rejects(
        setPeriodLockState({
          orgId: org.orgId,
          periodId: org.periodId,
          bookId: org.bookId,
          subsidiaryId: org.subsidiaryId,
          module: "gl",
          state: "open",
          actorId: actors.adminId,
          reason: "refresh the elapsed window",
        }),
        (error: unknown) =>
          errorChainMatches(error, /approved reopen request/),
      );
      assert.equal(await storageBlocksWrite(org, "gl"), true);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "only an approved reopen restores posting beneath a scope-wide close",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actors = await seedFlowActors(org.orgId);
      await closeAllGlobally(org, actors.adminId);

      async function draftBalancedEntry(number: string): Promise<string> {
        const id = randomUUID();
        await db.execute(sql`
          insert into journal_entries
            (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
             period_id, memo, status, origin)
          values (${id}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId},
                  ${number}, ${org.date}, ${org.periodId}, ${number},
                  'draft', 'manual')`);
        await db.execute(sql`
          insert into journal_lines
            (org_id, entry_id, line_number, account_id, subsidiary_id,
             amount, currency, txn_amount, fx_rate)
          values
            (${org.orgId}, ${id}, 1, ${org.accounts.bank}, ${org.subsidiaryId},
             '10', 'CAD', '10', '1'),
            (${org.orgId}, ${id}, 2, ${org.accounts.revenue}, ${org.subsidiaryId},
             '-10', 'CAD', '-10', '1')`);
        return id;
      }

      const rejectedEntry = await draftBalancedEntry("LOCKED-POST-A");
      await assert.rejects(
        db.transaction(async (tx) => {
          await tx.execute(sql`
            update journal_entries set status = 'posted', posted_at = now()
             where id = ${rejectedEntry}`);
        }),
        (error: unknown) =>
          errorChainMatches(error, /period is closed for GL posting/),
      );

      const requestId = await requestPeriodReopen({
        orgId: org.orgId,
        periodId: org.periodId,
        bookId: org.bookId,
        subsidiaryId: org.subsidiaryId,
        modules: ["gl"],
        reason: "late adjusting entry",
        actorId: actors.adminId,
      });
      await decidePeriodReopen({
        orgId: org.orgId,
        requestId,
        actorId: actors.approver1Id,
        approve: true,
      });
      const window = (await db.execute<{
        state: string;
        expires: Date | null;
      }>(sql`
        select state, reopen_expires_at as expires from period_locks
         where org_id = ${org.orgId} and period_id = ${org.periodId}
           and book_id = ${org.bookId} and subsidiary_id = ${org.subsidiaryId}::uuid
           and module = 'gl'`));
      assert.equal(window.rows[0]!.state, "open");
      assert.ok(window.rows[0]!.expires != null);
      assert.ok(new Date(window.rows[0]!.expires!) > new Date());
      assert.equal(await storageBlocksWrite(org, "gl"), false);

      const approvedEntry = await draftBalancedEntry("REOPENED-POST-B");
      await db.transaction(async (tx) => {
        await tx.execute(sql`
          update journal_entries set status = 'posted', posted_at = now()
           where id = ${approvedEntry}`);
      });
      const posted = (await db.execute<{ status: string }>(sql`
        select status from journal_entries where id = ${approvedEntry}`));
      assert.equal(posted.rows[0]!.status, "posted");

      // Other scopes stay governed by the org-wide close.
      assert.equal(await storageBlocksWrite(org, "ar"), true);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a racing scoped relaxation cannot outlive a simultaneous scope-wide close",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actors = await seedFlowActors(org.orgId);
      const outcomes = await Promise.allSettled([
        setPeriodLockState({
          orgId: org.orgId,
          periodId: org.periodId,
          bookId: org.bookId,
          module: "ar",
          state: "closed",
          actorId: actors.adminId,
          reason: CLOSE_REASON,
        }),
        setPeriodLockState({
          orgId: org.orgId,
          periodId: org.periodId,
          bookId: org.bookId,
          subsidiaryId: org.subsidiaryId,
          module: "ar",
          state: "open",
          actorId: actors.adminId,
          reason: "routine scope tweak",
        }),
      ]);
      assert.equal(outcomes[0]!.status, "fulfilled");
      if (outcomes[1]!.status === "rejected") {
        assert.match(
          String((outcomes[1]!.reason as Error).message),
          /approved reopen request/,
        );
      }
      // Either order must end with the whole scope closed.
      assert.equal(await storageBlocksWrite(org, "ar"), true);
      const childRows = (await db.execute<{ state: string }>(sql`
        select state from period_locks
         where org_id = ${org.orgId} and period_id = ${org.periodId}
           and book_id = ${org.bookId} and subsidiary_id = ${org.subsidiaryId}::uuid
           and module = 'ar'`));
      assert.ok(
        childRows.rows.length === 0 || childRows.rows.every((row) => row.state === "closed"),
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a failed event or audit write rolls the entire lock transition back",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actors = await seedFlowActors(org.orgId);
      await db.execute(sql`
        create function plock_inject_failure() returns trigger language plpgsql as $$
        begin raise exception 'injected failure'; end $$;`);
      await db.execute(sql`
        create trigger plock_event_inject before insert on close_events
          for each row when (new.payload->>'reason' = 'INJECT-EVENT')
          execute function plock_inject_failure()`);
      await db.execute(sql`
        create trigger plock_audit_inject before insert on audit_log
          for each row when (new.table_name = 'period_locks'
            and new.changes::text like '%INJECT-AUDIT%')
          execute function plock_inject_failure()`);
      try {
        const baseline = await lockChangeCounts(org);

        await assert.rejects(
          setPeriodLockState({
            orgId: org.orgId,
            periodId: org.periodId,
            bookId: org.bookId,
            module: "ar",
            state: "soft_closed",
            actorId: actors.adminId,
            reason: "INJECT-EVENT",
          }),
          (error: unknown) => errorChainMatches(error, /injected failure/),
        );
        assert.deepEqual(await lockChangeCounts(org), baseline);

        await assert.rejects(
          setPeriodLockState({
            orgId: org.orgId,
            periodId: org.periodId,
            bookId: org.bookId,
            module: "ap",
            state: "soft_closed",
            actorId: actors.adminId,
            reason: "INJECT-AUDIT",
          }),
          (error: unknown) => errorChainMatches(error, /injected failure/),
        );
        assert.deepEqual(await lockChangeCounts(org), baseline);

        await setPeriodLockState({
          orgId: org.orgId,
          periodId: org.periodId,
          bookId: org.bookId,
          module: "ar",
          state: "soft_closed",
          actorId: actors.adminId,
          reason: "clean transition",
        });
        const after = await lockChangeCounts(org);
        assert.equal(after.locks, baseline.locks + 1);
        assert.equal(after.events, baseline.events + 1);
        assert.equal(after.audits, baseline.audits + 1);
      } finally {
        await db.execute(
          sql`drop trigger if exists plock_event_inject on close_events`,
        );
        await db.execute(
          sql`drop trigger if exists plock_audit_inject on audit_log`,
        );
        await db.execute(
          sql`drop function if exists plock_inject_failure()`,
        );
      }
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
