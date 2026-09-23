import assert from "node:assert/strict";
import test from "node:test";
import {
  CREW_TIME_BATCH_SUBJECT_KIND,
  crewBatchFlowAdapter,
} from "./crew-batches-adapter.ts";
import {
  registerFlowApprovalReleaseHandler,
  releaseFlowApproval,
} from "./approval-release-hook.ts";

test("crew batch release delegates to the registered web handler", async () => {
  const calls: unknown[] = [];
  registerFlowApprovalReleaseHandler(
    CREW_TIME_BATCH_SUBJECT_KIND,
    async (args) => {
      calls.push(args);
    },
  );
  await crewBatchFlowAdapter.releaseApproval!(
    "00000000-0000-4000-8000-000000000001",
    "approved",
    {
      orgId: "00000000-0000-4000-8000-000000000002",
      userId: "00000000-0000-4000-8000-000000000003",
    },
    { comment: "verified" },
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    subjectKind: CREW_TIME_BATCH_SUBJECT_KIND,
    subjectId: "00000000-0000-4000-8000-000000000001",
    outcome: "approved",
    comment: "verified",
    ctx: {
      orgId: "00000000-0000-4000-8000-000000000002",
      userId: "00000000-0000-4000-8000-000000000003",
    },
  });
});

test("crew batch release without a registered handler throws instead of stranding the gate", async () => {
  // A fresh kind exercises the unregistered path without disturbing the
  // handler other tests register above.
  await assert.rejects(
    releaseFlowApproval({
      subjectKind: "crew_time_batch_probe_without_handler",
      subjectId: "00000000-0000-4000-8000-000000000001",
      outcome: "approved",
      ctx: {
        orgId: "00000000-0000-4000-8000-000000000002",
        userId: "00000000-0000-4000-8000-000000000003",
      },
    }),
    /is not registered/,
  );
});
