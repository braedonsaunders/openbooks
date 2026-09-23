import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  MAX_SCHEDULER_OUTBOX_ATTEMPTS,
  SCHEDULER_OUTBOX_RETRY_HORIZON_MS,
  STALE_SCHEDULER_OUTBOX_MS,
  deliverFlowEmail,
  parseFlowEmailPayload,
  schedulerOutboxBackoffMs,
  type OutboxRow,
} from "./outbox.ts";

const source = (relative: string) =>
  readFileSync(new URL(relative, import.meta.url), "utf8");

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

test("terminal failures are stamped durably on the poison row itself", () => {
  const outbox = source("./outbox.ts");
  // The stamp rides in the same UPDATE as the final failure (one statement,
  // crash-safe), guarded to fire exactly once per row lifetime.
  assert.match(outbox, /terminal_failed_at = case when/i);
  assert.match(outbox, /coalesce\(terminal_failed_at/);
  assert.match(outbox, /SCHEDULER_OUTBOX_WORKER_IDENTITY/);
  assert.match(outbox, /logTerminalFailure/);
  // Crash recovery of an at-ceiling running row performs the same transition.
  const recovery = outbox.slice(outbox.indexOf("recoverStaleSchedulerOutbox"));
  assert.match(recovery, /attempt_count >= \$\{MAX_SCHEDULER_OUTBOX_ATTEMPTS\}/);

  const delivery = source("../delivery/report-delivery.ts");
  assert.match(delivery, /terminal_failed_at = case when/i);
  assert.match(delivery, /REPORT_RUN_WORKER_IDENTITY/);
  assert.match(delivery, /EMAIL_DELIVERY_WORKER_IDENTITY/);

  const surfacing = source("../platform/terminal-failure.ts");
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

  const outbox = source("./outbox.ts");
  assert.match(outbox, /runDunning/);
  assert.match(outbox, /runDueSubscriptions/);
  assert.match(outbox, /runDuePropertyBilling/);
  assert.match(outbox, /runDueFxProviders/);
  assert.match(outbox, /escalateDueGate/);
  assert.match(outbox, /listFailedSchedulerOutbox/);

  const gates = source("../flows/gates.ts");
  assert.match(gates, /enqueueApprovalEscalation/);
  assert.doesNotMatch(gates, /escalation failed:/);

  const worker = source("../worker/scheduler.ts");
  assert.match(worker, /ensureScanOutboxRows/);
  assert.match(worker, /processDueSchedulerOutbox/);
  assert.doesNotMatch(worker, /bullmq.*dlq|dead.?letter/i);
});

test("scheduler completions are fenced by the active per-claim lease", () => {
  const outbox = source("./outbox.ts");
  assert.match(outbox, /lease_token=gen_random_uuid\(\)/);
  assert.match(outbox, /where id=\$\{row\.id\} and lease_token=\$\{row\.lease_token\} and status='running'/);
  assert.match(outbox, /SchedulerOutboxLeaseFencedError/);
  const recovery = outbox.slice(outbox.indexOf("recoverStaleSchedulerOutbox"));
  assert.match(recovery, /lease_token=null/);
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
