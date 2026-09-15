import assert from "node:assert/strict";
import test from "node:test";
import { processBackupJobData } from "./backup-worker.ts";
import { processSandboxJobData } from "./sandbox-worker.ts";

/**
 * Unknown job kinds (a poisoned payload, or an op from a release the worker
 * no longer knows) must fail LOUD: without a default arm the switch falls
 * through, the promise resolves, and BullMQ marks the job complete — the
 * work is silently dropped with no dead-letter trace.
 */
test("the sandbox worker refuses an unknown op instead of silently succeeding", async () => {
  await assert.rejects(
    processSandboxJobData({ op: "defragment" } as never),
    /unknown sandbox job op: defragment/,
  );
});

test("the backup worker refuses an unknown op instead of silently succeeding", async () => {
  await assert.rejects(
    processBackupJobData({ op: "defragment" } as never),
    /unknown backup job op: defragment/,
  );
});
