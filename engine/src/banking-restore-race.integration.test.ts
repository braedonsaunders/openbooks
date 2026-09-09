import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "./db.ts";
import {
  adjustReconciliation,
  BankingError,
  excludeStatementLine,
  importStatement,
  markReconciled,
  reconciliationTotals,
  restoreStatementLine,
  startReconciliation,
} from "./banking.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "./test-fixtures.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function requireAccountWait(blockerPid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const waiting = (await db.execute(sql`
      select pid from pg_stat_activity
       where datname = current_database()
         and ${blockerPid} = any(pg_blocking_pids(pid))
         and query like '%pg_advisory_xact_lock(%'
    `)).rows;
    if (waiting.length > 0) return;
    await delay(20);
  }
  assert.fail("competing banking operation must wait for the account fence until commit");
}

for (const scenario of ["new session", "cutoff extension"] as const) {
  for (const first of ["restore", "sign-off"] as const) {
    test(`exclusion restore and ${scenario} serialize when ${first} wins`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
      const org = await createScratchOrg();
      try {
        const actor = await createScratchUser(org.orgId, "Restore race auditor", "admin");
        const ctx = { orgId: org.orgId, userId: actor };
        await db.execute(sql`
          update accounts set reconcilable = true, currency_restriction = 'CAD'
           where org_id = ${org.orgId} and id = ${org.accounts.bank}
        `);
        await importStatement({
          accountId: org.accounts.bank, source: "manual", currency: "CAD", statementDate: org.date,
          lines: [{ postedOn: org.date, amount: "5", description: "Excluded duplicate", bankTransactionId: "restore-race" }],
        }, ctx);
        const statementLineId = (await db.execute<{ id: string }>(sql`
          select id from bank_statement_lines where org_id = ${org.orgId}
        `)).rows[0]!.id;
        await excludeStatementLine(statementLineId, "Duplicate bank evidence", ctx);
        const earlierDate = new Date(Date.parse(`${org.date}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
        let recon = scenario === "cutoff extension"
          ? await startReconciliation({ accountId: org.accounts.bank, throughDate: earlierDate, statementBalance: "0" }, ctx)
          : undefined;
        const coverLine = async () => {
          if (recon) await adjustReconciliation(recon.id, { throughDate: org.date }, ctx);
          else recon = await startReconciliation({ accountId: org.accounts.bank, throughDate: org.date, statementBalance: "0" }, ctx);
        };
        const ready = deferred<number>();
        const release = deferred<void>();
        // The request's transaction remains open after its real banking
        // service has run, providing a deterministic pause before commit.
        const leading = withOrgTransaction(org.orgId, async () => {
          const pid = (await db.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)).rows[0]!.pid;
          if (first === "restore") await restoreStatementLine(statementLineId, ctx);
          else {
            await coverLine();
            await markReconciled(recon!.id, ctx);
          }
          ready.resolve(pid);
          await release.promise;
        });
        // Observe early setup errors without leaving a pending gate behind.
        const leadingOutcome = leading.then(() => null, (error: unknown) => { ready.resolve(-1); return error; });
        let trailingOutcome: Promise<unknown> | undefined;
        try {
          const blockerPid = await ready.promise;
          assert.notEqual(blockerPid, -1, "leading banking operation must succeed");
          const trailing = first === "restore" ? coverLine() : restoreStatementLine(statementLineId, ctx);
          trailingOutcome = trailing.then(() => null, (error: unknown) => error);
          await requireAccountWait(blockerPid);
        } finally {
          release.resolve();
          // Settle both requests before any fixture cleanup, including on
          // assertion failure, so teardown never races an outstanding write.
          await Promise.all([leadingOutcome, trailingOutcome]);
        }
        assert.equal(await leadingOutcome, null);
        const trailingError = await trailingOutcome;
        if (first === "restore") assert.equal(trailingError, null);
        else {
          assert.ok(trailingError instanceof BankingError);
          assert.match(trailingError.message, /covered by a signed-off reconciliation/);
        }
        assert.ok(recon);
        const totals = await reconciliationTotals(recon.id, ctx);
        const state = (await db.execute<{ status: string; match_status: string; exclusion_reason: string | null }>(sql`
          select r.status, l.match_status, l.exclusion_reason
            from reconciliations r join bank_statement_lines l on l.account_id = r.account_id and l.org_id = r.org_id
           where r.org_id = ${org.orgId} and r.id = ${recon.id}
        `)).rows[0]!;
        const approvals = (await db.execute<{ changes: { excludedStatementLines: number } }>(sql`
          select changes from audit_log where org_id = ${org.orgId} and row_id = ${recon.id}
            and changes->>'operation' = 'sign_off'
        `)).rows;
        const restores = (await db.execute<{ changes: { priorReason: string; before: { matchStatus: string }; after: { matchStatus: string } } }>(sql`
          select changes from audit_log where org_id = ${org.orgId} and row_id = ${statementLineId}
            and changes->>'operation' = 'restore_exclusion'
        `)).rows;
        if (first === "restore") {
          assert.notEqual(state.status, "signed_off");
          assert.equal(state.match_status, "unmatched");
          assert.equal(state.exclusion_reason, null);
          assert.equal(totals.unmatchedStatementLines, 1);
          await assert.rejects(markReconciled(recon.id, ctx), /statement line\(s\).*unmatched/);
          assert.equal(approvals.length, 0);
          assert.equal(restores.length, 1);
          assert.deepEqual(restores[0]!.changes, {
            operation: "restore_exclusion", priorReason: "Duplicate bank evidence",
            before: { matchStatus: "excluded" }, after: { matchStatus: "unmatched" },
          });
        } else {
          assert.equal(state.status, "signed_off");
          assert.equal(state.match_status, "excluded");
          assert.equal(state.exclusion_reason, "Duplicate bank evidence");
          assert.equal(totals.unmatchedStatementLines, 0);
          assert.equal(approvals.length, 1);
          assert.equal(approvals[0]!.changes.excludedStatementLines, 1);
          assert.equal(restores.length, 0);
          assert.deepEqual(await markReconciled(recon.id, ctx), { journalLinesReconciled: 0 });
        }
      } finally {
        await dropScratchOrg(org.orgId);
      }
    });
  }
}
