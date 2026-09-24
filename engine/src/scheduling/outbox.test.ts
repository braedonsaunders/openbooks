import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_SCHEDULER_OUTBOX_ATTEMPTS,
  SCHEDULER_OUTBOX_RETRY_HORIZON_MS,
  STALE_SCHEDULER_OUTBOX_MS,
  deliverFlowEmail,
  enqueueFlowEmail,
  parseFlowEmailPayload,
  schedulerOutboxBackoffMs,
  type OutboxRow,
} from "./outbox.ts";


test("scheduler outbox backoff doubles then caps at one hour", () => {
  assert.equal(schedulerOutboxBackoffMs(1), 60_000);
  assert.equal(schedulerOutboxBackoffMs(2), 120_000);
  assert.equal(schedulerOutboxBackoffMs(3), 240_000);
  assert.equal(schedulerOutboxBackoffMs(MAX_SCHEDULER_OUTBOX_ATTEMPTS), 60 * 60_000);
});

test("the retry horizon covers the full outbox drain budget", () => {
  // Independently written literals (not a recomputation through
  // schedulerOutboxBackoffMs): the stale-lock window plus each of the eight
  // capped backoffs — about 3.3 hours. A dunning claim staged longer than
  // this can never still be awaiting its letter, so the runner re-arms it.
  // Changing the backoff shape must consciously re-pin this number.
  const expected =
    STALE_SCHEDULER_OUTBOX_MS +
    (60_000 + 120_000 + 240_000 + 480_000 + 960_000 + 1_920_000 + 3_600_000 + 3_600_000);
  assert.equal(SCHEDULER_OUTBOX_RETRY_HORIZON_MS, expected);
});

test("flow email payloads carry an optional reply-to and refuse non-addresses", () => {
  const base = { to: ["a@example.com"], subject: "s", html: "<p>x</p>", text: "x" };
  assert.equal(
    parseFlowEmailPayload({ ...base, replyTo: "ar@example.com" }).replyTo,
    "ar@example.com",
  );
  assert.ok(!("replyTo" in parseFlowEmailPayload(base)));
  for (const replyTo of ["not-an-address", "", 7, null]) {
    assert.throws(
      () => parseFlowEmailPayload({ ...base, replyTo }),
      /`replyTo` must be an email address/,
      `replyTo ${JSON.stringify(replyTo)} must not become durable`,
    );
  }
});

test("flow email enqueue refuses an invalid message synchronously, before any row", async () => {
  const base = { to: ["a@example.com"], subject: "s", html: "<p>x</p>", text: "x" };
  // Shaped like an address but not one: the old includes('@') check let it
  // become a durable row and report success, failing only at drain.
  await assert.rejects(
    enqueueFlowEmail({ orgId: "org-1", runId: "run-1", occurrenceKey: "k-1", payload: { ...base, to: ["x@"] } }),
    /flow email refused: Email delivery contains an invalid recipient address\./,
  );
  await assert.rejects(
    enqueueFlowEmail({ orgId: "org-1", runId: "run-1", occurrenceKey: "k-2", payload: { ...base, subject: "" } }),
    /flow email refused: Email subject is required\./,
  );
  await assert.rejects(
    enqueueFlowEmail({
      orgId: "org-1",
      runId: "run-1",
      occurrenceKey: "k-3",
      payload: { ...base, attachments: [{ filename: "x.pdf", content: "!!!not-base64!!!", contentType: "application/pdf" }] },
    }),
    /flow email refused: Email attachment 1 is not valid bounded base64 content\./,
  );
});

test("flow email delivery forwards reply-to to the queue", async () => {
  const base = { to: ["a@example.com"], subject: "s", html: "<p>x</p>", text: "x" };
  const row = {
    id: "row-1",
    org_id: "org-1",
    kind: "flow_email",
    subject_id: null,
    occurrence_key: "k",
    attempt_count: 0,
    lease_token: "t",
    payload: { ...base, replyTo: "ar@example.com" },
  } as unknown as OutboxRow;
  const seen: { replyTo?: string }[] = [];
  await deliverFlowEmail(row, (async (data) => {
    seen.push(data);
  }) as Parameters<typeof deliverFlowEmail>[1]);
  assert.equal(seen[0]?.replyTo, "ar@example.com");

  const seenAbsent: { replyTo?: string }[] = [];
  await deliverFlowEmail(
    { ...row, payload: base } as unknown as OutboxRow,
    (async (data) => {
      seenAbsent.push(data);
    }) as Parameters<typeof deliverFlowEmail>[1],
  );
  assert.ok(!("replyTo" in (seenAbsent[0] ?? {})));
});
