import assert from "node:assert/strict";
import test from "node:test";
import {
  buildEmailJobs,
  newEmailIntentKey,
  resolveEmailDeliveryKey,
} from "./email.ts";

const ORG = "018f6b2a-7c1d-7d3e-9f4a-2b8c4d5e6f70";

const base = {
  orgId: ORG,
  subject: "Approval requested",
  html: "<p>hi</p>",
  text: "hi",
} as const;

test("enqueueing without a caller idempotency key is refused", () => {
  assert.throws(
    // @ts-expect-error the type requires jobId; the runtime must refuse too
    () => buildEmailJobs({ ...base, to: "dana@example.com" }, undefined),
    /requires options\.jobId/,
  );
  assert.throws(
    () => buildEmailJobs({ ...base, to: "dana@example.com" }, { jobId: "  " }),
    /requires options\.jobId/,
  );
});

test("delivery keys are deterministic per intent and distinct otherwise", () => {
  const first = buildEmailJobs({ ...base, to: "dana@example.com" }, { jobId: "remittance|1" });
  const replayed = buildEmailJobs({ ...base, to: "Dana@example.com" }, { jobId: "remittance|1" });
  // Same intent retried (even with different mailbox case) shares one key —
  // the retry collapses onto the same log row instead of sending twice.
  assert.equal(first[0]!.data.deliveryKey, replayed[0]!.data.deliveryKey);
  assert.match(first[0]!.data.deliveryKey, /^obem_[0-9a-f]{40}$/);

  const otherIntent = buildEmailJobs({ ...base, to: "dana@example.com" }, { jobId: "remittance|2" });
  assert.notEqual(first[0]!.data.deliveryKey, otherIntent[0]!.data.deliveryKey);
  const otherOrg = buildEmailJobs(
    { ...base, orgId: "018f6b2a-0000-7000-8000-000000000001", to: "dana@example.com" },
    { jobId: "remittance|1" },
  );
  assert.notEqual(first[0]!.data.deliveryKey, otherOrg[0]!.data.deliveryKey);
});

test("single-recipient keys keep the pre-change worker identity", () => {
  // Before this change the worker derived scope=job.id, and job.id equaled
  // the caller's jobId. Keys for already-durable callers must not rotate,
  // or every in-flight retry would mint a duplicate send.
  const [job] = buildEmailJobs({ ...base, to: "dana@example.com" }, { jobId: "flow-email|row-1" });
  assert.equal(
    job!.data.deliveryKey,
    resolveEmailDeliveryKey(
      { orgId: ORG, to: "dana@example.com", meta: {} },
      "flow-email|row-1",
    ),
  );
});

test("fanout derives one key per recipient from the fanned id", () => {
  const jobs = buildEmailJobs(
    { ...base, to: ["dana@example.com", "evan@example.com"] },
    { jobId: "report-delivery|row-9|3" },
  );
  assert.equal(jobs.length, 2);
  assert.notEqual(jobs[0]!.data.deliveryKey, jobs[1]!.data.deliveryKey);
  assert.notEqual(jobs[0]!.opts.jobId, jobs[1]!.opts.jobId);
  // Deterministic: the same dispatch re-fanned collapses onto the same jobs.
  const again = buildEmailJobs(
    { ...base, to: ["dana@example.com", "evan@example.com"] },
    { jobId: "report-delivery|row-9|3" },
  );
  assert.equal(jobs[0]!.data.deliveryKey, again[0]!.data.deliveryKey);
  assert.equal(jobs[0]!.opts.jobId, again[0]!.opts.jobId);
});

test("one-off intent keys are unique per call and prefixed", () => {
  const a = newEmailIntentKey("gate-reminder|org|gate|user");
  const b = newEmailIntentKey("gate-reminder|org|gate|user");
  assert.notEqual(a, b);
  assert.ok(a.startsWith("gate-reminder|org|gate|user|"));
  assert.throws(() => newEmailIntentKey("  "), /non-empty prefix/);
});

test("the worker key never depends on the queue-assigned job id", () => {
  // Regression test for the Redis-reset collision: BullMQ auto-increment
  // ids restart from 1, so any key derived from job.id realigns new mail
  // with old sent-log rows. Stored keys must be immune to the queue id.
  const [job] = buildEmailJobs({ ...base, to: "dana@example.com" }, { jobId: "gate-reminder|org|g|u|uuid-1" });
  assert.equal(resolveEmailDeliveryKey(job!.data, "1"), job!.data.deliveryKey);
  assert.equal(resolveEmailDeliveryKey(job!.data, "2"), job!.data.deliveryKey);
  assert.equal(resolveEmailDeliveryKey(job!.data, null), job!.data.deliveryKey);
});

test("legacy jobs without a stored key drain through their old scopes", () => {
  // Jobs enqueued before deliveryKey existed carry no key; the worker must
  // still claim the same row the old derivation would have found.
  assert.equal(
    resolveEmailDeliveryKey({ orgId: ORG, to: "dana@example.com", meta: { reportDeliveryId: "r1" } }, "99"),
    resolveEmailDeliveryKey({ orgId: ORG, to: "dana@example.com", meta: { reportDeliveryId: "r1" } }, "100"),
  );
  // ...but a legacy job with neither a durable scope nor a queue id refuses
  // instead of minting an arbitrary identity that could skip real mail.
  assert.throws(
    () => resolveEmailDeliveryKey({ orgId: ORG, to: "dana@example.com", meta: {} }, null),
    /durable scope/,
  );
});
