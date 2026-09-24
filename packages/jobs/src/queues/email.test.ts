import assert from "node:assert/strict";
import test from "node:test";
import {
  buildEmailJobs,
  newEmailIntentKey,
  resolveEmailDeliveryKey,
} from "./email";

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

test("the worker resolves the stored key and never the queue id", () => {
  // The stored delivery key is the one buildEmailJobs derived at enqueue;
  // resolving it must not depend on, rotate with, or fall back to any
  // queue-assigned id.
  const [job] = buildEmailJobs({ ...base, to: "dana@example.com" }, { jobId: "flow-email|row-1" });
  assert.equal(resolveEmailDeliveryKey(job!.data), job!.data.deliveryKey);
  assert.throws(
    () => resolveEmailDeliveryKey({ orgId: ORG, to: "dana@example.com" }),
    /no durable delivery key/,
  );
  assert.throws(
    () => resolveEmailDeliveryKey({ orgId: ORG, to: "dana@example.com", deliveryKey: "bogus" }),
    /delivery key must match/,
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
  // with old sent-log rows. Stored keys must be immune to the queue id —
  // and with the legacy fallback removed, there is no derivation left that
  // could realign them.
  const [job] = buildEmailJobs({ ...base, to: "dana@example.com" }, { jobId: "gate-reminder|org|g|u|uuid-1" });
  assert.equal(resolveEmailDeliveryKey(job!.data), job!.data.deliveryKey);
});

test("a job without a stored key refuses instead of guessing an identity", () => {
  // E11: the removed legacy fallback derived from the scope queueJobId, so
  // after a Redis reset a new job matched an old sent row and was skipped
  // without ever sending. Refusing loudly is the only safe shape — every
  // legitimate job carries its key from buildEmailJobs.
  assert.throws(
    () => resolveEmailDeliveryKey({ orgId: ORG, to: "dana@example.com", deliveryKey: "" }),
    /no durable delivery key/,
  );
  assert.throws(
    () => resolveEmailDeliveryKey({ orgId: ORG, to: "dana@example.com" }),
    /no durable delivery key/,
  );
});
