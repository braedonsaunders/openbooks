import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, pool } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrgReporting } from "../testing/fixtures.ts";
import { runScript, triggerTargetStamp } from "./scripting.ts";

// D1: a script host write that outlives its run deadline must never commit
// behind the timeout report, and a retry of the same logical run must
// observe the first execution's document instead of double-posting.
//
// The first test holds an ACCESS EXCLUSIVE lock on documents from a second
// connection so the journal write cannot proceed: the run must report a
// timeout with ZERO committed rows, and the retry (lock released, same
// idempotency namespace) must post exactly one document.
const DB = !!process.env.OPENBOOKS_DB_URL;

function draftScript(date: string): string {
  return `function main(ctx) {
    return ob.journal.create({
      documentDate: ${JSON.stringify(date)},
      memo: "deadline probe",
      lines: [
        { accountCode: "5100", amount: 25 },
        { accountCode: "2000", amount: -25 },
      ],
    });
  }`;
}

function postScript(date: string): string {
  return `function main(ctx) {
    return ob.journal.create({
      documentDate: ${JSON.stringify(date)},
      memo: "deadline probe",
      lines: [
        { accountCode: "5100", amount: 25 },
        { accountCode: "2000", amount: -25 },
      ],
    }, { post: true });
  }`;
}

async function journalCounts(orgId: string): Promise<{ docs: number; entries: number }> {
  const r = (await db.execute<{ docs: string; entries: string }>(sql`
    select (select count(*) from documents where org_id = ${orgId} and kind = 'journal')::text as docs,
           (select count(*) from journal_entries where org_id = ${orgId})::text as entries`));
  return { docs: Number(r.rows[0]!.docs), entries: Number(r.rows[0]!.entries) };
}

test("a journal write blocked past the run deadline commits nothing; the retry posts exactly once", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const ctx = {
      trigger: "scheduled",
      org: { id: org.orgId, name: "probe", baseCurrency: "CAD" },
    };
    const namespace = `deadline-probe/${randomUUID()}`;

    // A second connection holds documents hostage for the whole run: every
    // statement of the journal write blocks, the deadline fires, and the
    // fenced transaction can never commit behind the timeout.
    const locker = await pool.connect();
    let timed;
    try {
      await locker.query("begin");
      await locker.query("lock table documents in access exclusive mode");
      timed = await runScript(draftScript(org.date), ctx, 400, { idempotencyNamespace: namespace });
    } finally {
      await locker.query("rollback");
      locker.release();
    }
    assert.equal(timed!.status, "timeout", `expected a timeout, got ${timed!.status}: ${timed!.abortReason}`);
    // The abandoned write resumes once the lock releases, but its fence
    // point is past the deadline — it must refuse, never late-commit.
    // Settle first: the host may still be awaiting the write's terminal
    // outcome when runScript returns.
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.deepEqual(await journalCounts(org.orgId), { docs: 0, entries: 0 });

    const retried = await runScript(draftScript(org.date), ctx, 10_000, { idempotencyNamespace: namespace });
    assert.equal(retried.status, "ok", `retry errored: ${retried.abortReason}`);
    assert.deepEqual(await journalCounts(org.orgId), { docs: 1, entries: 0 });
    assert.ok((retried.returned as { id: string }).id, "retry returns the created document");
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("a retried run observes the first execution's document instead of double-posting", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const ctx = {
      trigger: "scheduled",
      org: { id: org.orgId, name: "probe", baseCurrency: "CAD" },
    };
    const namespace = `idempotent-retry/${randomUUID()}`;
    const first = await runScript(draftScript(org.date), ctx, 10_000, { idempotencyNamespace: namespace });
    assert.equal(first.status, "ok", `first run errored: ${first.abortReason}`);
    const firstId = (first.returned as { id: string }).id;
    const second = await runScript(draftScript(org.date), ctx, 10_000, { idempotencyNamespace: namespace });
    assert.equal(second.status, "ok", `retry errored: ${second.abortReason}`);
    assert.equal((second.returned as { id: string }).id, firstId, "retry observes the first document");
    assert.deepEqual(await journalCounts(org.orgId), { docs: 1, entries: 0 });
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("a retried posting run observes the first execution's entry instead of double-posting", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const ctx = {
      trigger: "scheduled",
      org: { id: org.orgId, name: "probe", baseCurrency: "CAD" },
    };
    const namespace = `idempotent-post/${randomUUID()}`;
    const first = await runScript(postScript(org.date), ctx, 30_000, { idempotencyNamespace: namespace });
    assert.equal(first.status, "ok", `first run errored: ${first.abortReason}`);
    const firstResult = first.returned as { id: string; entryId?: string };
    assert.ok(firstResult.entryId, "first run posted");
    const second = await runScript(postScript(org.date), ctx, 30_000, { idempotencyNamespace: namespace });
    assert.equal(second.status, "ok", `retry errored: ${second.abortReason}`);
    const secondResult = second.returned as { id: string; entryId?: string };
    assert.equal(secondResult.id, firstResult.id, "retry observes the first document");
    assert.equal(secondResult.entryId, firstResult.entryId, "retry observes the first entry");
    assert.deepEqual(await journalCounts(org.orgId), { docs: 1, entries: 1 });
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

// The trigger-run namespace stamp is the target's storage revision: stable
// across a retry of the same failed operation, fresh after any later change.
test("triggerTargetStamp derives retry stability from revision_seq and fails closed without one", () => {
  assert.equal(triggerTargetStamp({ revision_seq: 7 }), "rev7");
  assert.equal(triggerTargetStamp({ revision_seq: "42" }), "rev42");
  assert.equal(triggerTargetStamp({ revision_seq: 3n }), "rev3");
  const fallback = triggerTargetStamp({ kind: "journal" });
  assert.match(fallback, /^nostamp-/);
  assert.notEqual(triggerTargetStamp({}), triggerTargetStamp({}), "unstamped runs never share a namespace");
});
