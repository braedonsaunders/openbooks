import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";
import {
  closeApprovedRun,
  CloseError,
  decidePeriodReopen,
  publishCloseRun,
  recloseApprovedReopen,
  requestPeriodReopen,
  startCloseRun,
} from "./close.ts";
import { db } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "../testing/fixtures.ts";

/**
 * A restatement must version the close package, never overwrite it. The
 * reopen → correct → re-close → re-publish cycle rebuilt the binder snapshot
 * in place (binder_snapshot/binder_hash updated on the run row), so the
 * originally published package became unrecoverable — close_events kept only
 * { comment } — and the new package carried no version, no supersedes link,
 * and no mandatory restatement note. An auditor pulling the original after a
 * restatement found only the corrected numbers with no trace of what was
 * first published.
 *
 * The stubbed jobs module keeps the test hermetic (delivery is best-effort
 * after commit; the wave-1 test proves deliverability itself).
 */
(globalThis as Record<string, unknown>).__p06closeVersionDelivery = async () => {};
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@openbooks/jobs") {
      return {
        shortCircuit: true,
        format: "module",
        url: "data:text/javascript,export const enqueueCloseDelivery = globalThis.__p06closeVersionDelivery",
      };
    }
    return nextResolve(specifier, context);
  },
});

const DB = !!process.env.OPENBOOKS_DB_URL;

async function approveAndClose(orgId: string, runId: string, adminId: string, approverId: string) {
  await db.execute(sql`
    update close_runs set status = 'approved', current_stage = 'lock',
           approved_at = now(), approved_by = ${adminId},
           updated_at = now(), updated_by = ${adminId}
     where id = ${runId} and org_id = ${orgId}`);
  await closeApprovedRun(orgId, runId, approverId);
}

async function binderOf(orgId: string, runId: string) {
  const rows = (await db.execute<{ snapshot: unknown; hash: string | null }>(sql`
    select binder_snapshot as snapshot, binder_hash as hash from close_runs
     where id = ${runId} and org_id = ${orgId}`)).rows;
  return rows[0]!;
}

test("re-publication versions the package and retains the original", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actors = await seedFlowActors(org.orgId);
    await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features}',
      coalesce(settings->'features', '{}'::jsonb) || '{"advancedClose": true}'::jsonb)
      where id = ${org.orgId}`);
    const runId = await startCloseRun({
      orgId: org.orgId,
      periodId: org.periodId,
      bookId: org.bookId,
      actorId: actors.adminId,
    });
    await approveAndClose(org.orgId, runId, actors.adminId, actors.approver1Id);
    await publishCloseRun(org.orgId, runId, actors.adminId, "first publication");
    const v1 = await binderOf(org.orgId, runId);
    assert.ok(v1.hash, "first publication must freeze a binder");

    // Controlled correction cycle with a real correction IN the reopened period.
    const requestId = await requestPeriodReopen({
      orgId: org.orgId,
      periodId: org.periodId,
      bookId: org.bookId,
      modules: ["gl"],
      reason: "Correct a misclassified consulting invoice before re-issue",
      actorId: actors.adminId,
    });
    await decidePeriodReopen({
      orgId: org.orgId,
      requestId,
      actorId: actors.approver1Id,
      approve: true,
      hours: 2,
    });
    const expense = (await db.execute<{ id: string }>(sql`
      select id from accounts where org_id = ${org.orgId} and type = 'expense' limit 1`)).rows[0]!.id;
    const entryId = randomUUID();
    await db.execute(sql`insert into journal_entries
      (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin, memo)
      values (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${entryId},
              ${org.date}, ${org.periodId}, 'draft', 'manual', 'P06 restating correction')`);
    await db.execute(sql`insert into journal_lines
      (id, org_id, entry_id, line_number, account_id, subsidiary_id, party_id, is_open_item, amount, currency, txn_amount, fx_rate, posting_date)
      values (${randomUUID()}, ${org.orgId}, ${entryId}, 1, ${expense}, ${org.subsidiaryId}, null, false, '250.0000', 'CAD', '250.0000', 1, ${org.date}),
             (${randomUUID()}, ${org.orgId}, ${entryId}, 2, ${org.accounts.bank}, ${org.subsidiaryId}, null, false, '-250.0000', 'CAD', '-250.0000', 1, ${org.date})`);
    await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${entryId}`);
    await recloseApprovedReopen({
      orgId: org.orgId,
      requestId,
      actorId: actors.approver1Id,
      reason: "Correction posted and reviewed; window closed for re-issue",
    });
    // The correction must revoke the pre-window approval: the refresh inside
    // the re-close sees the new fingerprint and demotes the run before any
    // lock is taken. Re-approving the restated numbers then closes cleanly.
    const markApproved = () => db.execute(sql`
      update close_runs set status = 'approved', current_stage = 'lock',
             approved_at = now(), approved_by = ${actors.adminId},
             updated_at = now(), updated_by = ${actors.adminId}
       where id = ${runId} and org_id = ${org.orgId}`);
    await markApproved();
    await assert.rejects(
      closeApprovedRun(org.orgId, runId, actors.approver1Id),
      /requires approval or an owner attestation/,
      "a correction posted in the window must revoke the stale approval",
    );
    await markApproved();
    await closeApprovedRun(org.orgId, runId, actors.approver1Id);

    // A second publication with no restatement note must be refused.
    await assert.rejects(
      publishCloseRun(org.orgId, runId, actors.adminId),
      CloseError,
      "re-publication without a restatement note must be refused",
    );

    await publishCloseRun(org.orgId, runId, actors.adminId, "Restate consulting invoice classification");
    const v2 = await binderOf(org.orgId, runId);
    assert.ok(v2.hash && v2.hash !== v1.hash, "restated package must freeze a new binder");

    // The original must be retained as run evidence, byte-identical.
    const superseded = (await db.execute<{ payload: {
      superseded_hash: string | null;
      binder_snapshot: unknown;
    } }>(sql`
      select payload from close_events where org_id = ${org.orgId} and run_id = ${runId}
       and event_type = 'package.superseded' order by at desc limit 1`)).rows[0];
    assert.ok(superseded, "re-publication must retain the superseded package as evidence");
    assert.equal(superseded.payload.superseded_hash, v1.hash);
    assert.deepEqual(superseded.payload.binder_snapshot, v1.snapshot);

    // The new package must visibly version itself and cite the note.
    const snap = v2.snapshot as {
      version: unknown;
      supersedes: unknown;
      restatementNote: unknown;
    };
    assert.equal(snap.version, 2);
    assert.equal(snap.supersedes, v1.hash);
    assert.equal(snap.restatementNote, "Restate consulting invoice classification");
  } finally {
    hooks.deregister();
    await dropScratchOrg(org.orgId);
  }
});
