import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import {
  enqueueApprovalEscalation,
  enqueueFlowEmail,
  listFailedSchedulerOutbox,
  MAX_SCHEDULER_OUTBOX_ATTEMPTS,
  parseFlowEmailPayload,
  processDueSchedulerOutbox,
  recoverStaleSchedulerOutbox,
} from "./scheduler-outbox.ts";
import {
  recoverLostScriptOccurrences,
  runDueScripts,
  scriptOccurrenceKey,
} from "./scheduler.ts";
import { SCHEDULED_SCRIPT_SCHEDULER_IDENTITY } from "./scripting.ts";
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
