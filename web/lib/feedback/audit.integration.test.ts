import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") {
      return { shortCircuit: true, url: "data:text/javascript,export {}" };
    }
    return next(specifier, context);
  },
});

const { sql } = await import("drizzle-orm");
const { db } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, dropScratchOrg } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);
const {
  FeedbackFilingRefusedError,
  createIntentFirstPublisher,
  feedbackAuditPendingMessage,
  feedbackFilingRefusedMessage,
  feedbackPayloadHash,
  reconcileFeedbackFiledAudits,
  recordFeedbackFileIntent,
  recordFeedbackFiledAudit,
} = await import("./audit");

/**
 * A filed tenant report must never exist publicly without a durable local
 * event. The intent row lands BEFORE publishing; the completion row records
 * the issue id after. These tests prove each loss shape stays truthful:
 *
 *   • intent unwritable → nothing is published (named refusal);
 *   • published but completion unwritable → the intent stays pending and a
 *     later reconcile closes it with the observed issue id;
 *   • the normal path writes exactly one row carrying the issue id.
 */

const DRAFT = {
  title: "Invoice total ignores the credit note",
  body: "The AR invoice shows the full amount after a credit note is applied.",
  labels: ["area:ar"],
};

test("the payload hash binds the exact outbound bytes, not the labels", () => {
  const hash = feedbackPayloadHash(DRAFT);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(feedbackPayloadHash({ ...DRAFT }), hash, "deterministic");
  assert.notEqual(
    feedbackPayloadHash({ ...DRAFT, title: DRAFT.title + "!" }),
    hash,
    "title is bound",
  );
  assert.notEqual(
    feedbackPayloadHash({ ...DRAFT, body: DRAFT.body + " " }),
    hash,
    "body is bound",
  );
  assert.equal(
    feedbackPayloadHash({ ...DRAFT, labels: ["other", "area:ar", "extra"] }),
    hash,
    "labels ride separately: the publisher appends defaults and may retry stripped",
  );
});

test("both messages name what happened and what to do", () => {
  const refused = feedbackFilingRefusedMessage();
  assert.match(refused, /not filed/i, "states the outcome");
  assert.match(refused, /nothing left the deployment/, "states nothing published");

  const pending = feedbackAuditPendingMessage({
    number: 418,
    url: "https://github.com/o/r/issues/418",
  });
  assert.match(pending, /#418/, "names the public issue");
  assert.match(pending, /https:\/\/github\.com\/o\/r\/issues\/418/, "links it");
  assert.match(pending, /Do not re-file/, "prevents a duplicate");
  assert.match(pending, /reconciled/, "names the recovery path");
});

test("an unwritable intent publishes nothing and raises the named refusal", async () => {
  let published = 0;
  const inner = {
    create: async () => {
      published += 1;
      return { id: "1", number: 1, url: "https://example.invalid/1", title: "t" };
    },
  };
  const refusal: { error: InstanceType<typeof FeedbackFilingRefusedError> | null } = { error: null };
  const publisher = createIntentFirstPublisher(
    inner,
    {
      orgId: randomUUID(),
      actorId: randomUUID(),
      reportId: randomUUID(),
      owner: "o",
      repo: "r",
      pathname: "/",
      refusal,
    },
    {
      recordIntent: async () => {
        throw new Error("the evidence store is down");
      },
    },
  );
  await assert.rejects(() => publisher.create(DRAFT), FeedbackFilingRefusedError);
  assert.equal(published, 0, "no publish without a durable intent");
  assert.ok(refusal.error instanceof FeedbackFilingRefusedError, "stashed for the route");
  assert.equal(refusal.error?.message, feedbackFilingRefusedMessage());
});

test("a writable intent publishes once with the bound hash, keeping search scope", async () => {
  const seen: { title: string; body: string }[] = [];
  const inner = {
    searchOpen: async () => [],
    create: async (draft: { title: string; body: string }) => {
      seen.push(draft);
      return { id: "7", number: 7, url: "https://example.invalid/7", title: draft.title };
    },
  };
  const recorded: unknown[] = [];
  const refusal: { error: InstanceType<typeof FeedbackFilingRefusedError> | null } = { error: null };
  const ctx = {
    orgId: randomUUID(),
    actorId: randomUUID(),
    reportId: randomUUID(),
    owner: "acme",
    repo: "tracker",
    pathname: "/ar",
    refusal,
  };
  const publisher = createIntentFirstPublisher(inner, ctx, {
    recordIntent: async (intent) => {
      recorded.push(intent);
    },
  });
  assert.equal(typeof publisher.searchOpen, "function", "duplicate search is preserved");
  const published = await publisher.create(DRAFT);
  assert.equal(published.number, 7);
  assert.equal(seen.length, 1, "published exactly once");
  assert.equal(recorded.length, 1, "intent written before publish");
  assert.deepEqual(recorded[0], {
    orgId: ctx.orgId,
    actorId: ctx.actorId,
    reportId: ctx.reportId,
    owner: ctx.owner,
    repo: ctx.repo,
    payloadHash: feedbackPayloadHash(DRAFT),
    pathname: ctx.pathname,
  });

  const bare = createIntentFirstPublisher({ create: inner.create }, ctx, {
    recordIntent: async () => {},
  });
  assert.equal(bare.searchOpen, undefined, "no duplicate search is not invented");
});

type AuditRow = {
  action: string;
  changes: Record<string, unknown>;
  actor_id: string | null;
};

async function reportRows(orgId: string, reportId: string): Promise<AuditRow[]> {
  const rows = await db.execute<AuditRow>(sql`
    select action, changes, actor_id
    from audit_log
    where org_id = ${orgId} and table_name = 'feedback_report' and row_id = ${reportId}
    order by at asc
  `);
  return rows.rows;
}

test("intent first, then exactly one row with the issue id; reconcile closes a gap", async (t) => {
  const org = await createScratchOrg();
  const orgId = org.orgId;
  t.after(async () => {
    await dropScratchOrg(orgId);
  });
  const actorId = randomUUID();

  await t.test("the normal path writes an intent plus exactly one row with the issue id", async () => {
    const reportId = randomUUID();
    const hash = feedbackPayloadHash(DRAFT);
    await recordFeedbackFileIntent({
      orgId,
      actorId,
      reportId,
      owner: "acme",
      repo: "tracker",
      payloadHash: hash,
      pathname: "/ar/invoices",
    });
    await recordFeedbackFiledAudit({
      orgId,
      actorId,
      reportId,
      result: {
        kind: "filed",
        issue: { id: "418", number: 418, url: "https://github.com/acme/tracker/issues/418", title: DRAFT.title },
        stripped: ["customer name"],
      },
      pathname: "/ar/invoices",
    });
    const rows = await reportRows(orgId, reportId);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.changes.status, "file-intent");
    assert.deepEqual(rows[0]?.changes.destination, { owner: "acme", repo: "tracker" });
    assert.equal(rows[0]?.changes.payloadHash, hash);
    assert.equal(rows[0]?.actor_id, actorId);
    const withIssue = rows.filter((row) => (row.changes.issue as { number?: number } | undefined)?.number === 418);
    assert.equal(withIssue.length, 1, "exactly one audited row carries the issue id");
    assert.equal(withIssue[0]?.changes.status, "filed");
    assert.deepEqual(withIssue[0]?.changes.stripped, ["customer name"]);
  });

  await t.test("a real insert failure refuses the publish through the default wiring", async () => {
    let published = 0;
    const refusal: { error: InstanceType<typeof FeedbackFilingRefusedError> | null } = { error: null };
    const publisher = createIntentFirstPublisher(
      {
        create: async () => {
          published += 1;
          return { id: "9", number: 9, url: "https://example.invalid/9", title: "t" };
        },
      },
      {
        orgId,
        actorId,
        reportId: "not-a-uuid",
        owner: "acme",
        repo: "tracker",
        pathname: "/",
        refusal,
      },
    );
    await assert.rejects(() => publisher.create(DRAFT), FeedbackFilingRefusedError);
    assert.equal(published, 0);
  });

  await t.test("a post-publish gap stays pending, then reconciles by payload hash", async () => {
    const reportId = randomUUID();
    await recordFeedbackFileIntent({
      orgId,
      actorId,
      reportId,
      owner: "acme",
      repo: "tracker",
      payloadHash: feedbackPayloadHash(DRAFT),
      pathname: "/",
    });
    // The completion write failed after GitHub accepted the issue: the only
    // durable row is the intent.
    assert.equal((await reportRows(orgId, reportId)).length, 1);

    const missed = await reconcileFeedbackFiledAudits({
      orgId,
      listIssues: async () => [],
    });
    assert.deepEqual(missed.reconciled, []);
    assert.deepEqual(missed.stillPending, [reportId], "no invented issue id");
    assert.equal((await reportRows(orgId, reportId)).length, 1, "still only the intent");

    const closed = await reconcileFeedbackFiledAudits({
      orgId,
      listIssues: async () => [
        { number: 1, url: "https://github.com/acme/tracker/issues/1", title: "Unrelated", body: "other" },
        {
          number: 419,
          url: "https://github.com/acme/tracker/issues/419",
          title: DRAFT.title,
          body: DRAFT.body,
        },
      ],
    });
    assert.deepEqual(closed.reconciled, [reportId]);
    assert.deepEqual(closed.stillPending, []);
    const rows = await reportRows(orgId, reportId);
    assert.equal(rows.length, 2);
    const completion = rows[1]?.changes as Record<string, unknown>;
    assert.equal(completion.status, "filed");
    assert.deepEqual(completion.issue, {
      number: 419,
      url: "https://github.com/acme/tracker/issues/419",
      title: DRAFT.title,
    });
    assert.equal(completion.reconciled, true);

    const quiet = await reconcileFeedbackFiledAudits({ orgId, listIssues: async () => [] });
    assert.deepEqual(quiet, { reconciled: [], stillPending: [] }, "closed intents stay closed");
  });
});
