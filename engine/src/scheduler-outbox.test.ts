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

test("terminal failures are stamped durably on the poison row itself", () => {
  const outbox = source("./scheduler-outbox.ts");
  // The stamp rides in the same UPDATE as the final failure (one statement,
  // crash-safe), guarded to fire exactly once per row lifetime.
  assert.match(outbox, /terminal_failed_at = case when/i);
  assert.match(outbox, /coalesce\(terminal_failed_at/);
  assert.match(outbox, /SCHEDULER_OUTBOX_WORKER_IDENTITY/);
  assert.match(outbox, /logTerminalFailure/);
  // Crash recovery of an at-ceiling running row performs the same transition.
  const recovery = outbox.slice(outbox.indexOf("recoverStaleSchedulerOutbox"));
  assert.match(recovery, /attempt_count >= \$\{MAX_SCHEDULER_OUTBOX_ATTEMPTS\}/);

  const delivery = source("./report-delivery.ts");
  assert.match(delivery, /terminal_failed_at = case when/i);
  assert.match(delivery, /REPORT_RUN_WORKER_IDENTITY/);
  assert.match(delivery, /EMAIL_DELIVERY_WORKER_IDENTITY/);

  const surfacing = source("./terminal-failure.ts");
  assert.match(surfacing, /TERMINAL_FAILURE_LOG_EVENT = "scheduler\.terminal_failure"/);
  assert.match(surfacing, /from scheduler_outbox[^\n]*\n[^\n]*where terminal_failed_at is not null/);
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
