import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { postingEffectSubsidiaryId, runPostDocumentEffects } from "./posting-dispatch.ts";
import { PostingEffectsTerminalFailureError, type PostingEffectsRow } from "./posting-effects.ts";
import { installPostingContributors } from "../composition/posting-contributors.ts";
import { PostingContributorMissingError } from "../journal/posting-contributors.ts";
import { postingEffectHooks } from "../journal/posting-effect-contributors.ts";

const claimed: PostingEffectsRow = {
  id: "claim",
  org_id: "org",
  document_id: "doc",
  kind: "journal",
  entry_id: "entry",
  posting_date: "2026-09-20",
  actor_id: null,
  attempt_count: 1,
  lease_token: "lease",
};
const posted = {
  id: "doc",
  orgId: "org",
  status: "posted",
  kind: "journal",
  documentDate: "2026-09-20",
  postedEntryId: "entry",
};

test.before(installPostingContributors);

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
  // The only direct read on these paths is the organization's feature
  // switches: asset proposals stay off, so capitalization is a no-op.
  t.mock.method(db, "execute", async (query: SQL, mode?: string) => {
    const inMode = <T extends { rows: unknown }>(result: T) =>
      mode === "objects" ? result.rows : result;
    const text = new PgDialect().sqlToQuery(query).sql.trim();
    if (/^select settings->'features' as features from orgs where id = \$1$/.test(text))
      return inMode({ rows: [{ features: {} }] });
    throw new Error(`unexpected execute: ${text}`);
  });
  return () => assert.equal(count, results.length, "all expected selects must occur");
}

test("an explicit effect subsidiary is retained without a database lookup", async (t) => {
  const done = reads(t, []);
  assert.equal(await postingEffectSubsidiaryId("org", "entity"), "entity");
  done();
});

for (const status of ["succeeded", "running", "terminal_failed"] as const) {
  test(`a ${status} durable claim cannot dispatch effects again`, async (t) => {
    const done = reads(t, []);
    let executions = 0;
    t.mock.method(db, "execute", async (_query: unknown, mode?: string) => {
      const inMode = <T extends { rows: unknown }>(result: T) =>
        mode === "objects" ? result.rows : result;
      executions++;
      assert.ok(executions <= 2, "claim status must not trigger another write");
      return inMode({ rows: executions === 1 ? [] : [{ status }] });
    });
    if (status === "terminal_failed") {
      await assert.rejects(runPostDocumentEffects("doc"), PostingEffectsTerminalFailureError);
    } else await runPostDocumentEffects("doc");
    assert.equal(executions, 2);
    done();
  });
}

for (const doc of [null, { ...posted, status: "draft" }]) {
  test(`an already claimed ${doc ? "draft" : "missing"} document refuses dispatch`, async (t) => {
    const done = reads(t, [doc ? [doc] : []]);
    await assert.rejects(
      runPostDocumentEffects("doc", "draft", { alreadyClaimed: claimed }),
      /document is not posted/,
    );
    done();
  });
}

test("a claimed posted journal dispatches with automation suppressed and retains lease ownership", async (t) => {
  const done = reads(t, [[posted], [], [{ id: "org", name: "Organization", baseCurrency: "USD" }]]);
  await runPostDocumentEffects("doc", "draft", {
    alreadyClaimed: claimed,
    suppressAutomation: true,
  });
  done();
});

test("missing organization refuses a claimed dispatch instead of acknowledging success", async (t) => {
  const done = reads(t, [[posted], [], []]);
  await assert.rejects(
    runPostDocumentEffects("doc", "draft", { alreadyClaimed: claimed, suppressAutomation: true }),
    /organization not found/,
  );
  done();
});

test("a posted vendor bill without its entry refuses before inventory receipts", async (t) => {
  const done = reads(t, [
    [{ ...posted, kind: "vendor_bill", documentNumber: "BILL-17", postedEntryId: null }],
  ]);
  let claimReads = 0;
  t.mock.method(db, "execute", async (_query: unknown, mode?: string) => {
    const inMode = <T extends { rows: unknown }>(result: T) =>
      mode === "objects" ? result.rows : result;
    claimReads++;
    assert.ok(claimReads <= 2, "a missing claim must not produce an effects write");
    return inMode({ rows: [] });
  });
  await assert.rejects(
    runPostDocumentEffects("doc", "draft", { suppressAutomation: true }),
    /BILL-17.*no posted journal entry.*inventory receipts cannot run/,
  );
  assert.equal(claimReads, 2, "both claim lookup paths establish that no durable claim exists");
  done();
});

/** Install every effect hook except one domain's, restoring the full set after the test. */
function withoutEffectHook(t: TestContext, domain: string) {
  const kept = postingEffectHooks.installed().filter((name) => name !== domain);
  const hooks = kept.map((name) => [name, postingEffectHooks.require(name)] as const);
  postingEffectHooks.clear();
  t.after(installPostingContributors);
  for (const [name, hook] of hooks) postingEffectHooks.register(name, hook);
}

test("a posted entry refuses its effects when the asset hook is not installed", async (t) => {
  withoutEffectHook(t, "assets");
  const done = reads(t, [[posted]]);
  await assert.rejects(
    runPostDocumentEffects("doc", "draft", { alreadyClaimed: claimed, suppressAutomation: true }),
    (error: unknown) =>
      error instanceof PostingContributorMissingError &&
      error.kind === "effect" &&
      error.domain === "assets" &&
      /installPostingContributors\(\)/.test(error.message),
  );
  done();
});

test("a posting that reaches no asset hook dispatches without the asset contributor", async (t) => {
  withoutEffectHook(t, "assets");
  const done = reads(t, [
    [{ ...posted, postedEntryId: null }],
    [],
    [{ id: "org", name: "Organization", baseCurrency: "USD" }],
  ]);
  // No durable claim row: the dispatch runs on the document alone.
  t.mock.method(db, "execute", async (_query: unknown, mode?: string) =>
    mode === "objects" ? [] : { rows: [] },
  );
  await runPostDocumentEffects("doc", "draft", { suppressAutomation: true });
  done();
});
