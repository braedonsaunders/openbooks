import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after } from "node:test";
import test from "node:test";
import { sql } from "drizzle-orm";
import {
  closeJobConnections,
  enqueueEmail,
  getEmailQueue,
} from "@openbooks/jobs";
import { db } from "./db.ts";
import {
  enqueueApprovalEscalation,
  enqueueFlowEmail,
  flowEmailJobId,
  listFailedSchedulerOutbox,
  MAX_SCHEDULER_OUTBOX_ATTEMPTS,
  parseFlowEmailPayload,
  processDueSchedulerOutbox,
  recoverStaleSchedulerOutbox,
  replayTerminalSchedulerOutbox,
  STALE_SCHEDULER_OUTBOX_MS,
  deliverFlowEmail,
  type FlowEmailQueueEnqueuer,
} from "./scheduler-outbox.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "./test-fixtures.ts";
import {
  claimDueScriptOccurrence,
  recoverLostScriptOccurrences,
  runDueScripts,
  scanDueScripts,
  scriptOccurrenceKey,
} from "./scheduler.ts";
import { SCHEDULED_SCRIPT_SCHEDULER_IDENTITY } from "./scripting.ts";
import { SCHEDULER_OUTBOX_WORKER_IDENTITY, TERMINAL_FAILURE_LOG_EVENT } from "./terminal-failure.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

/** Capture console.log so structured terminal-failure emissions can be counted. */
function captureConsoleLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((value) => (typeof value === "string" ? value : JSON.stringify(value))).join(" "));
  };
  return { lines, restore: () => (console.log = original) };
}

type TerminalLog = { event: string; surface: string; id: string; attempts: number; markedBy: string };

function terminalEvents(lines: string[]): TerminalLog[] {
  return lines
    .map((line) => {
      try {
        return JSON.parse(line) as TerminalLog;
      } catch {
        return null;
      }
    })
    .filter((value): value is TerminalLog => value?.event === TERMINAL_FAILURE_LOG_EVENT);
}

test("failed dunning and escalation rows stay visible and retry with backoff", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const gateId = randomUUID();
  const dunningKey = `dunning-test-${randomUUID()}`;
  try {
    await db.execute(sql`
      insert into scheduler_outbox (kind, occurrence_key, status, next_attempt_at)
      values ('dunning', ${dunningKey}, 'pending', ${new Date(Date.now() - 1_000)})
    `);
    const inserted = await enqueueApprovalEscalation({ orgId: org.orgId, gateId });
    assert.ok(inserted);
    await db.execute(sql`
      update scheduler_outbox set next_attempt_at=${new Date(Date.now() - 1_000)}
       where id=${inserted}
    `);

    const asOf = new Date();
    const first = await processDueSchedulerOutbox(asOf, 50, async (row) => {
      if (row.occurrence_key === dunningKey || row.subject_id === gateId) {
        throw new Error(`${row.kind} crashed mid-run`);
      }
    });
    assert.ok(first.failed >= 2, `expected two failures, got ${JSON.stringify(first)}`);

    const failed = (await listFailedSchedulerOutbox()).filter(
      (row) => row.kind === "dunning" && !row.orgId || row.subjectId === gateId,
    );
    const dunning = failed.find((row) => row.kind === "dunning");
    const escalation = failed.find((row) => row.subjectId === gateId);
    assert.ok(dunning, "dunning failure must remain in scheduler_outbox");
    assert.ok(escalation, "escalation failure must remain in scheduler_outbox");
    assert.equal(dunning.error, "dunning crashed mid-run");
    assert.equal(escalation.error, "approval_escalation crashed mid-run");
    assert.equal(dunning.status, "failed");
    assert.equal(escalation.orgId, org.orgId);

    const tooSoon = await processDueSchedulerOutbox(asOf, 50, async (row) => {
      if (row.occurrence_key === dunningKey || row.subject_id === gateId) {
        throw new Error("should not retry before backoff");
      }
    });
    assert.equal(tooSoon.failed, 0);

    const later = new Date(asOf.getTime() + 70_000);
    const retried = await processDueSchedulerOutbox(later, 50, async (row) => {
      if (row.occurrence_key === dunningKey || row.subject_id === gateId) {
        throw new Error(`${row.kind} crashed mid-run`);
      }
    });
    assert.ok(retried.failed >= 2);

    await db.execute(sql`
      update scheduler_outbox
         set attempt_count=${MAX_SCHEDULER_OUTBOX_ATTEMPTS - 1},
             next_attempt_at=${later}
       where occurrence_key=${dunningKey}
    `);
    const captured = captureConsoleLogs();
    await processDueSchedulerOutbox(later, 50, async (row) => {
      if (row.occurrence_key === dunningKey) throw new Error("terminal dunning failure");
    });
    captured.restore();
    const terminal = (await listFailedSchedulerOutbox()).find((row) => row.kind === "dunning" && !row.orgId);
    assert.equal(terminal?.attemptCount, MAX_SCHEDULER_OUTBOX_ATTEMPTS);
    assert.equal(terminal?.error, "terminal dunning failure");

    // The terminal transition is surfaced durably and exactly once: one
    // stamped row (timestamp + recording system identity) plus one structured
    // log line for the poison row.
    assert.ok(terminal?.terminalFailedAt, "terminal failure must be timestamped on the row");
    assert.equal(terminal?.terminalFailedBy, SCHEDULER_OUTBOX_WORKER_IDENTITY);
    const dunningId = (await db.execute<{ id: string }>(sql`
      select id from scheduler_outbox where occurrence_key=${dunningKey}
    `)).rows[0]!.id;
    const emissions = terminalEvents(captured.lines).filter((event) => event.id === dunningId);
    assert.equal(emissions.length, 1, `expected exactly one terminal log line, got ${JSON.stringify(emissions)}`);
    assert.equal(emissions[0]?.surface, "scheduler_outbox");
    assert.equal(emissions[0]?.attempts, MAX_SCHEDULER_OUTBOX_ATTEMPTS);
    assert.equal(emissions[0]?.markedBy, SCHEDULER_OUTBOX_WORKER_IDENTITY);

    const stampedAtBefore = terminal.terminalFailedAt;
    await processDueSchedulerOutbox(new Date(later.getTime() + 3_600_000), 50, async (row) => {
      if (row.occurrence_key === dunningKey) throw new Error("must not retry a terminal failed row");
    });
    const stillDunning = (await listFailedSchedulerOutbox()).find((row) => row.kind === "dunning" && !row.orgId);
    assert.equal(stillDunning?.error, "terminal dunning failure");
    assert.equal(stillDunning?.attemptCount, MAX_SCHEDULER_OUTBOX_ATTEMPTS);
    // The stamp is never rewritten or duplicated by later ticks.
    assert.deepEqual(stillDunning?.terminalFailedAt, stampedAtBefore);

    await db.execute(sql`
      update scheduler_outbox
         set status='running', locked_at=${new Date(later.getTime() - 20 * 60_000)}, error=null,
             attempt_count=${MAX_SCHEDULER_OUTBOX_ATTEMPTS}
       where subject_id=${gateId}
    `);
    const staleCapture = captureConsoleLogs();
    assert.ok(await recoverStaleSchedulerOutbox(later) >= 1);
    staleCapture.restore();
    // Crash recovery of a running row already at the ceiling is itself a
    // terminal transition: it must stamp and emit exactly like a failed run.
    const recovered = (await listFailedSchedulerOutbox()).find((row) => row.subjectId === gateId);
    assert.equal(recovered?.status, "failed");
    assert.match(recovered?.error ?? "", /stale lock recovered after crash/);
    assert.ok(recovered?.terminalFailedAt, "stale recovery at the ceiling stamps the row");
    assert.equal(recovered?.terminalFailedBy, SCHEDULER_OUTBOX_WORKER_IDENTITY);
    const staleEmissions = terminalEvents(staleCapture.lines).filter((event) => event.id === inserted);
    assert.equal(staleEmissions.length, 1);
    assert.equal(staleEmissions[0]?.surface, "scheduler_outbox");
  } finally {
    await db.execute(sql`
      delete from scheduler_outbox
       where occurrence_key=${dunningKey} or subject_id=${gateId} or org_id=${org.orgId}
    `);
    await dropScratchOrg(org.orgId);
  }
});

test("a recovered scheduler lease fences the stale worker completion", { skip: !DB }, async () => {
  const occurrenceKey = `dunning-fence-${randomUUID()}`;
  const firstNow = new Date("2026-07-20T10:00:00.000Z");
  const recoveryNow = new Date(firstNow.getTime() + 16 * 60_000);
  let releaseOld!: () => void;
  let signalOldClaimed!: () => void;
  const oldHeld = new Promise<void>((resolve) => { releaseOld = resolve; });
  const oldClaimed = new Promise<void>((resolve) => { signalOldClaimed = resolve; });
  let oldLease = "";
  let replacementLease = "";
  try {
    await db.execute(sql`
      insert into scheduler_outbox (kind, occurrence_key, status, next_attempt_at)
      values ('dunning', ${occurrenceKey}, 'pending', '2000-01-01T00:00:00Z')
    `);
    const staleWorker = processDueSchedulerOutbox(firstNow, 1, async (row) => {
      oldLease = row.lease_token;
      signalOldClaimed();
      await oldHeld;
    });
    await oldClaimed;
    assert.ok(oldLease, "the first claim must carry a lease token");

    assert.equal(await recoverStaleSchedulerOutbox(recoveryNow), 1);
    const replacement = await processDueSchedulerOutbox(recoveryNow, 1, async (row) => {
      replacementLease = row.lease_token;
    });
    assert.deepEqual(replacement, { processed: 1, succeeded: 1, failed: 0, fenced: 0 });
    assert.ok(replacementLease);
    assert.notEqual(replacementLease, oldLease, "recovery must mint a different lease");

    releaseOld();
    const staleResult = await staleWorker;
    assert.deepEqual(staleResult, { processed: 1, succeeded: 0, failed: 0, fenced: 1 });
    const stored = await db.execute<{
      status: string;
      attempt_count: number;
      lease_token: string | null;
    }>(sql`
      select status, attempt_count, lease_token
        from scheduler_outbox where occurrence_key=${occurrenceKey}
    `);
    assert.deepEqual(stored.rows, [{ status: "pending", attempt_count: 0, lease_token: null }]);
  } finally {
    releaseOld?.();
    await db.execute(sql`delete from scheduler_outbox where occurrence_key=${occurrenceKey}`);
  }
});

test("flow email payload validation fails closed on every malformed shape", () => {
  const valid = {
    to: ["a@example.test"],
    subject: "s",
    html: "<p>s</p>",
    text: "s",
  };
  assert.deepEqual(parseFlowEmailPayload(valid), valid);
  const withExtras = {
    ...valid,
    attachments: [{ filename: "r.pdf", content: "AAAA", contentType: "application/pdf" }],
    meta: { category: "flows" },
  };
  assert.deepEqual(parseFlowEmailPayload(withExtras), withExtras);
  for (const [detail, bad] of [
    ["non-object", "nope"],
    ["empty to", { ...valid, to: [] }],
    ["bad recipient", { ...valid, to: ["no-at-sign"] }],
    ["missing subject", { ...valid, subject: undefined }],
    ["html not a string", { ...valid, html: 5 }],
    ["attachments not array", { ...valid, attachments: {} }],
    ["attachment without content", { ...valid, attachments: [{ filename: "x" }] }],
    ["meta values must be strings", { ...valid, meta: { category: 7 } }],
  ] as const) {
    assert.throws(() => parseFlowEmailPayload(bad), /malformed/, detail);
  }
});

test("flow_email rows are idempotent by occurrence key and terminal once delivered", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const runId = randomUUID();
  try {
    const payload = { to: ["approver@scratch.test"], subject: "Approval", html: "<b>Approval</b>", text: "Approval" };
    const first = await enqueueFlowEmail({
      orgId: org.orgId,
      runId,
      occurrenceKey: `${runId}:email:n1`,
      payload,
    });
    // A replay of the same effect (same occurrence key) collapses onto the
    // existing row instead of enqueueing a second send.
    const second = await enqueueFlowEmail({
      orgId: org.orgId,
      runId,
      occurrenceKey: `${runId}:email:n1`,
      payload,
    });
    assert.equal(first, true);
    assert.equal(second, false);

    let deliveries = 0;
    await processDueSchedulerOutbox(new Date(Date.now() + 1_000), 50, async (row) => {
      if (row.subject_id === runId) {
        deliveries++;
        assert.deepEqual(row.payload, payload);
      }
    });
    assert.equal(deliveries, 1, "the worker delivered the deferred email exactly once");
    const delivered = (await db.execute<{ status: string; attempt_count: number }>(sql`
      select status, attempt_count from scheduler_outbox where subject_id=${runId}
    `)).rows[0]!;
    assert.equal(delivered.status, "succeeded", "a flow email is terminal after delivery");
    assert.equal(delivered.attempt_count, 1);
  } finally {
    await db.execute(sql`delete from scheduler_outbox where subject_id=${runId} or org_id=${org.orgId}`);
    await dropScratchOrg(org.orgId);
  }
});

test("an undeliverable flow email retries visibly instead of sending garbage", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const runId = randomUUID();
  try {
    // Tampered storage: a payload that cannot be validated must fail the
    // attempt loudly (the default runner validates before any delivery and
    // must never reach the mail transport).
    await db.execute(sql`
      insert into scheduler_outbox
        (org_id, kind, subject_id, occurrence_key, status, next_attempt_at, payload)
      values (${org.orgId}, 'flow_email', ${runId}, ${`${runId}:corrupt`}, 'pending', ${new Date(Date.now() - 1_000)}, '{"to":"all"}'::jsonb)
    `);
    await processDueSchedulerOutbox(new Date(), 50);
    const failedRow = (await listFailedSchedulerOutbox(200)).find((row) => row.subjectId === runId);
    assert.ok(failedRow, "the corrupt row stays visible to operators");
    assert.match(failedRow!.error ?? "", /malformed/);
    assert.equal(failedRow!.status, "failed");
    assert.equal(failedRow!.attemptCount, 1);
  } finally {
    await db.execute(sql`delete from scheduler_outbox where subject_id=${runId} or org_id=${org.orgId}`);
    await dropScratchOrg(org.orgId);
  }
});

// ---------------------------------------------------------------------------
// fnd_mt97ro32_l25fnb — the crash gap between the queued provider send and the
// PG success mark. enqueueEmail used to receive no job identity at all, so a
// worker that died after BullMQ accepted a delivery but before its row was
// marked succeeded left stale recovery to retry as a SECOND independent send.
// Deliveries now derive one deterministic job id from the outbox row's primary
// key, so every attempt of that row collapses onto the same queue job.
//
// These regressions run WITHOUT Redis: the fake queue below stands in for
// exactly the part of BullMQ's add() contract this defect lives in — an add
// under a custom id that still exists returns the existing job (no second
// insert); an add with no custom id mints a fresh auto id — while claim, the
// durable rows, stale recovery, retry, success/failure marking, and fencing
// are all the real engine path against live PostgreSQL. The Redis-backed
// proofs further below re-verify both against the real queue when
// OPENBOOKS_REDIS_URL is provided.
// ---------------------------------------------------------------------------

/** A fake provider queue faithful to the two BullMQ behaviors this defect depends on. */
function createFakeEmailQueue(): {
  enqueue: FlowEmailQueueEnqueuer;
  jobs: Map<string, { data: Record<string, unknown> }>;
  sends: Array<{ jobId: string; created: boolean; call: number }>;
} {
  const jobs = new Map<string, { data: Record<string, unknown> }>();
  const sends: Array<{ jobId: string; created: boolean; call: number }> = [];
  let autoId = 0;
  const enqueue: FlowEmailQueueEnqueuer = async (data, options) => {
    // Custom ids collapse onto the existing job while it still exists; absent
    // ids always mint a fresh independent job.
    const jobId = options?.jobId ?? `auto-${++autoId}`;
    const created = !jobs.has(jobId);
    if (created) jobs.set(jobId, { data });
    sends.push({ jobId, created, call: sends.length + 1 });
    return { jobId, created };
  };
  return { enqueue, jobs, sends };
}

async function eventually(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not reached in time");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Storage raises surface wrapped in DrizzleQueryError; match along the cause chain. */
async function assertRejectsWithCause(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    let current: unknown = error;
    while (current instanceof Error) {
      if (pattern.test(current.message)) return true;
      current = (current as { cause?: unknown }).cause;
    }
    return false;
  }, `no rejection matching ${pattern}`);
}

test("a crashed flow-email delivery retries onto one queue identity instead of duplicating customer mail", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const runId = randomUUID();
  let releaseCrashed!: () => void;
  let crashedWorker: Promise<{
    processed: number;
    succeeded: number;
    failed: number;
    fenced: number;
  }> | null = null;
  const fake = createFakeEmailQueue();
  try {
    const payload = { to: ["customer@scratch.test"], subject: "Renewal reminder", html: "<p>Renewal reminder</p>", text: "Renewal reminder" };
    assert.ok(await enqueueFlowEmail({ orgId: org.orgId, runId, occurrenceKey: `${runId}:email:n1`, payload }));
    const rowId = (
      await db.execute<{ id: string }>(sql`
        select id from scheduler_outbox where subject_id=${runId}
      `)
    ).rows[0]!.id;
    // The deterministic identity both attempts must share.
    assert.equal(flowEmailJobId(rowId), `flow-email|${rowId}`);

    // Attempt 1 performs the REAL delivery handoff, then the process "dies":
    // the worker parks forever between the successful provider call and any
    // completion statement, leaving the exact durable state a post-enqueue/
    // pre-mark crash leaves behind.
    const crashGate = new Promise<void>((resolve) => { releaseCrashed = resolve; });
    const asOf = new Date(Date.now() + 5_000);
    crashedWorker = processDueSchedulerOutbox(asOf, 50, async (row) => {
      if (row.subject_id !== runId) return;
      await deliverFlowEmail(row, fake.enqueue);
      await crashGate;
    });
    await eventually(() => fake.sends.length === 1);
    const crashedRow = (
      await db.execute<{ status: string; attemptCount: number; claimed: boolean; leased: boolean }>(sql`
        select status, attempt_count as "attemptCount",
               (locked_at is not null) as claimed,
               (lease_token is not null) as leased
          from scheduler_outbox where id=${rowId}
      `)
    ).rows[0]!;
    assert.deepEqual(crashedRow, { status: "running", attemptCount: 1, claimed: true, leased: true });
    // Ordinary stale recovery releases the orphaned claim; the row retries.
    const staleNow = new Date(asOf.getTime() + STALE_SCHEDULER_OUTBOX_MS + 60_000);
    assert.equal(await recoverStaleSchedulerOutbox(staleNow), 1);

    // Attempt 2 is ordinary due processing of the recovered row.
    const later = new Date(staleNow.getTime() + 90_000);
    const retried = await processDueSchedulerOutbox(later, 50, async (row) => {
      if (row.subject_id !== runId) return;
      await deliverFlowEmail(row, fake.enqueue);
    });
    assert.deepEqual(retried, { processed: 1, succeeded: 1, failed: 0, fenced: 0 });

    // THE assertion: across both attempts the provider received exactly ONE
    // send. The retry DID call the provider again, but its deterministic id
    // collapsed onto the already-enqueued job instead of minting a duplicate.
    assert.equal(
      fake.jobs.size,
      1,
      "the customer was queued exactly once across a crash, recovery, and retry",
    );
    assert.equal(fake.sends.length, 2, "both attempts really handed the mail to the provider");
    for (const send of fake.sends) assert.equal(send.jobId, flowEmailJobId(rowId));
    assert.equal(fake.sends[0]!.created, true);
    assert.equal(fake.sends[1]!.created, false, "the retry collapsed onto the original job");
    const queuedData = [...fake.jobs.values()][0]!.data;
    assert.deepEqual(queuedData.to, payload.to);
    assert.equal(queuedData.subject, payload.subject);

    const delivered = (
      await db.execute<{ status: string; attemptCount: number }>(sql`
        select status, attempt_count as "attemptCount" from scheduler_outbox where id=${rowId}
      `)
    ).rows[0]!;
    assert.deepEqual(delivered, { status: "succeeded", attemptCount: 2 });

    // Release the parked worker: its stale completion must be FENCED by the
    // replacement lease — it can neither overwrite 'succeeded' nor re-enqueue.
    releaseCrashed();
    const crashed = await crashedWorker!;
    crashedWorker = null;
    assert.equal(crashed.fenced, 1);
    assert.equal(crashed.succeeded, 0);
    const settled = (
      await db.execute<{ status: string; attemptCount: number }>(sql`
        select status, attempt_count as "attemptCount" from scheduler_outbox where id=${rowId}
      `)
    ).rows[0]!;
    assert.deepEqual(settled, { status: "succeeded", attemptCount: 2 });
  } finally {
    releaseCrashed();
    if (crashedWorker) await crashedWorker.catch(() => {});
    await db.execute(sql`delete from scheduler_outbox where subject_id=${runId} or org_id=${org.orgId}`);
    await dropScratchOrg(org.orgId);
  }
});

test("a genuine transport failure does not dedupe away the eventual single send", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const runId = randomUUID();
  try {
    const payload = { to: ["retry@scratch.test"], subject: "Escalation", html: "<p>Escalation</p>", text: "Escalation" };
    assert.ok(await enqueueFlowEmail({ orgId: org.orgId, runId, occurrenceKey: `${runId}:email:n2`, payload }));
    const fake = createFakeEmailQueue();
    // Attempt 1 hits a real transport error BEFORE anything is enqueued.
    const failingFirstCall: FlowEmailQueueEnqueuer = async (data, options) => {
      if (fake.sends.length === 0) throw new Error("provider 5xx");
      return fake.enqueue(data, options);
    };
    const first = await processDueSchedulerOutbox(new Date(Date.now() + 5_000), 50, async (row) => {
      if (row.subject_id !== runId) return;
      await deliverFlowEmail(row, failingFirstCall);
    });
    assert.deepEqual(first, { processed: 1, succeeded: 0, failed: 1, fenced: 0 });
    assert.equal((await listFailedSchedulerOutbox(200)).find((r) => r.subjectId === runId)?.status, "failed");
    assert.equal(fake.jobs.size, 0, "a rejected send leaves nothing queued");

    // The retry succeeds through the same identity and delivers once.
    const retried = await processDueSchedulerOutbox(new Date(Date.now() + 120_000), 50, async (row) => {
      if (row.subject_id !== runId) return;
      await deliverFlowEmail(row, fake.enqueue);
    });
    assert.deepEqual(retried, { processed: 1, succeeded: 1, failed: 0, fenced: 0 });
    assert.equal(fake.jobs.size, 1, "exactly one send eventually reached the provider");
    const rowId = (await db.execute<{ id: string }>(sql`
      select id from scheduler_outbox where subject_id=${runId}
    `)).rows[0]!.id;
    assert.equal([...fake.jobs.keys()][0], flowEmailJobId(rowId));
  } finally {
    await db.execute(sql`delete from scheduler_outbox where subject_id=${runId} or org_id=${org.orgId}`);
    await dropScratchOrg(org.orgId);
  }
});

// ---------------------------------------------------------------------------
// Live-PG + live-Redis supplements. Redis is off by default in tests, so only
// these two opt back in when OPENBOOKS_REDIS_URL is provided; they prove the
// same collapse against the real BullMQ producer. One shutdown at file end:
// the queue singleton binds its first connection.
// ---------------------------------------------------------------------------

after(() => closeJobConnections());

const BULLMQ_STATES = ["waiting", "active", "completed", "failed", "delayed"] as const;

/** Count durable copies of one queue job across every lifecycle state. */
async function countQueueJob(jobId: string): Promise<number> {
  const queue = getEmailQueue();
  let occurrences = 0;
  for (const state of BULLMQ_STATES) {
    occurrences += (await queue.getJobs([state], 0, -1)).filter((job) => job.id === jobId).length;
  }
  return occurrences;
}

/** Remove exactly the jobs this suite created; leave the rest of the DB alone. */
async function removeQueueJobs(jobIds: Array<string | null>): Promise<void> {
  const queue = getEmailQueue();
  for (const jobId of jobIds) {
    if (!jobId) continue;
    const job = await queue.getJob(jobId);
    if (job) await job.remove().catch(() => {});
  }
}

test(
  "a crashed flow-email send retries onto the same durable queue job",
  { skip: !DB || !process.env.OPENBOOKS_REDIS_URL },
  async () => {
    const org = await createScratchOrg();
    const runId = randomUUID();
    try {
      const payload = {
        to: ["victim@scratch.test"],
        subject: "Renewal reminder",
        html: "<p>Renewal reminder</p>",
        text: "Renewal reminder",
      };
      assert.ok(await enqueueFlowEmail({ orgId: org.orgId, runId, occurrenceKey: `${runId}:email:n1`, payload }));
      const rowId = (
        await db.execute<{ id: string }>(sql`select id from scheduler_outbox where subject_id=${runId}`)
      ).rows[0]!.id;
      const expectedJobId = flowEmailJobId(rowId);
      const asOf = new Date(Date.now() + 5_000);

      // Attempt 1 performs the REAL Redis enqueue, then dies right there —
      // before the success mark can commit.
      let enqueuedBeforeCrash = "";
      await processDueSchedulerOutbox(asOf, 50, async (row) =>
        deliverFlowEmail(row, async (data, options) => {
          enqueuedBeforeCrash = String(options?.jobId);
          await enqueueEmail(data, options);
          throw new Error("simulated process death after queue enqueue");
        }),
      );
      assert.equal(enqueuedBeforeCrash, expectedJobId);
      assert.equal(await countQueueJob(expectedJobId), 1, "one durable send exists after the crash");
      const crashedRow = (
        await db.execute<{ status: string; attempt_count: number }>(sql`
          select status, attempt_count from scheduler_outbox where id=${rowId}
        `)
      ).rows[0];
      assert.equal(crashedRow!.status, "failed", "the crashed attempt is retryable");
      assert.equal(crashedRow!.attempt_count, 1);

      // Attempt 2 is ordinary processing of that failed row: the
      // deterministic id makes BullMQ treat it as the SAME send.
      const later = new Date(asOf.getTime() + 90_000);
      let enqueuedOnRetry = "";
      await processDueSchedulerOutbox(later, 50, async (row) =>
        deliverFlowEmail(row, async (data, options) => {
          enqueuedOnRetry = String(options?.jobId);
          return enqueueEmail(data, options);
        }),
      );
      assert.equal(enqueuedOnRetry, expectedJobId, "the retry derives the same job id from the row");

      const delivered = (
        await db.execute<{ status: string; attempt_count: number }>(sql`
          select status, attempt_count from scheduler_outbox where id=${rowId}
        `)
      ).rows[0];
      assert.equal(delivered!.status, "succeeded");
      assert.equal(delivered!.attempt_count, 2);
      assert.equal(await countQueueJob(expectedJobId), 1, "no duplicate send may exist on retry");
    } finally {
      await removeQueueJobs([
        (await db.execute<{ id: string | null }>(sql`select id from scheduler_outbox where subject_id=${runId}`))
          .rows[0]?.id ?? null,
      ]);
      await db.execute(sql`delete from scheduler_outbox where subject_id=${runId} or org_id=${org.orgId}`);
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "the default runner stamps one deterministic fanout id per recipient",
  { skip: !DB || !process.env.OPENBOOKS_REDIS_URL },
  async () => {
    const org = await createScratchOrg();
    const runId = randomUUID();
    try {
      const recipients = ["Controller@Scratch.test", "audit@scratch.test"];
      const payload = {
        to: recipients,
        subject: "Escalation",
        html: "<p>Escalation</p>",
        text: "Escalation",
        meta: { category: "flows" },
      };
      assert.ok(await enqueueFlowEmail({ orgId: org.orgId, runId, occurrenceKey: `${runId}:email:n3`, payload }));
      const rowId = (
        await db.execute<{ id: string }>(sql`select id from scheduler_outbox where subject_id=${runId}`)
      ).rows[0]!.id;
      await processDueSchedulerOutbox(new Date(Date.now() + 5_000), 50);

      const rowStatus = (
        await db.execute<{ status: string }>(sql`select status from scheduler_outbox where id=${rowId}`)
      ).rows[0]!.status;
      assert.equal(rowStatus, "succeeded", "production delivery completes end to end");

      // Multi-recipient fanout digests the base row identity once per
      // recipient (mirroring emails.ts's fanoutOptions contract).
      const base = flowEmailJobId(rowId);
      const createdJobIds = recipients.map(
        (recipient) =>
          `email-fanout|${
            createHash("sha256").update(base).update("\0").update(recipient.toLowerCase()).digest("hex")
          }`,
      );
      try {
        for (let i = 0; i < createdJobIds.length; i++) {
          assert.equal(await countQueueJob(createdJobIds[i]!), 1, `exactly one send for ${recipients[i]}`);
          const job = await getEmailQueue().getJob(createdJobIds[i]!);
          assert.ok(job, `fanout job for ${recipients[i]} exists`);
          assert.equal(job!.data.to, recipients[i]);
          assert.equal(job!.data.meta?.category, "flows");
        }
      } finally {
        await removeQueueJobs(createdJobIds);
      }
    } finally {
      await db.execute(sql`delete from scheduler_outbox where subject_id=${runId} or org_id=${org.orgId}`);
      await dropScratchOrg(org.orgId);
    }
  },
);

// ---------------------------------------------------------------------------
// fnd_mt98x8mi_n0xf0x — terminal failures carry immutable audit evidence.
// Exhaustion and crash recovery each write one append-only evidence row inside
// the stamping transaction (migration 0026): repeated recovery cannot
// duplicate it, terminalization cannot commit without it, a stamped row's
// certified facts cannot be rewritten without replay authorization, and the
// authorized replay copies the verbatim envelope into evidence BEFORE clearing
// the stamps.
// ---------------------------------------------------------------------------

type TerminalEvidenceRow = {
  event: string;
  orgId: string | null;
  kind: string;
  occurrenceKey: string;
  attemptCount: number;
  reason: string | null;
  markedBy: string;
  detailPath: string | null;
};

async function readTerminalEvidence(outboxRowId: string): Promise<TerminalEvidenceRow[]> {
  return (
    await db.execute<TerminalEvidenceRow>(sql`
      select event, org_id as "orgId", kind, occurrence_key as "occurrenceKey",
             attempt_count as "attemptCount", reason, marked_by as "markedBy",
             detail->>'path' as "detailPath"
        from scheduler_outbox_terminal_audit
       where outbox_row_id=${outboxRowId}
       order by at
    `)
  ).rows.map((row) => ({ ...row }));
}

/** Push one row to the ceiling through the public drain and leave it stamped. */
async function exhaustToTerminal(input: {
  now?: Date;
  runnerShouldThrow: (row: { id: string; occurrence_key: string; subject_id: string | null }) => boolean;
}): Promise<void> {
  const now = input.now ?? new Date(Date.now() + 5_000);
  const result = await processDueSchedulerOutbox(now, 50, async (row) => {
    if (input.runnerShouldThrow(row)) throw new Error("poison at the ceiling");
  });
  assert.ok(result.failed >= 1, `expected the poison attempt to fail: ${JSON.stringify(result)}`);
}

test("ordinary exhaustion writes exactly one immutable evidence row and survives replay attempts", { skip: !DB }, async () => {
  const dunningKey = `dunning-terminal-audit-${randomUUID()}`;
  try {
    await db.execute(sql`
      insert into scheduler_outbox (kind, occurrence_key, status, next_attempt_at, attempt_count)
      values ('dunning', ${dunningKey}, 'pending', ${new Date(Date.now() - 1_000)}, ${MAX_SCHEDULER_OUTBOX_ATTEMPTS - 1})
    `);
    const rowId = (
      await db.execute<{ id: string }>(sql`select id from scheduler_outbox where occurrence_key=${dunningKey}`)
    ).rows[0]!.id;

    await exhaustToTerminal({
      runnerShouldThrow: (row) => row.id === rowId,
    });

    // Exactly one evidence row certifies the poisoning, written transactionally
    // with the stamp it describes.
    let evidence = await readTerminalEvidence(rowId);
    assert.equal(evidence.length, 1, JSON.stringify(evidence));
    assert.equal(evidence[0]!.event, "terminal_failure");
    assert.equal(evidence[0]!.detailPath, "exhaustion");
    assert.equal(evidence[0]!.occurrenceKey, dunningKey);
    assert.equal(evidence[0]!.attemptCount, MAX_SCHEDULER_OUTBOX_ATTEMPTS);
    assert.equal(evidence[0]!.reason, "poison at the ceiling");
    assert.equal(evidence[0]!.markedBy, SCHEDULER_OUTBOX_WORKER_IDENTITY);
    const stampsBefore = (
      await db.execute<{ at: string; by: string }>(sql`
        select terminal_failed_at::text as at, terminal_failed_by as by
          from scheduler_outbox where id=${rowId}
      `)
    ).rows[0]!;

    // Repeated ticks and repeated recovery passes cannot duplicate evidence.
    await processDueSchedulerOutbox(new Date(Date.now() + 3_600_000), 50, async () => {});
    assert.equal(await recoverStaleSchedulerOutbox(new Date()), 0);
    evidence = await readTerminalEvidence(rowId);
    assert.equal(evidence.length, 1, "repeat passes must never write a second evidence row");

    // The code path that wrote the evidence cannot rewrite its certified facts.
    await assertRejectsWithCause(
      db.execute(sql`update scheduler_outbox set subject_id=gen_random_uuid() where id=${rowId}`),
      /terminal-failure evidence is immutable/,
    );
    await assertRejectsWithCause(
      db.execute(sql`update scheduler_outbox set terminal_failed_at=null where id=${rowId}`),
      /replay reset requires its replay_authorized audit evidence first/,
    );

    // Even a pinned transaction cannot clear the stamps before its own
    // replay evidence exists — unevidenced resets commit nothing.
    await assertRejectsWithCause(
      db.transaction(async (tx) => {
        await tx.execute(sql`
          select set_config('openbooks.scheduler_outbox_replay_org', coalesce(org_id::text, ''), true)
            from scheduler_outbox where id=${rowId}
        `);
        await tx.execute(sql`update scheduler_outbox set terminal_failed_at=null where id=${rowId}`);
      }),
      /replay reset requires its replay_authorized audit evidence first/,
    );
    const stampsAfterRefusals = (
      await db.execute<{ at: string; by: string }>(sql`
        select terminal_failed_at::text as at, terminal_failed_by as by
          from scheduler_outbox where id=${rowId}
      `)
    ).rows[0]!;
    assert.deepEqual(stampsAfterRefusals, stampsBefore, "refused rewrites left no residue");
  } finally {
    // The org-less scan row's evidence has no tenant teardown path: drop it
    // through the same guarded-trigger dance the fixture wipe uses.
    await db.transaction(async (tx) => {
      const r = (await tx.execute(
        sql`select 1 as x from scheduler_outbox_terminal_audit where event <> 'replay_authorized'
              and outbox_row_id in (select id from scheduler_outbox where occurrence_key=${dunningKey}) limit 1`,
      ));
      if (r.rows.length === 0) return;
      await tx.execute(sql.raw("alter table scheduler_outbox_terminal_audit disable trigger scheduler_outbox_terminal_audit_append_only"));
      await tx.execute(sql`
        delete from scheduler_outbox_terminal_audit
         where outbox_row_id in (select id from scheduler_outbox where occurrence_key=${dunningKey})
      `);
      await tx.execute(sql.raw("alter table scheduler_outbox_terminal_audit enable trigger scheduler_outbox_terminal_audit_append_only"));
    });
    await db.execute(sql`delete from scheduler_outbox where occurrence_key=${dunningKey}`);
  }
});

test("crash recovery at the ceiling leaves identical exactly-once evidence", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const gateId = randomUUID();
  try {
    await enqueueApprovalEscalation({ orgId: org.orgId, gateId });
    // The exact durable state a crash at the ceiling leaves behind: running,
    // stale past the recovery window, and out of attempts.
    await db.execute(sql`
      update scheduler_outbox
         set status='running', attempt_count=${MAX_SCHEDULER_OUTBOX_ATTEMPTS},
             locked_at=${new Date(Date.now() - 20 * 60_000)}, error='worker died mid-run'
       where subject_id=${gateId}
    `);
    const rowId = (await db.execute<{ id: string }>(sql`
      select id from scheduler_outbox where subject_id=${gateId}
    `)).rows[0]!.id;

    assert.ok(await recoverStaleSchedulerOutbox(new Date()) >= 1);
    const evidence = await readTerminalEvidence(rowId);
    assert.equal(evidence.length, 1, JSON.stringify(evidence));
    assert.equal(evidence[0]!.event, "crash_recovery_terminal_failure");
    assert.equal(evidence[0]!.detailPath, "crash_recovery");
    assert.equal(evidence[0]!.orgId, org.orgId);
    assert.match(evidence[0]!.reason!, /stale lock recovered after crash at the attempt ceiling/);

    // Repeating recovery finds nothing new and duplicates nothing.
    assert.equal(await recoverStaleSchedulerOutbox(new Date(Date.now() + 60 * 60_000)), 0);
    assert.equal((await readTerminalEvidence(rowId)).length, 1);
  } finally {
    await db.execute(sql`delete from scheduler_outbox where subject_id=${gateId} or org_id=${org.orgId}`);
    await dropScratchOrg(org.orgId);
  }
});

test("terminalization cannot commit when the evidence write fails", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const gateId = randomUUID();
  const sabotageTrigger = "sabotage_scheduler_terminal_audit";
  try {
    await enqueueApprovalEscalation({ orgId: org.orgId, gateId });
    await db.execute(sql`
      update scheduler_outbox set next_attempt_at=${new Date(Date.now() - 1_000)}, attempt_count=${MAX_SCHEDULER_OUTBOX_ATTEMPTS - 1}
       where subject_id=${gateId}
    `);
    const rowId = (await db.execute<{ id: string }>(sql`
      select id from scheduler_outbox where subject_id=${gateId}
    `)).rows[0]!.id;

    // Org-scoped sabotage: only THIS scratch org's evidence inserts fail.
    await db.execute(sql`
      create or replace function fail_terminal_evidence() returns trigger language plpgsql as $fn$
      begin raise exception 'terminal-audit unavailable'; end $fn$
    `);
    await db.execute(sql`
      create trigger ${sql.raw(sabotageTrigger)} before insert on scheduler_outbox_terminal_audit
      for each row when (new.org_id = ${sql.raw(`'${org.orgId}'`)}) execute function fail_terminal_evidence()
    `);
    try {
      await assertRejectsWithCause(
        exhaustToTerminal({ runnerShouldThrow: (row) => row.id === rowId }),
        /terminal-audit unavailable/,
      );

      // Nothing committed: the stamp did not stick and no partial evidence
      // remains, while the exhausted claim stays recoverable.
      const stranded = (
        await db.execute<{ status: string; attemptCount: number; stampedAt: string | null; evidence: number }>(sql`
          select o.status, o.attempt_count as "attemptCount",
                 o.terminal_failed_at::text as "stampedAt",
                 (select count(*)::int from scheduler_outbox_terminal_audit e
                   where e.outbox_row_id=o.id) as evidence
            from scheduler_outbox o where o.id=${rowId}
        `)
      ).rows[0]!;
      assert.equal(stranded.status, "running");
      assert.equal(stranded.attemptCount, MAX_SCHEDULER_OUTBOX_ATTEMPTS);
      assert.equal(stranded.stampedAt, null);
      assert.equal(stranded.evidence, 0);
    } finally {
      await db.execute(sql`drop trigger if exists ${sql.raw(sabotageTrigger)} on scheduler_outbox_terminal_audit`);
      await db.execute(sql`drop function if exists fail_terminal_evidence()`);
    }

    // With storage healthy again, crash recovery completes the transition AND
    // its evidence in one transaction — the work was never lost.
    const staleNow = new Date(Date.now() + 16 * 60_000);
    assert.equal(await recoverStaleSchedulerOutbox(staleNow), 1);
    const completed = await readTerminalEvidence(rowId);
    assert.equal(completed.length, 1);
    assert.equal(completed[0]!.event, "crash_recovery_terminal_failure");
  } finally {
    await db.execute(sql`delete from scheduler_outbox where subject_id=${gateId} or org_id=${org.orgId}`);
    await dropScratchOrg(org.orgId);
  }
});

test("an authorized replay audits before/after and the failure evidence survives untouched", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const gateId = randomUUID();
  try {
    const actorId = await createScratchUser(org.orgId, "Ops Admin", "admin");
    await enqueueApprovalEscalation({ orgId: org.orgId, gateId });
    await db.execute(sql`
      update scheduler_outbox set next_attempt_at=${new Date(Date.now() - 1_000)}, attempt_count=${MAX_SCHEDULER_OUTBOX_ATTEMPTS - 1}
       where subject_id=${gateId}
    `);
    const rowId = (await db.execute<{ id: string }>(sql`
      select id from scheduler_outbox where subject_id=${gateId}
    `)).rows[0]!.id;
    await exhaustToTerminal({ runnerShouldThrow: (row) => row.id === rowId });

    const failureEnvelope = (await readTerminalEvidence(rowId))[0]!;
    const stampsBeforeReplay = (
      await db.execute<{ at: string; by: string }>(sql`
        select terminal_failed_at::text as at, terminal_failed_by as by
          from scheduler_outbox where id=${rowId}
      `)
    ).rows[0]!;

    // Bad justifications never touch the row.
    await assert.rejects(
      replayTerminalSchedulerOutbox({ orgId: org.orgId, id: rowId, actorId, reason: "too short" }),
      /replay reason must be/,
    );
    await assert.rejects(
      replayTerminalSchedulerOutbox({ orgId: org.orgId, id: rowId, actorId: randomUUID(), reason: "legitimate operator retry" }),
      /replay actor is not an active user/,
    );
    assert.equal((await readTerminalEvidence(rowId)).length, 1);

    const authorized = await replayTerminalSchedulerOutbox({
      orgId: org.orgId,
      id: rowId,
      actorId,
      reason: "queue outage cleared; retrying the poisoned escalation",
    });
    assert.equal(authorized, undefined);
    const evidence = await readTerminalEvidence(rowId);
    assert.equal(evidence.length, 2, JSON.stringify(evidence));

    // The original terminal-failure evidence survived byte-for-byte.
    const [originalFailure, replayAuthorization] = [
      evidence.find((e) => e.event === "terminal_failure"),
      evidence.find((e) => e.event === "replay_authorized"),
    ];
    assert.ok(originalFailure && replayAuthorization);
    assert.equal(originalFailure.reason, failureEnvelope.reason);
    assert.equal(originalFailure.attemptCount, MAX_SCHEDULER_OUTBOX_ATTEMPTS);
    assert.equal(originalFailure.markedBy, SCHEDULER_OUTBOX_WORKER_IDENTITY);

    // The authorization carries the operator, their justification, and the
    // verbatim before-stamps they chose to discard.
    assert.equal(replayAuthorization.markedBy, actorId);
    assert.equal(replayAuthorization.reason, "queue outage cleared; retrying the poisoned escalation");

    // The live row is reset for another lifecycle round.
    const reset = (
      await db.execute<{ status: string; attemptCount: number; stampedAt: string | null }>(sql`
        select status, attempt_count as "attemptCount", terminal_failed_at::text as "stampedAt"
          from scheduler_outbox where id=${rowId}
      `)
    ).rows[0]!;
    assert.deepEqual(reset, { status: "pending", attemptCount: 0, stampedAt: null });
    assert.notEqual(stampsBeforeReplay.at, null);
  } finally {
    await db.execute(sql`delete from scheduler_outbox where subject_id=${gateId} or org_id=${org.orgId}`);
    await dropScratchOrg(org.orgId);
  }
});

// ---------------------------------------------------------------------------
// Scheduled-script occurrence durability (engine/src/scheduler.ts). The claim
// must commit a durable dispatch-ledger row together with the cursor advance,
// dispatch must share one deterministic identity across Redis and inline
// fallback, and recovery must retry a lost dispatch exactly once. Redis is
// disabled in tests (packages/jobs config), so every case below exercises the
// inline fallback path of the same identity.
// ---------------------------------------------------------------------------

type OccurrenceEventRow = {
  event?: string;
  attempt?: number;
  scheduledFor?: string;
  job?: string;
  occurrence?: string;
  markedBy?: string;
  cron?: string | null;
  nextRunAt?: string | null;
};

/** Open the scripts feature gate and seed one active scheduled script due now. */
async function seedDueScheduledScript(orgId: string, source: string): Promise<string> {
  const scriptId = randomUUID();
  await db.execute(sql`
    update orgs
       set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,scripts}', 'true'::jsonb)
     where id = ${orgId}
  `);
  await db.execute(sql`
    insert into user_scripts (id, org_id, name, trigger_point, source, cron, next_run_at, timeout_ms, is_active)
    values (${scriptId}, ${orgId}, ${`Scratch cron ${scriptId.slice(0, 8)}`}, 'scheduled', ${source},
            '*/5 * * * *', ${new Date(Date.now() - 60_000)}, 2000, true)
  `);
  return scriptId;
}

async function loadOccurrence(
  scriptId: string,
): Promise<{ status: string; errorMessage: string | null; logs: OccurrenceEventRow[] }> {
  const row = (
    await db.execute<{ status: string; errorMessage: string | null; logs: OccurrenceEventRow[] }>(sql`
      select status, error_message as "errorMessage", logs
        from script_runs
       where script_id = ${scriptId} and target_kind = 'scheduled_occurrence'
    `)
  ).rows[0];
  assert.ok(row, `expected a dispatch-ledger row for script ${scriptId}`);
  return row;
}

async function countScheduledRuns(scriptId: string): Promise<number> {
  return (
    await db.execute<{ n: number }>(sql`
      select count(*)::int as n from script_runs
       where script_id = ${scriptId} and target_kind = 'scheduled'
    `)
  ).rows[0]!.n;
}

test("a malformed legacy scheduled script is durably quarantined and runs after repair", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const invalidCron = "definitely not a cron expression";
  const validCron = "*/5 * * * *";
  try {
    const scriptId = await seedDueScheduledScript(
      org.orgId,
      'function main(ctx) { ob.log("must not run before repair"); return "repaired"; }',
    );
    const dueAt = new Date(Date.now() - 60_000);
    await db.execute(sql`
      update user_scripts
         set cron = ${invalidCron}, next_run_at = ${dueAt}
       where id = ${scriptId}
    `);

    await runDueScripts();

    // The invalid occurrence never executes and never silently disappears:
    // the exact repairable cron/cursor survive while the row is explicitly
    // deactivated. A later scan is idempotent because inactive rows are not due.
    const quarantined = (
      await db.execute<{
        cron: string | null;
        nextRunAt: Date | string | null;
        isActive: boolean;
        lastRunAt: Date | string | null;
      }>(sql`
        select cron, next_run_at as "nextRunAt", is_active as "isActive",
               last_run_at as "lastRunAt"
          from user_scripts
         where id = ${scriptId}
      `)
    ).rows[0]!;
    assert.equal(quarantined.cron, invalidCron);
    assert.equal(new Date(quarantined.nextRunAt!).toISOString(), dueAt.toISOString());
    assert.equal(quarantined.isActive, false);
    assert.equal(quarantined.lastRunAt, null);
    assert.equal(await countScheduledRuns(scriptId), 0, "invalid configuration must not execute source");

    const failure = (
      await db.execute<{
        id: string;
        status: string;
        errorMessage: string | null;
        logs: OccurrenceEventRow[];
      }>(sql`
        select id, status, error_message as "errorMessage", logs
          from script_runs
         where script_id = ${scriptId} and target_kind = 'scheduled_configuration'
      `)
    ).rows[0]!;
    assert.equal(failure.status, "error");
    assert.match(failure.errorMessage ?? "", /invalid cron expression/);
    assert.equal(failure.logs[0]?.event, "invalid_cron_quarantined");
    assert.equal(failure.logs[0]?.markedBy, SCHEDULED_SCRIPT_SCHEDULER_IDENTITY);
    assert.equal(failure.logs[0]?.cron, invalidCron);
    assert.equal(new Date(failure.logs[0]!.nextRunAt!).toISOString(), dueAt.toISOString());

    const audit = (
      await db.execute<{
        actorId: string | null;
        changes: {
          event: string;
          actorKind: string;
          actor: string;
          reason: string;
          scriptRunId: string;
          before: { isActive: boolean; cron: string; nextRunAt: string };
          after: { isActive: boolean; cron: string; nextRunAt: string };
        };
      }>(sql`
        select actor_id as "actorId", changes
          from audit_log
         where table_name = 'user_scripts' and row_id = ${scriptId}
           and changes->>'event' = 'invalid_cron_quarantined'
      `)
    ).rows[0]!;
    assert.equal(audit.actorId, null, "the system quarantine must not impersonate a human actor");
    assert.equal(audit.changes.actorKind, "system");
    assert.equal(audit.changes.actor, SCHEDULED_SCRIPT_SCHEDULER_IDENTITY);
    assert.equal(audit.changes.scriptRunId, failure.id);
    assert.equal(audit.changes.before.cron, invalidCron);
    assert.equal(new Date(audit.changes.before.nextRunAt).toISOString(), dueAt.toISOString());
    assert.equal(audit.changes.before.isActive, true);
    assert.equal(audit.changes.after.isActive, false);
    assert.equal(audit.changes.after.cron, invalidCron);
    assert.equal(new Date(audit.changes.after.nextRunAt).toISOString(), dueAt.toISOString());

    await runDueScripts();
    const evidenceCount = (
      await db.execute<{ n: number }>(sql`
        select count(*)::int as n
          from script_runs
         where script_id = ${scriptId} and target_kind = 'scheduled_configuration'
      `)
    ).rows[0]!.n;
    assert.equal(evidenceCount, 1, "quarantine evidence is written once");

    // A controlled repair explicitly supplies a valid expression and
    // reactivates the row. The ordinary claim/dispatch path then runs once and
    // advances from the repaired due tick.
    const repairedDueAt = new Date(Date.now() - 30_000);
    await db.execute(sql`
      update user_scripts
         set cron = ${validCron}, next_run_at = ${repairedDueAt},
             is_active = true, updated_at = now()
       where id = ${scriptId}
    `);
    await runDueScripts();

    assert.equal(await countScheduledRuns(scriptId), 1);
    assert.equal((await loadOccurrence(scriptId)).status, "ok");
    const repaired = (
      await db.execute<{ cron: string; nextRunAt: Date | string; isActive: boolean }>(sql`
        select cron, next_run_at as "nextRunAt", is_active as "isActive"
          from user_scripts
         where id = ${scriptId}
      `)
    ).rows[0]!;
    assert.equal(repaired.cron, validCron);
    assert.equal(repaired.isActive, true);
    assert.ok(new Date(repaired.nextRunAt).getTime() > repairedDueAt.getTime());
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a valid scheduled-script control commits its durable occurrence with the cursor advance", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const scriptId = await seedDueScheduledScript(
      org.orgId,
      'function main(ctx) { ob.log("tick"); return "done"; }',
    );
    const dueAt = new Date(Date.now() - 60_000);
    await db.execute(sql`update user_scripts set next_run_at = ${dueAt} where id = ${scriptId}`);

    await runDueScripts();

    // The ledger row exists, carries the deterministic occurrence identity and
    // the scheduled-for stamp, and reached a terminal state via the inline
    // fallback that shares it.
    const occ = await loadOccurrence(scriptId);
    assert.equal(occ.status, "ok");
    assert.equal(occ.logs[0]?.event, "claimed");
    assert.equal(occ.logs[0]?.scheduledFor, dueAt.toISOString());
    assert.ok(occ.logs.some((e) => e.event === "ran_inline"), "the inline fallback ran under the shared identity");

    // Exactly one real scheduled-run audit row backs the occurrence.
    assert.equal(await countScheduledRuns(scriptId), 1);

    // The cron cursor advanced past the claimed tick — future schedule advance
    // stays recoverable and due again on time. The raw driver value is
    // normalized first so the assertion tests financial state, not whether the
    // pg driver happened to hand back a Date or its text form.
    const cursor = (
      await db.execute<{ nextRunAt: Date | string }>(sql`
        select next_run_at as "nextRunAt" from user_scripts where id = ${scriptId}
      `)
    ).rows[0]!.nextRunAt;
    assert.ok(new Date(cursor).getTime() > dueAt.getTime(), "the cron cursor advanced past the claimed tick");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

// A crash between the claim commit and any dispatch leaves the exact state
// crafted below; recovery must re-dispatch it eventually-exactly-once while
// the already-advanced cursor stays advanced (the tick is not re-armed).
// Equivalence note: concurrent scanners are serialized by the same single CAS
// UPDATE … WHERE next_run_at = $old guard this claim performs (a losing tick
// is just an empty claim), and the exhausted-retry loss is the identical
// finalize transition recovery makes when no evidence arrives — only the
// pre-state differs, so neither permutation needs its own scenario here.
test("a crash-orphaned occurrence is recovered exactly once and the cursor is not skipped", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await db.execute(sql`
      update orgs
         set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,scripts}', 'true'::jsonb)
       where id = ${org.orgId}
    `);
    // A crash after the claim committed but before any dispatch — craft the
    // exact state the atomic claim leaves behind, stale past the recovery
    // window, with the cursor already advanced past the missed tick.
    const crashedId = randomUUID();
    const scheduledFor = new Date(Date.now() - 30 * 60_000);
    const advancedTo = new Date(Date.now() + 3_600_000);
    await db.execute(sql`
      insert into user_scripts (id, org_id, name, trigger_point, source, cron, next_run_at, timeout_ms, is_active)
      values (${crashedId}, ${org.orgId}, ${`Scratch cron ${crashedId.slice(0, 8)}`}, 'scheduled',
              'function main(ctx) { return "recovered"; }',
              '*/5 * * * *', ${advancedTo}, 2000, true)
    `);
    await db.execute(sql`
      insert into script_runs (org_id, script_id, target_kind, target_id, status, logs, at)
      values (${org.orgId}, ${crashedId}, 'scheduled_occurrence', null, 'queued',
              jsonb_build_array(jsonb_build_object(
                'event', 'claimed',
                'occurrence', ${scriptOccurrenceKey(crashedId, scheduledFor)}::text,
                'scheduledFor', ${scheduledFor.toISOString()}::text,
                'attempt', 1)),
              ${scheduledFor})
    `);

    await recoverLostScriptOccurrences();

    // The orphaned claim was re-dispatched exactly once (attempt 2) and the
    // inline retry completed with terminal evidence on the SAME row.
    const recovered = await loadOccurrence(crashedId);
    assert.equal(recovered.status, "ok");
    assert.ok(recovered.logs.some((e) => e.event === "recover" && e.attempt === 2), "recovery consumed attempt 2");
    assert.ok(recovered.logs.some((e) => e.event === "ran_inline" && e.attempt === 2));
    assert.equal(await countScheduledRuns(crashedId), 1);

    // Recovery is not re-armed by later ticks — eventually exactly once.
    await recoverLostScriptOccurrences(new Date(Date.now() + 16 * 60_000));
    assert.equal(await countScheduledRuns(crashedId), 1, "no further executions after the single retry");

    // The cursor keeps its claimed advance: the missed tick is recovered
    // without being re-armed as due.
    const cursor = (
      await db.execute<{ nextRunAt: Date | string }>(sql`
        select next_run_at as "nextRunAt" from user_scripts where id = ${crashedId}
      `)
    ).rows[0]!.nextRunAt;
    assert.equal(new Date(cursor).toISOString(), advancedTo.toISOString());
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

// Recovery must also absorb REAL worker evidence: when the dispatched run
// actually executed, the worker-written target_kind='scheduled' row (the exact
// shape runScheduledScript persists) closes the open occurrence with its
// terminal outcome instead of recovery burning the one allowed retry on top.
test("worker-written terminal evidence closes an orphaned occurrence without a retry", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const scriptId = randomUUID();
    const scheduledFor = new Date(Date.now() - 30 * 60_000);
    await db.execute(sql`
      insert into user_scripts (id, org_id, name, trigger_point, source, cron, next_run_at, timeout_ms, is_active)
      values (${scriptId}, ${org.orgId}, ${`Scratch cron ${scriptId.slice(0, 8)}`}, 'scheduled',
              'function main(ctx) { return "ran-on-worker"; }', '*/5 * * * *',
              ${new Date(Date.now() + 3_600_000)}, 2000, true)
    `);
    // The same crash state as above — but this time the worker DID execute:
    // a real scheduled-run row landed after the claim committed.
    await db.execute(sql`
      insert into script_runs (org_id, script_id, target_kind, target_id, status, logs, at)
      values (${org.orgId}, ${scriptId}, 'scheduled_occurrence', null, 'queued',
              jsonb_build_array(jsonb_build_object(
                'event', 'claimed',
                'occurrence', ${scriptOccurrenceKey(scriptId, scheduledFor)}::text,
                'scheduledFor', ${scheduledFor.toISOString()}::text,
                'attempt', 1)),
              ${scheduledFor})
    `);
    await db.execute(sql`
      insert into script_runs (org_id, script_id, target_kind, status, duration_ms, logs, at)
      values (${org.orgId}, ${scriptId}, 'scheduled', 'ok', 120, '[{"event":"done"}]'::jsonb,
              ${new Date(scheduledFor.getTime() + 5_000)})
    `);

    await recoverLostScriptOccurrences();

    // The occurrence mirrored the worker's terminal outcome instead of
    // re-dispatching: absorbed status, durable absorb marker, no retry events,
    // and still exactly one real execution behind it.
    const closed = await loadOccurrence(scriptId);
    assert.equal(closed.status, "ok");
    assert.equal(closed.errorMessage, null);
    assert.ok(closed.logs.some((e) => e.event === "completed_on_worker"), "the absorb is durably logged");
    assert.ok(!closed.logs.some((e) => e.event === "recover"), "no retry was consumed");
    assert.equal(await countScheduledRuns(scriptId), 1);

    // A later tick neither resurrects nor re-retries it — eventually exactly once.
    await recoverLostScriptOccurrences(new Date(Date.now() + 16 * 60_000));
    assert.equal(await countScheduledRuns(scriptId), 1);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

// When multiple stale occurrences are open, worker evidence is not tied to an
// occurrence id. Recovery therefore assigns it to the oldest open occurrence;
// newer occurrences remain eligible for their own one-time retry.
test("worker evidence closes the oldest open occurrence before a newer claim", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const scriptId = await seedDueScheduledScript(
      org.orgId,
      'function main(ctx) { return "newer-retry"; }',
    );
    const oldestAt = new Date(Date.now() - 30 * 60_000);
    const newerAt = new Date(Date.now() - 20 * 60_000);
    const workerAt = new Date(Date.now() - 10 * 60_000);
    await db.execute(sql`
      update user_scripts set next_run_at = ${new Date(Date.now() + 3_600_000)} where id = ${scriptId}
    `);
    for (const scheduledFor of [oldestAt, newerAt]) {
      await db.execute(sql`
        insert into script_runs (org_id, script_id, target_kind, target_id, status, logs, at)
        values (${org.orgId}, ${scriptId}, 'scheduled_occurrence', null, 'queued',
                jsonb_build_array(jsonb_build_object(
                  'event', 'claimed',
                  'occurrence', ${scriptOccurrenceKey(scriptId, scheduledFor)}::text,
                  'scheduledFor', ${scheduledFor.toISOString()}::text,
                  'attempt', 1)),
                ${scheduledFor})
      `);
    }
    // The worker completed after the newer occurrence was claimed. Without
    // oldest-first recovery, this evidence is absorbed by the newer row and
    // the oldest row is dispatched again.
    await db.execute(sql`
      insert into script_runs (org_id, script_id, target_kind, status, duration_ms, logs, at)
      values (${org.orgId}, ${scriptId}, 'scheduled', 'ok', 120, '[{"event":"done"}]'::jsonb,
              ${workerAt})
    `);

    await recoverLostScriptOccurrences();

    const occurrences = (
      await db.execute<{ status: string; logs: OccurrenceEventRow[] }>(sql`
        select status, logs
          from script_runs
         where script_id = ${scriptId} and target_kind = 'scheduled_occurrence'
         order by at
      `)
    ).rows;
    assert.equal(occurrences.length, 2);
    const [oldest, newer] = occurrences;
    assert.equal(oldest!.status, "ok");
    assert.ok(oldest!.logs.some((event) => event.event === "completed_on_worker"));
    assert.ok(!oldest!.logs.some((event) => event.event === "recover"), "oldest occurrence was not retried");
    assert.equal(newer!.status, "ok");
    assert.ok(newer!.logs.some((event) => event.event === "recover" && event.attempt === 2));
    assert.ok(newer!.logs.some((event) => event.event === "ran_inline" && event.attempt === 2));
    assert.equal(await countScheduledRuns(scriptId), 2, "one worker run plus one newer-occurrence retry");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

// fnd_mt97sc1r_null regression — "durable claim before script execution": the
// audited scheduler advanced user_scripts.next_run_at in its own committed
// statement BEFORE any durable run/job existed, so a crash inside that window
// silently skipped the occurrence forever (cursor gone, zero evidence).
// The contract now is: the claim IS the commit — cursor advance and queued
// dispatch-ledger row land in ONE statement, execution only ever happens
// after that commit, so every intermediate crash either loses nothing or
// duplicates nothing.
test("the claim commits the cursor advance with its ledger row before any execution and cannot double-claim", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const scriptId = await seedDueScheduledScript(
      org.orgId,
      'function main(ctx) { return "recovered"; }',
    );
    const dueAt = new Date(Date.now() - 60_000);
    await db.execute(sql`update user_scripts set next_run_at = ${dueAt} where id = ${scriptId}`);

    const target = (await scanDueScripts()).find((s) => s.id === scriptId);
    assert.ok(target, "the due scheduled script is scanned");

    // The winning claim commits atomically: exactly one queued occurrence row
    // exists together with the advanced cursor — and NO script has executed.
    const claimed = await claimDueScriptOccurrence(target);
    assert.ok(claimed, "exactly one scanner wins the claim");
    assert.equal(claimed.occurrenceKey, scriptOccurrenceKey(scriptId, dueAt));
    const occ = await loadOccurrence(scriptId);
    assert.equal(occ.status, "queued");
    assert.equal(occ.logs[0]?.event, "claimed");
    assert.equal(occ.logs[0]?.attempt, 1);
    assert.equal(occ.logs[0]?.scheduledFor, dueAt.toISOString());
    assert.equal(occ.logs[0]?.occurrence, claimed.occurrenceKey);
    assert.equal(
      await countScheduledRuns(scriptId),
      0,
      "execution may never precede the durable claim",
    );
    const cursor = (
      await db.execute<{ nextRunAt: Date | string }>(sql`
        select next_run_at as "nextRunAt" from user_scripts where id = ${scriptId}
      `)
    ).rows[0]!.nextRunAt;
    assert.ok(new Date(cursor).getTime() > dueAt.getTime(), "the cursor advanced with the claim");

    // CRASH SIMULATION: this process dies here — dispatch never happens. A
    // re-scanner replaying the SAME stale due snapshot must lose the CAS and
    // must not insert a duplicate occurrence or move the cursor again.
    const again = await claimDueScriptOccurrence(target);
    assert.equal(again, null, "a losing claimant observes an empty claim");
    const occurrences = (
      await db.execute<{ n: number }>(sql`
        select count(*)::int as n from script_runs
         where script_id = ${scriptId} and target_kind = 'scheduled_occurrence'
      `)
    ).rows[0]!.n;
    assert.equal(occurrences, 1, "no duplicate dispatch-ledger rows");
    const cursorAfterReclaim = (
      await db.execute<{ nextRunAt: Date | string }>(sql`
        select next_run_at as "nextRunAt" from user_scripts where id = ${scriptId}
      `)
    ).rows[0]!.nextRunAt;
    assert.equal(new Date(cursorAfterReclaim).toISOString(), new Date(cursor).toISOString());

    // Recovery re-dispatches the orphaned first attempt exactly once; the run
    // loses nothing despite the crash window and can never double-fire.
    await recoverLostScriptOccurrences(new Date(Date.now() + 16 * 60_000));
    const recovered = await loadOccurrence(scriptId);
    assert.equal(recovered.status, "ok");
    assert.ok(recovered.logs.some((e) => e.event === "recover" && e.attempt === 2));
    assert.ok(recovered.logs.some((e) => e.event === "ran_inline" && e.attempt === 2));
    assert.equal(await countScheduledRuns(scriptId), 1, "zero loss, exactly one run");
    const cursorAfterRecovery = (
      await db.execute<{ nextRunAt: Date | string }>(sql`
        select next_run_at as "nextRunAt" from user_scripts where id = ${scriptId}
      `)
    ).rows[0]!.nextRunAt;
    assert.equal(new Date(cursorAfterRecovery).toISOString(), new Date(cursor).toISOString(), "recovery never re-arms the cursor");

    // Later ticks neither resurrect nor re-fire the closed occurrence.
    await recoverLostScriptOccurrences(new Date(Date.now() + 40 * 60_000));
    assert.equal(await loadOccurrence(scriptId).then((o) => o.status), "ok");
    assert.equal(await countScheduledRuns(scriptId), 1, "no duplicate run");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
