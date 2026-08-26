import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sql } from "drizzle-orm";
import {
  CloseError,
  closeModuleForDocument,
  decidePeriodReopen,
  requestPeriodReopen,
  setPeriodLockState,
  periodLockBlocksPosting,
} from "./close.ts";
import { db, withBypass, withOrgTransaction } from "./db.ts";
import { submitAndReleaseIfUngated } from "./flows/submit.ts";
import { postDocument } from "./posting.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  seedFlowActors,
  type ScratchOrg,
} from "./test-fixtures.ts";
import { DOC_KINDS } from "../../web/lib/document-kinds.ts";

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

test("cash documents map to their AP and banking close modules", () => {
  assert.equal(closeModuleForDocument("check"), "ap");
  assert.equal(closeModuleForDocument("deposit"), "banking");
  assert.equal(closeModuleForDocument("transfer"), "banking");
  // Card instruments deliberately ride the AP lock (their permission
  // namespace is ap); a banking lock must not be their gate.
  assert.equal(closeModuleForDocument("card_charge"), "ap");
  assert.equal(closeModuleForDocument("card_refund"), "ap");
});

test("every drawer document kind carries a deliberate close-module decision", () => {
  const registryKinds = Object.keys(DOC_KINDS);
  assert.ok(registryKinds.length > 0);
  for (const kind of registryKinds) {
    const cfg = DOC_KINDS[kind]!;
    assert.equal(
      closeModuleForDocument(kind),
      cfg.closeModule,
      `document kind "${kind}" must map to the close module declared on its web/lib/document-kinds.ts entry`,
    );
  }
});

test("an unmapped document kind fails explicitly instead of posting under GL alone", () => {
  assert.throws(
    () => closeModuleForDocument("not_a_real_document_kind"),
    CloseError,
  );
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

// ---------------------------------------------------------------------------
// Cash documents versus their own period locks. The production entry point is
// postDocument — the same call every drawer, API route, and importer makes —
// so these regressions exercise that path, not a helper beside it.
// ---------------------------------------------------------------------------

const POST_DEPS = (org: ScratchOrg) => ({
  control: {
    ar: org.accounts.ar,
    ap: org.accounts.ap,
    bank: org.accounts.bank,
  },
});

/** Seed an approved-ready draft cash document honouring its posting rule. */
async function seedCashDocument(
  org: ScratchOrg,
  kind: "check" | "deposit" | "transfer",
  number: string,
  createdBy: string,
): Promise<string> {
  const documentId = randomUUID();
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, status, document_number, subsidiary_id,
       document_date, currency, subtotal, tax_total, total, created_by)
    values (
      ${documentId}, ${org.orgId}, ${kind}, 'draft', ${number},
      ${org.subsidiaryId}, ${org.date}, 'CAD', '10', '0', '10', ${createdBy}
    )
  `);
  if (kind === "transfer") {
    // Kernel contract: line 0 = destination carrying the amount, line 1 =
    // source naming only its account with zero.
    await db.execute(sql`
      insert into document_lines
        (org_id, document_id, line_number, account_id, subsidiary_id,
         amount, quantity, unit_price, tax_amount, tax_input_amount)
      values
        (${org.orgId}, ${documentId}, 1, ${org.accounts.bank}, ${org.subsidiaryId},
         '10', '1', '10', '0', '10'),
        (${org.orgId}, ${documentId}, 2, ${org.accounts.clearing}, ${org.subsidiaryId},
         '0', '1', '0', '0', '0')
    `);
  } else {
    await db.execute(sql`
      insert into document_lines
        (org_id, document_id, line_number, account_id, subsidiary_id,
         amount, quantity, unit_price, tax_amount, tax_input_amount)
      values
        (${org.orgId}, ${documentId}, 1,
         ${kind === "check" ? org.accounts.cogs : org.accounts.revenue},
         ${org.subsidiaryId}, '10', '1', '10', '0', '10')
    `);
  }
  return documentId;
}

async function postCashDocumentThroughKernel(
  org: ScratchOrg,
  actorId: string,
  kind: "check" | "deposit" | "transfer",
  number: string,
): Promise<void> {
  const documentId = await seedCashDocument(org, kind, number, actorId);
  await withOrgTransaction(org.orgId, async () => {
    const released = await submitAndReleaseIfUngated(kind, documentId, actorId);
    assert.equal(released.autoApproved, true);
    await postDocument(documentId, POST_DEPS(org), { deferEffects: true });
  });
}

test(
  "cash documents post through the kernel while their modules are open",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    try {
      const actorId = await withBypass(() =>
        createScratchUser(org.orgId, "Cash poster", "admin"),
      );
      // Validity control for the closed-lock rejections below: each seeded
      // cash document genuinely posts when no lock stands in the way.
      await postCashDocumentThroughKernel(org, actorId, "check", "CHK-OPEN-1");
      await postCashDocumentThroughKernel(org, actorId, "deposit", "DEP-OPEN-1");
      await postCashDocumentThroughKernel(org, actorId, "transfer", "TRF-OPEN-1");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a closed AP period rejects a check",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    try {
      const actorId = await withBypass(() =>
        createScratchUser(org.orgId, "Check poster", "admin"),
      );
      await setPeriodLockState({
        orgId: org.orgId,
        periodId: org.periodId,
        bookId: org.bookId,
        module: "ap",
        state: "closed",
        actorId,
        reason: CLOSE_REASON,
      });
      await assert.rejects(
        postCashDocumentThroughKernel(org, actorId, "check", "CHK-LOCKED-1"),
        (error: unknown) => errorChainMatches(error, /AP is closed/),
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a closed banking period rejects a deposit and a transfer",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    try {
      const actorId = await withBypass(() =>
        createScratchUser(org.orgId, "Banking poster", "admin"),
      );
      await setPeriodLockState({
        orgId: org.orgId,
        periodId: org.periodId,
        bookId: org.bookId,
        module: "banking",
        state: "closed",
        actorId,
        reason: CLOSE_REASON,
      });
      await assert.rejects(
        postCashDocumentThroughKernel(org, actorId, "deposit", "DEP-LOCKED-1"),
        (error: unknown) => errorChainMatches(error, /BANKING is closed/),
      );
      await assert.rejects(
        postCashDocumentThroughKernel(org, actorId, "transfer", "TRF-LOCKED-1"),
        (error: unknown) => errorChainMatches(error, /BANKING is closed/),
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test("close automation claims carry lease fencing, stale takeover, and stage checkpoints", () => {
  const engine = readFileSync(new URL("./close.ts", import.meta.url), "utf8");

  // The claim books a random fencing token with its lock timestamp and the
  // conflict contract that keeps concurrent schedulers single-fire.
  assert.match(
    engine,
    /insert into close_automation_executions[\s\S]*?gen_random_uuid\(\), now\(\)[\s\S]*?on conflict \(rule_id, event_key\) do nothing returning id/,
  );

  // A crashed running claim is reclaimed by compare-and-set over its stored
  // token: concurrent recoverers race cleanly and only one ever wins.
  assert.match(engine, /CLOSE_AUTOMATION_STALE_CLAIM_MS/);
  assert.match(
    engine,
    /attempt_count = attempt_count \+ 1,[\s\S]*?lease_token = gen_random_uuid\(\),[\s\S]*?locked_at = now\(\)/,
  );
  assert.match(
    engine,
    /and lease_token is not distinct from \$\{existing\.lease_token\}/,
  );

  // Every effect checkpoint and terminal transition must match the active
  // token, so an attempt fenced by a takeover cannot corrupt the outcome.
  assert.match(
    engine,
    /status = 'running'\s+and lease_token = \$\{args\.leaseToken\}/,
  );
  assert.match(engine, /CloseAutomationLeaseFencedError/);

  // Non-idempotent unit effects commit with their stage checkpoint in one
  // transaction; a resumed attempt skips what already committed.
  assert.match(engine, /stageKey: `notify:\$\{user\.id\}`/);
  assert.match(engine, /stages = stages \|\| \$\{JSON\.stringify\(/);

  // The terminal status write and its audit event commit together so a crash
  // between them cannot orphan a half-recorded outcome.
  assert.match(engine, /["']automation\.completed["']/);
  assert.match(engine, /["']automation\.failed["']/);
});

test("close automation execution schema carries the claim-lease columns", () => {
  const schema = readFileSync(
    new URL("../../schema/src/close.ts", import.meta.url),
    "utf8",
  );
  const executions = schema.slice(schema.indexOf("closeAutomationExecutions"));
  assert.match(executions, /leaseToken: uuid\("lease_token"\)/);
  assert.match(executions, /lockedAt: timestamp\("locked_at", \{ withTimezone: true \}\)/);
  assert.match(executions, /attemptCount: integer\("attempt_count"\)\.notNull\(\)\.default\(0\)/);
  assert.match(executions, /stages: jsonb\("stages"\)\.notNull\(\)\.default\(\{\}\)/);
});
