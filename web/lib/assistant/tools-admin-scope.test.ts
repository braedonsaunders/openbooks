import assert from "node:assert/strict";
import test from "node:test";
import { projectOutboxFailure } from "./outbox-status";

test("outbox failure projection exposes only opaque identity and operational state", () => {
  const recipient = "private-recipient@example.test";
  const projected = projectOutboxFailure({
    job_id: "d47ecb26-4140-4a4c-895d-9dab9dc2ea10",
    job_type: "report_delivery",
    status: "failed",
    attempt_count: 4,
    created_at: "2026-09-24T10:00:00Z",
    updated_at: "2026-09-24T10:02:00Z",
    recipient,
    error: `Delivery to ${recipient} failed`,
  });

  assert.deepEqual(projected, {
    jobId: "d47ecb26-4140-4a4c-895d-9dab9dc2ea10",
    jobType: "report_delivery",
    status: "failed",
    attempts: 4,
    createdAt: "2026-09-24T10:00:00Z",
    updatedAt: "2026-09-24T10:02:00Z",
  });
  assert.ok(!JSON.stringify(projected).includes(recipient));
});
