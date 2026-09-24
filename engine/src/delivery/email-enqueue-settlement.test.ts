import assert from "node:assert/strict";
import test from "node:test";
import { probeEmailEnqueueAfterError } from "./email-enqueue-settlement.ts";

const data = {
  orgId: "org-test",
  to: ["ap@example.test", "ar@example.test"],
  subject: "Payment advice",
  html: "<p>Paid</p>",
  text: "Paid",
  meta: { category: "payment_remittance", paymentRemittanceId: "remittance-test" },
};

test("the shared enqueue probe recognizes every accepted recipient job", async () => {
  const checked: string[] = [];
  const result = await probeEmailEnqueueAfterError({
    data,
    jobId: "payment-remittance|remittance-test",
    probeQueuedJob: async (jobId) => {
      checked.push(jobId);
      return true;
    },
  });

  assert.equal(result.outcome, "already-queued");
  assert.equal(result.jobIds.length, 2);
  assert.deepEqual(result.jobIds, checked);
});

test("the shared enqueue probe proves non-acceptance only when every recipient job is absent", async () => {
  let calls = 0;
  const absent = await probeEmailEnqueueAfterError({
    data,
    jobId: "payment-remittance|remittance-test",
    probeQueuedJob: async () => {
      calls += 1;
      return null;
    },
  });
  assert.equal(absent.outcome, "not-queued");
  assert.equal(calls, 2);

  const partial = await probeEmailEnqueueAfterError({
    data,
    jobId: "payment-remittance|remittance-test",
    probeQueuedJob: async (_jobId) => ++calls === 3,
  });
  assert.equal(partial.outcome, "uncertain");
  assert.equal(partial.jobIds.length, 1);
});

test("an unreachable queue leaves acceptance uncertain", async () => {
  const result = await probeEmailEnqueueAfterError({
    data,
    jobId: "payment-remittance|remittance-test",
    probeQueuedJob: async () => {
      throw new Error("Redis unavailable");
    },
  });
  assert.deepEqual(result, { outcome: "uncertain", jobIds: [] });
});
