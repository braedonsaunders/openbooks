import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { MAX_SCHEDULER_OUTBOX_ATTEMPTS, schedulerOutboxBackoffMs } from "./scheduler-outbox.ts";

const source = (relative: string) =>
  readFileSync(new URL(relative, import.meta.url), "utf8");

test("scheduler outbox backoff doubles then caps at one hour", () => {
  assert.equal(schedulerOutboxBackoffMs(1), 60_000);
  assert.equal(schedulerOutboxBackoffMs(2), 120_000);
  assert.equal(schedulerOutboxBackoffMs(3), 240_000);
  assert.equal(schedulerOutboxBackoffMs(MAX_SCHEDULER_OUTBOX_ATTEMPTS), 60 * 60_000);
});

test("dunning, billing, FX, and approval escalations no longer log-and-drop", () => {
  const scheduler = source("./scheduler.ts");
  assert.match(scheduler, /ensureScanOutboxRows/);
  assert.match(scheduler, /processDueSchedulerOutbox/);
  assert.doesNotMatch(scheduler, /dunning scan failed/);
  assert.doesNotMatch(scheduler, /subscription billing scan failed/);
  assert.doesNotMatch(scheduler, /property billing scan failed/);
  assert.doesNotMatch(scheduler, /FX provider scan failed/);
  assert.doesNotMatch(scheduler, /gate timer scan failed/);

  const outbox = source("./scheduler-outbox.ts");
  assert.match(outbox, /runDunning/);
  assert.match(outbox, /runDueSubscriptions/);
  assert.match(outbox, /runDuePropertyBilling/);
  assert.match(outbox, /runDueFxProviders/);
  assert.match(outbox, /escalateDueGate/);
  assert.match(outbox, /listFailedSchedulerOutbox/);

  const gates = source("./flows/gates.ts");
  assert.match(gates, /enqueueApprovalEscalation/);
  assert.doesNotMatch(gates, /escalation failed:/);

  const worker = source("./worker/scheduler.ts");
  assert.match(worker, /ensureScanOutboxRows/);
  assert.match(worker, /processDueSchedulerOutbox/);
  assert.doesNotMatch(worker, /bullmq.*dlq|dead.?letter/i);
});
