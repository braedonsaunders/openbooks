import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { bulkRunClientKey, bulkScriptQueueJobId } from "./bulk-run-claim.ts";

test("bulk run requires a stable client key and validates it", () => {
  assert.throws(() => bulkRunClientKey(undefined), /idempotency key is required/);
  assert.throws(() => bulkRunClientKey(null), /idempotency key is required/);
  assert.equal(bulkRunClientKey("run-2026-09-24:01"), "run-2026-09-24:01");
  assert.throws(() => bulkRunClientKey("short"), /idempotency key/);
  assert.throws(() => bulkRunClientKey("has space"), /idempotency key/);
});

test("bulk queue identity is deterministic and safe for BullMQ separators", () => {
  const scriptId = randomUUID();
  const key = bulkRunClientKey("run-2026-09-24:01");
  assert.equal(bulkScriptQueueJobId(scriptId, key), bulkScriptQueueJobId(scriptId, key));
  assert.notEqual(
    bulkScriptQueueJobId(scriptId, key),
    bulkScriptQueueJobId(scriptId, bulkRunClientKey("run-2026-09-24:02")),
  );
  assert.notEqual(bulkScriptQueueJobId(scriptId, key), bulkScriptQueueJobId(randomUUID(), key));
  assert.ok(!bulkScriptQueueJobId(scriptId, key).includes(":"));
});
