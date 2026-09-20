import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { db } from "../platform/db.ts";
import { postingEffectSubsidiaryId, runPostDocumentEffects } from "./posting-dispatch.ts";
import { PostingEffectsTerminalFailureError, type PostingEffectsRow } from "./posting-effects.ts";

const claimed: PostingEffectsRow = { id: "claim", org_id: "org", document_id: "doc", kind: "journal", entry_id: "entry", posting_date: "2026-09-20", actor_id: null, attempt_count: 1, lease_token: "lease" };
const posted = { id: "doc", orgId: "org", status: "posted", kind: "journal", documentDate: "2026-09-20", postedEntryId: "entry" };

function reads(t: TestContext, results: unknown[][]) {
  let count = 0;
  t.mock.method(db, "select", () => {
    assert.ok(count < results.length, "unexpected select");
    const rows = results[count++]!;
    const query = {
      from: () => query,
      where: () => query,
      orderBy: () => query,
      then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
    };
    return query;
  });
  t.mock.method(db, "execute", () => { throw new Error("unexpected execute"); });
  return () => assert.equal(count, results.length, "all expected selects must occur");
}

test("an explicit effect subsidiary is retained without a database lookup", async t => {
  const done = reads(t, []);
  assert.equal(await postingEffectSubsidiaryId("org", "entity"), "entity");
  done();
});

for (const status of ["succeeded", "running", "terminal_failed"] as const) {
  test(`a ${status} durable claim cannot dispatch effects again`, async t => {
    const done = reads(t, []);
    let executions = 0;
    t.mock.method(db, "execute", async () => {
      executions++;
      assert.ok(executions <= 2, "claim status must not trigger another write");
      return { rows: executions === 1 ? [] : [{ status }] };
    });
    if (status === "terminal_failed") {
      await assert.rejects(runPostDocumentEffects("doc"), PostingEffectsTerminalFailureError);
    } else await runPostDocumentEffects("doc");
    assert.equal(executions, 2);
    done();
  });
}

for (const doc of [null, { ...posted, status: "draft" }]) {
  test(`an already claimed ${doc ? "draft" : "missing"} document refuses dispatch`, async t => {
    const done = reads(t, [doc ? [doc] : []]);
    await assert.rejects(runPostDocumentEffects("doc", "draft", { alreadyClaimed: claimed }), /document is not posted/);
    done();
  });
}

test("a claimed posted journal dispatches with automation suppressed and retains lease ownership", async t => {
  const done = reads(t, [[posted], [], [{ id: "org", name: "Organization", baseCurrency: "USD" }]]);
  await runPostDocumentEffects("doc", "draft", { alreadyClaimed: claimed, suppressAutomation: true });
  done();
});

test("missing organization refuses a claimed dispatch instead of acknowledging success", async t => {
  const done = reads(t, [[posted], [], []]);
  await assert.rejects(runPostDocumentEffects("doc", "draft", { alreadyClaimed: claimed, suppressAutomation: true }), /organization not found/);
  done();
});

test("a posted vendor bill without its entry refuses before inventory receipts", async t => {
  const done = reads(t, [[{ ...posted, kind: "vendor_bill", documentNumber: "BILL-17", postedEntryId: null }]]);
  let claimReads = 0;
  t.mock.method(db, "execute", async () => {
    claimReads++;
    assert.ok(claimReads <= 2, "a missing claim must not produce an effects write");
    return { rows: [] };
  });
  await assert.rejects(runPostDocumentEffects("doc", "draft", { suppressAutomation: true }), /BILL-17.*no posted journal entry.*inventory receipts cannot run/);
  assert.equal(claimReads, 2, "both claim lookup paths establish that no durable claim exists");
  done();
});
