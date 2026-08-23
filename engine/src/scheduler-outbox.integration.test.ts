import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import {
  enqueueApprovalEscalation,
  listFailedSchedulerOutbox,
  MAX_SCHEDULER_OUTBOX_ATTEMPTS,
  processDueSchedulerOutbox,
  recoverStaleSchedulerOutbox,
} from "./scheduler-outbox.ts";
import { SCHEDULER_OUTBOX_WORKER_IDENTITY, TERMINAL_FAILURE_LOG_EVENT } from "./terminal-failure.ts";
import { createScratchOrg, dropScratchOrg } from "./test-fixtures.ts";

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
