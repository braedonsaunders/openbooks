import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { deriveEmailDeliveryKey, isValidEmailAddress, normalizeEmailDeliveryInput, reconcileDeliveryAttempts } from "@openbooks/emails";
import { normalizeReportRecipientEmails } from "@openbooks/reports";
import { businessToday } from "../platform/business-date.ts";
import { db } from "../platform/db.ts";
import {
  appendEmailAttemptEvent,
  claimEmailDeliveryLog,
  confirmEmailSentGuarded,
  markEmailFailed,
  markEmailSent,
  markEmailUncertain,
} from "./email-config.ts";
import {
  dispatchQueuedReportRuns,
  dispatchReportDeliveries,
  markReportDeliveryFailed,
  markReportDeliverySent,
  markReportDeliveryStarted,
  markReportDeliverySuppressed,
  materializeDueReportRuns,
  MAX_DELIVERY_ATTEMPTS,
  MAX_RUN_ATTEMPTS,
  processScheduledReportRun,
} from "./report-delivery.ts";
import { enqueueEmail, getEmailQueue } from "@openbooks/jobs";
import {
  EMAIL_DELIVERY_WORKER_IDENTITY,
  REPORT_RUN_WORKER_IDENTITY,
  TERMINAL_FAILURE_LOG_EVENT,
} from "../platform/terminal-failure.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "../testing/fixtures.ts";

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

test("scheduled reports materialize once and retain artifact and delivery evidence", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  try {
    const definitionId = randomUUID();
    const scheduleId = randomUUID();
    const dueAt = new Date(Date.now() - 60_000);
    await db.execute(sql`
      insert into report_definitions
        (id, org_id, kind, report_type, slug, name, query, created_by, updated_by)
      values (${definitionId}, ${org.orgId}, 'custom', 'query', 'delivery-contract',
              'Delivery contract', '{}'::jsonb, ${actorId}, ${actorId})
    `);
    await db.execute(sql`
      insert into report_schedules
        (id, org_id, definition_id, cadence, hour, minute, timezone, recipient_emails, filters,
         next_run_at, active, created_by, updated_by)
      values (${scheduleId}, ${org.orgId}, ${definitionId}, 'daily', 7, 0, 'UTC',
              '["Controller@Example.com","audit@example.com"]'::jsonb,
              '{"combinator":"and","rules":[]}'::jsonb, ${dueAt}, true,
              ${actorId}, ${actorId})
    `);

    const concurrent = await Promise.all([
      materializeDueReportRuns(new Date()),
      materializeDueReportRuns(new Date()),
    ]);
    assert.equal(concurrent.flat().length, 1);
    const runs = (await db.execute<{ id: string; status: string; scheduled_for: Date; recipient_emails: string[]; filters: Record<string, unknown>; attempt_count: number }>(sql`
      select id, status, scheduled_for, recipient_emails, filters, attempt_count
        from report_runs where schedule_id=${scheduleId}
    `));
    assert.equal(runs.rows.length, 1);
    assert.equal(runs.rows[0]!.status, "queued");
    assert.equal(new Date(runs.rows[0]!.scheduled_for).toISOString(), dueAt.toISOString());
    assert.deepEqual(runs.rows[0]!.filters, { combinator: "and", rules: [] });

    const queueJobs: string[] = [];
    // next_attempt_at is written by PostgreSQL with microsecond precision,
    // while JavaScript Date is millisecond precision. Use an explicit
    // observation instant after the durable outbox write so an equal
    // millisecond cannot make the just-created run appear not-yet-due.
    const queueDispatchAsOf = new Date(Date.now() + 1_000);
    await assert.rejects(
      dispatchQueuedReportRuns(
        async () => { throw new Error("queue unavailable"); },
        queueDispatchAsOf,
      ),
      /queue unavailable/,
    );
    const afterQueueFailure = (await db.execute<{ status: string; dispatch_count: number }>(sql`
      select status, dispatch_count from report_runs where id=${runs.rows[0]!.id}
    `));
    assert.deepEqual(afterQueueFailure.rows[0], { status: "queued", dispatch_count: 0 });
    await dispatchQueuedReportRuns(
      async (_data, options) => {
        queueJobs.push(String(options?.jobId));
        return {} as never;
      },
      queueDispatchAsOf,
    );
    assert.deepEqual(queueJobs, [`report-run|${runs.rows[0]!.id}|0`]);

    const pdf = Buffer.from("%PDF-1.7\nimmutable report evidence");
    let renderCalls = 0;
    const renderOnce = async () => {
      renderCalls++;
      return pdf;
    };
    const processed = await Promise.all([
      processScheduledReportRun(runs.rows[0]!.id, renderOnce),
      processScheduledReportRun(runs.rows[0]!.id, renderOnce),
    ]);
    assert.equal(renderCalls, 1);
    assert.equal(processed.filter((value) => value.deliveries === 2).length, 1);
    const evidence = (await db.execute<{ status: string; attempt_count: number; size_bytes: number; content_hash: string; bytes: Buffer; deliveries: number; filename: string }>(sql`
      select r.status, r.attempt_count, a.size_bytes, a.content_hash, a.bytes,
             a.filename, count(d.id)::int as deliveries
        from report_runs r
        join report_run_artifacts a on a.run_id=r.id
        left join report_delivery_outbox d on d.run_id=r.id
       where r.id=${runs.rows[0]!.id}
       group by r.id, a.id
    `));
    assert.deepEqual(
      { status: evidence.rows[0]!.status, attempts: evidence.rows[0]!.attempt_count, size: evidence.rows[0]!.size_bytes, deliveries: evidence.rows[0]!.deliveries },
      { status: "succeeded", attempts: 1, size: pdf.length, deliveries: 2 },
    );
    assert.equal(evidence.rows[0]!.filename, `delivery-contract-${await businessToday(org.orgId)}.pdf`);
    assert.equal(evidence.rows[0]!.content_hash, createHash("sha256").update(pdf).digest("hex"));
    assert.deepEqual(Buffer.from(evidence.rows[0]!.bytes), pdf);

    const emailJobs: { id: string; recipient: string }[] = [];
    const dispatchAsOf = new Date(Date.now() + 60_000);
    assert.equal(await dispatchReportDeliveries(async (data, options) => {
      emailJobs.push({ id: String(options?.jobId), recipient: String(data.to) });
      return [];
    }, dispatchAsOf), 2);
    assert.equal(await dispatchReportDeliveries(async () => { throw new Error("already dispatched"); }, dispatchAsOf), 0);
    assert.deepEqual(emailJobs.map((job) => job.recipient).sort(), ["audit@example.com", "controller@example.com"]);

    const delivery = (await db.execute<{ id: string }>(sql`
      select id from report_delivery_outbox where run_id=${runs.rows[0]!.id} order by recipient limit 1
    `));
    const log = (await db.execute<{ id: string }>(sql`
      insert into email_log (org_id, recipients, recipient_primary, subject, status, category_key)
      values (${org.orgId}, '["audit@example.com"]'::jsonb, 'audit@example.com', 'Delivery contract', 'sent', 'report')
      returning id
    `));
    await markReportDeliveryStarted(org.orgId, delivery.rows[0]!.id, "contract-job");
    await markReportDeliverySent(org.orgId, delivery.rows[0]!.id, log.rows[0]!.id, "provider-123");
    const sent = (await db.execute<Record<string, unknown>>(sql`
      select status, attempt_count, email_log_id, provider_message_id, sent_at is not null as has_sent_at
        from report_delivery_outbox where id=${delivery.rows[0]!.id}
    `));
    assert.deepEqual(sent.rows[0], {
      status: "sent", attempt_count: 1, email_log_id: log.rows[0]!.id,
      provider_message_id: "provider-123", has_sent_at: true,
    });

    const retryRunId = randomUUID();
    await db.execute(sql`
      insert into report_runs
        (id, org_id, schedule_id, definition_id, trigger, status, scheduled_for, recipient_emails, next_attempt_at)
      values (${retryRunId}, ${org.orgId}, ${scheduleId}, ${definitionId}, 'scheduled', 'queued',
              ${new Date(dueAt.getTime() - 86_400_000)}, '["retry@example.com"]'::jsonb, now())
    `);
    await assert.rejects(
      processScheduledReportRun(retryRunId, async () => { throw new Error("renderer unavailable"); }),
      /renderer unavailable/,
    );
    const failed = (await db.execute<Record<string, unknown>>(sql`
      select r.status, r.attempt_count,
             exists(select 1 from report_run_artifacts a where a.run_id=r.id) as has_artifact,
             exists(select 1 from report_delivery_outbox d where d.run_id=r.id) as has_delivery
        from report_runs r where r.id=${retryRunId}
    `));
    assert.deepEqual(failed.rows[0], { status: "failed", attempt_count: 1, has_artifact: false, has_delivery: false });
    await processScheduledReportRun(retryRunId, async () => pdf);
    const retried = (await db.execute<Record<string, unknown>>(sql`
      select r.status, r.attempt_count, count(a.id)::int as artifacts, count(d.id)::int as deliveries
        from report_runs r left join report_run_artifacts a on a.run_id=r.id
        left join report_delivery_outbox d on d.run_id=r.id
       where r.id=${retryRunId} group by r.id
    `));
    assert.deepEqual(retried.rows[0], { status: "succeeded", attempt_count: 2, artifacts: 1, deliveries: 1 });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("exhausted report runs and deliveries are stamped terminal exactly once", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const definitionId = randomUUID();
    await db.execute(sql`
      insert into report_definitions
        (id, org_id, kind, report_type, slug, name, query, created_by, updated_by)
      values (${definitionId}, ${org.orgId}, 'custom', 'query', 'terminal-contract',
              'Terminal contract', '{}'::jsonb, null, null)
    `);
    const runId = randomUUID();
    await db.execute(sql`
      insert into report_runs
        (id, org_id, schedule_id, definition_id, trigger, status, scheduled_for,
         recipient_emails, next_attempt_at)
      values (${runId}, ${org.orgId}, null, ${definitionId}, 'scheduled', 'queued',
              ${new Date(Date.now() - 60_000)}, '[]'::jsonb, now())
    `);

    // Fail MAX_RUN_ATTEMPTS times: the last failure is the single transition
    // to terminal and must surface exactly one durable stamp + log line.
    let emissions: TerminalLog[] = [];
    for (let attempt = 1; attempt <= MAX_RUN_ATTEMPTS; attempt++) {
      const captured = captureConsoleLogs();
      await assert.rejects(
        processScheduledReportRun(runId, async () => { throw new Error("renderer exploded"); }),
        /renderer exploded/,
      );
      captured.restore();
      emissions = emissions.concat(terminalEvents(captured.lines).filter((event) => event.id === runId));
      const state = (await db.execute<{ attempt_count: number; terminal_failed_at: Date | null; terminal_failed_by: string | null }>(sql`
        select attempt_count, terminal_failed_at, terminal_failed_by from report_runs where id=${runId}
      `)).rows[0]!;
      assert.equal(state.attempt_count, attempt);
      if (attempt < MAX_RUN_ATTEMPTS) {
        assert.equal(emissions.length, 0, "no terminal signal before the ceiling");
        assert.equal(state.terminal_failed_at, null);
      } else {
        assert.equal(emissions.length, 1, `expected one terminal log line, got ${JSON.stringify(emissions)}`);
        assert.ok(state.terminal_failed_at);
        assert.equal(state.terminal_failed_by, REPORT_RUN_WORKER_IDENTITY);
      }
    }
    // A terminal run is never claimed again — no further surfacing is possible.
    assert.deepEqual(await processScheduledReportRun(runId, async () => Buffer.alloc(0)), { skipped: true });
    assert.equal(emissions.length, 1);

    const log = (await db.execute<{ id: string }>(sql`
      insert into email_log (org_id, recipients, recipient_primary, subject, status, category_key)
      values (${org.orgId}, '["audit@example.com"]'::jsonb, 'audit@example.com', 'Terminal contract', 'failed', 'report')
      returning id
    `)).rows[0]!.id;

    // A queue giveup only strands the row once attempts are also exhausted.
    const deliveryId = randomUUID();
    await db.execute(sql`
      insert into report_delivery_outbox
        (id, org_id, run_id, recipient, status, attempt_count, next_attempt_at)
      values (${deliveryId}, ${org.orgId}, ${runId}, 'audit@example.com', 'sending',
              ${MAX_DELIVERY_ATTEMPTS - 1}, now())
    `);
    const early = captureConsoleLogs();
    await markReportDeliveryFailed(org.orgId, deliveryId, log, "provider rejected", true);
    early.restore();
    const notTerminal = (await db.execute<{ status: string; terminal_failed_at: Date | null }>(sql`
      select status, terminal_failed_at from report_delivery_outbox where id=${deliveryId}
    `)).rows[0]!;
    assert.equal(notTerminal.status, "failed");
    assert.equal(notTerminal.terminal_failed_at, null);
    assert.equal(terminalEvents(early.lines).length, 0, "a giveup below the ceiling is retryable, not poison");

    // The scanner re-enqueues such a row; the extra attempt reaches the ceiling.
    await db.execute(sql`
      update report_delivery_outbox set status='sending', attempt_count=attempt_count+1
       where id=${deliveryId}
    `);
    const finalCapture = captureConsoleLogs();
    await markReportDeliveryFailed(org.orgId, deliveryId, log, "provider rejected again", true);
    finalCapture.restore();
    const stamped = (await db.execute<{ status: string; attempt_count: number; terminal_failed_at: Date | null; terminal_failed_by: string | null }>(sql`
      select status, attempt_count, terminal_failed_at, terminal_failed_by
        from report_delivery_outbox where id=${deliveryId}
    `)).rows[0]!;
    assert.equal(stamped.status, "failed");
    assert.ok(stamped.terminal_failed_at, "delivery at the ceiling must be stamped terminal");
    assert.equal(stamped.terminal_failed_by, EMAIL_DELIVERY_WORKER_IDENTITY);
    const deliveryEmissions = terminalEvents(finalCapture.lines).filter((event) => event.id === deliveryId);
    assert.equal(deliveryEmissions.length, 1);
    assert.equal(deliveryEmissions[0]?.attempts, MAX_DELIVERY_ATTEMPTS);

    // Re-reporting the same poison row never rewrites or duplicates the record.
    const repeat = captureConsoleLogs();
    await markReportDeliveryFailed(org.orgId, deliveryId, log, "provider rejected again", true);
    repeat.restore();
    const afterRepeat = (await db.execute<{ terminal_failed_at: Date | null }>(sql`
      select terminal_failed_at from report_delivery_outbox where id=${deliveryId}
    `)).rows[0]!;
    assert.deepEqual(afterRepeat.terminal_failed_at, stamped.terminal_failed_at);
    assert.equal(terminalEvents(repeat.lines).length, 0);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("stale suppression cannot rewrite a sent report delivery; a live suppression still lands", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const definitionId = randomUUID();
    await db.execute(sql`
      insert into report_definitions
        (id, org_id, kind, report_type, slug, name, query, created_by, updated_by)
      values (${definitionId}, ${org.orgId}, 'custom', 'query', 'suppress-guard',
              'Suppress guard', '{}'::jsonb, null, null)
    `);
    const runId = randomUUID();
    await db.execute(sql`
      insert into report_runs
        (id, org_id, schedule_id, definition_id, trigger, status, scheduled_for,
         recipient_emails, next_attempt_at)
      values (${runId}, ${org.orgId}, null, ${definitionId}, 'scheduled', 'queued',
              ${new Date(Date.now() - 60_000)}, '[]'::jsonb, now())
    `);
    const log = (await db.execute<{ id: string }>(sql`
      insert into email_log (org_id, recipients, recipient_primary, subject, status, category_key)
      values (${org.orgId}, '["audit@example.com"]'::jsonb, 'audit@example.com', 'Suppress guard', 'sent', 'report')
      returning id
    `)).rows[0]!.id;

    // An already-sent row carries delivered evidence; a stale retry's
    // provider-suppress callback must be a no-op against it.
    const sentDeliveryId = randomUUID();
    await db.execute(sql`
      insert into report_delivery_outbox
        (id, org_id, run_id, recipient, status, email_log_id, sent_at, attempt_count, next_attempt_at)
      values (${sentDeliveryId}, ${org.orgId}, ${runId}, 'audit@example.com', 'sent', ${log}, now(), 1, now())
    `);
    await markReportDeliverySuppressed(org.orgId, sentDeliveryId, log, "stale retry suppression");
    const afterStale = (await db.execute<{ status: string; email_log_id: string; sent_at: Date | null; error: string | null }>(sql`
      select status, email_log_id, sent_at, error from report_delivery_outbox where id=${sentDeliveryId}
    `)).rows[0]!;
    assert.deepEqual(
      { status: afterStale.status, log: afterStale.email_log_id, sent: afterStale.sent_at !== null, error: afterStale.error },
      { status: "sent", log, sent: true, error: null },
    );

    // A not-yet-sent row still takes the suppression (the live callback path).
    const enqueuedDeliveryId = randomUUID();
    await db.execute(sql`
      insert into report_delivery_outbox
        (id, org_id, run_id, recipient, status, attempt_count, next_attempt_at)
      values (${enqueuedDeliveryId}, ${org.orgId}, ${runId}, 'sandbox@example.com', 'enqueued', 1, now())
    `);
    await markReportDeliverySuppressed(org.orgId, enqueuedDeliveryId, log, "sandbox environment — email egress blocked");
    const afterLive = (await db.execute<{ status: string; email_log_id: string; error: string | null }>(sql`
      select status, email_log_id, error from report_delivery_outbox where id=${enqueuedDeliveryId}
    `)).rows[0]!;
    assert.deepEqual(
      { status: afterLive.status, log: afterLive.email_log_id, error: afterLive.error },
      { status: "suppressed", log, error: "sandbox environment — email egress blocked" },
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("stale failure cannot rewrite a sent report delivery; a live failure still lands", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const definitionId = randomUUID();
    await db.execute(sql`
      insert into report_definitions
        (id, org_id, kind, report_type, slug, name, query, created_by, updated_by)
      values (${definitionId}, ${org.orgId}, 'custom', 'query', 'failure-guard',
              'Failure guard', '{}'::jsonb, null, null)
    `);
    const runId = randomUUID();
    await db.execute(sql`
      insert into report_runs
        (id, org_id, schedule_id, definition_id, trigger, status, scheduled_for,
         recipient_emails, next_attempt_at)
      values (${runId}, ${org.orgId}, null, ${definitionId}, 'scheduled', 'queued',
              ${new Date(Date.now() - 60_000)}, '[]'::jsonb, now())
    `);
    const sentLogId = (await db.execute<{ id: string }>(sql`
      insert into email_log (org_id, recipients, recipient_primary, subject, status, category_key)
      values (${org.orgId}, '["audit@example.com"]'::jsonb, 'audit@example.com', 'Failure guard', 'sent', 'report')
      returning id
    `)).rows[0]!.id;
    const staleFailureLogId = (await db.execute<{ id: string }>(sql`
      insert into email_log (org_id, recipients, recipient_primary, subject, status, category_key)
      values (${org.orgId}, '["audit@example.com"]'::jsonb, 'audit@example.com', 'Failure guard', 'failed', 'report')
      returning id
    `)).rows[0]!.id;

    // A sent row carries immutable delivery evidence; a delayed failure
    // callback must not replace it with retry or terminal-failure state.
    const sentDeliveryId = randomUUID();
    await db.execute(sql`
      insert into report_delivery_outbox
        (id, org_id, run_id, recipient, status, email_log_id, provider_message_id,
         sent_at, attempt_count, next_attempt_at)
      values (${sentDeliveryId}, ${org.orgId}, ${runId}, 'audit@example.com', 'sent',
              ${sentLogId}, 'provider-accepted', now(), 1, now())
    `);
    await markReportDeliveryFailed(org.orgId, sentDeliveryId, staleFailureLogId, "stale provider failure", true);
    const afterStale = (await db.execute<{
      status: string;
      email_log_id: string;
      provider_message_id: string;
      sent_at: Date | null;
      error: string | null;
      terminal_failed_at: Date | null;
      terminal_failed_by: string | null;
    }>(sql`
      select status, email_log_id, provider_message_id, sent_at, error,
             terminal_failed_at, terminal_failed_by
        from report_delivery_outbox where id=${sentDeliveryId}
    `)).rows[0]!;
    assert.deepEqual(
      {
        status: afterStale.status,
        log: afterStale.email_log_id,
        provider: afterStale.provider_message_id,
        sent: afterStale.sent_at !== null,
        error: afterStale.error,
        terminal: afterStale.terminal_failed_at,
        terminalBy: afterStale.terminal_failed_by,
      },
      {
        status: "sent",
        log: sentLogId,
        provider: "provider-accepted",
        sent: true,
        error: null,
        terminal: null,
        terminalBy: null,
      },
    );

    // A live callback from the sending state still records a retryable failure.
    const liveDeliveryId = randomUUID();
    await db.execute(sql`
      insert into report_delivery_outbox
        (id, org_id, run_id, recipient, status, attempt_count, next_attempt_at)
      values (${liveDeliveryId}, ${org.orgId}, ${runId}, 'sandbox@example.com', 'sending', 1, now())
    `);
    await markReportDeliveryFailed(org.orgId, liveDeliveryId, staleFailureLogId, "provider unavailable", false);
    const afterLive = (await db.execute<{ status: string; email_log_id: string; error: string | null; sent_at: Date | null }>(sql`
      select status, email_log_id, error, sent_at
        from report_delivery_outbox where id=${liveDeliveryId}
    `)).rows[0]!;
    assert.deepEqual(
      { status: afterLive.status, log: afterLive.email_log_id, error: afterLive.error, sent: afterLive.sent_at !== null },
      { status: "enqueued", log: staleFailureLogId, error: "provider unavailable", sent: false },
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("provider-accepted uncertain outcome blocks blind re-send and resists markEmailFailed overwrite", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const deliveryKey = deriveEmailDeliveryKey({
      orgId: org.orgId,
      scope: "retry-test-uncertain",
      to: "retry@example.com",
    });

    // Claim the canonical row for attempt 1.
    const canonical = await claimEmailDeliveryLog({
      orgId: org.orgId,
      deliveryKey,
      jobId: "job-uncertain-1",
      provider: "resend",
      recipients: ["retry@example.com"],
      subject: "Uncertain retry test",
    });
    assert.equal(canonical.attempts.length, 0);

    // Simulate attempt 1: uncertain outcome (timeout after provider acceptance).
    await appendEmailAttemptEvent(org.orgId, canonical.id, {
      attempt: 1,
      outcome: "uncertain",
      detail: "Resend: request timed out before confirmation — acceptance state unresolved",
    });
    await markEmailUncertain(org.orgId, canonical.id, "Resend: request timed out");

    // Verify the row is in uncertain status.
    const afterUncertain = (await db.execute<{ status: string }>(sql`
      select status from email_log where id = ${canonical.id}
    `)).rows[0]!;
    assert.equal(afterUncertain.status, "uncertain");

    // Re-reclaim: the same delivery key must return the same canonical row.
    const reclaimed = await claimEmailDeliveryLog({
      orgId: org.orgId,
      deliveryKey,
      jobId: "job-uncertain-2",
      provider: "resend",
      recipients: ["retry@example.com"],
      subject: "Uncertain retry test",
    });
    assert.equal(reclaimed.id, canonical.id);
    assert.equal(reclaimed.status, "uncertain");
    assert.equal(reclaimed.attempts.length, 1);
    assert.equal(reclaimed.attempts[0]!.outcome, "uncertain");

    // Reconciliation gate must suppress re-send — the earlier uncertain
    // attempt means acceptance is unproven.
    const decision = reconcileDeliveryAttempts(reclaimed.attempts);
    assert.equal(decision.action, "suppress");
    assert.ok(decision.reason.includes("attempt 1"));
    assert.ok(decision.reason.includes("unresolved"));

    // markEmailFailed must NOT overwrite the uncertain status — a retried
    // attempt that fails has no authority to rewrite an uncertain outcome.
    await markEmailFailed(org.orgId, canonical.id, "retry also failed");
    const afterMarkFailed = (await db.execute<{ status: string }>(sql`
      select status from email_log where id = ${canonical.id}
    `)).rows[0]!;
    assert.equal(afterMarkFailed.status, "uncertain",
      "markEmailFailed must not overwrite an uncertain status");

    // An operator can resolve the uncertainty by confirming acceptance.
    const confirmed = await confirmEmailSentGuarded(org.orgId, canonical.id, "re_abc123");
    assert.ok(confirmed);
    const afterConfirm = (await db.execute<{ status: string; provider_message_id: string }>(sql`
      select status, provider_message_id from email_log where id = ${canonical.id}
    `)).rows[0]!;
    assert.equal(afterConfirm.status, "sent");
    assert.equal(afterConfirm.provider_message_id, "re_abc123");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("happy pre-accept retry succeeds after definite failure", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const deliveryKey = deriveEmailDeliveryKey({
      orgId: org.orgId,
      scope: "retry-test-preaccept",
      to: "retry@example.com",
    });

    // Claim the canonical row for attempt 1.
    const canonical = await claimEmailDeliveryLog({
      orgId: org.orgId,
      deliveryKey,
      jobId: "job-preaccept-1",
      provider: "resend",
      recipients: ["retry@example.com"],
      subject: "Pre-accept retry test",
    });

    // Attempt 1: definite failure (pre-accept — connection refused).
    await appendEmailAttemptEvent(org.orgId, canonical.id, {
      attempt: 1,
      outcome: "notSent",
      detail: "Resend: network request failed (ECONNREFUSED)",
    });
    await markEmailFailed(org.orgId, canonical.id, "connection refused");

    // Verify the row is in failed status.
    const afterFailed = (await db.execute<{ status: string }>(sql`
      select status from email_log where id = ${canonical.id}
    `)).rows[0]!;
    assert.equal(afterFailed.status, "failed");

    // Re-reclaim: same delivery key returns the same canonical row.
    const reclaimed = await claimEmailDeliveryLog({
      orgId: org.orgId,
      deliveryKey,
      jobId: "job-preaccept-2",
      provider: "resend",
      recipients: ["retry@example.com"],
      subject: "Pre-accept retry test",
    });
    assert.equal(reclaimed.id, canonical.id);
    assert.equal(reclaimed.attempts.length, 1);

    // Reconciliation gate permits re-send — only definite failures, no uncertainty.
    const decision = reconcileDeliveryAttempts(reclaimed.attempts);
    assert.equal(decision.action, "send");

    // Attempt 2: successful delivery.
    await appendEmailAttemptEvent(org.orgId, canonical.id, {
      attempt: 2,
      outcome: "sent",
      detail: "re_success_456",
    });
    await markEmailSent(org.orgId, canonical.id, "re_success_456");

    // Verify the row is in sent status with the provider message id.
    const afterSent = (await db.execute<{ status: string; provider_message_id: string }>(sql`
      select status, provider_message_id from email_log where id = ${canonical.id}
    `)).rows[0]!;
    assert.equal(afterSent.status, "sent");
    assert.equal(afterSent.provider_message_id, "re_success_456");

    // A third attempt reconciles to complete without re-sending.
    const thirdClaim = await claimEmailDeliveryLog({
      orgId: org.orgId,
      deliveryKey,
      jobId: "job-preaccept-3",
      provider: "resend",
      recipients: ["retry@example.com"],
      subject: "Pre-accept retry test",
    });
    const thirdDecision = reconcileDeliveryAttempts(thirdClaim.attempts);
    assert.equal(thirdDecision.action, "complete");
    if (thirdDecision.action === "complete") {
      assert.equal(thirdDecision.providerMessageId, "re_success_456");
    }
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("an undeliverable recipient quarantines without stalling the delivery scan", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    // The schedule write path accepts this address while the dispatch-time
    // provider validation refuses it, so it can reach a materialized outbox
    // row through the front door. Lock both halves of that divergence here.
    const poison = ".leading-dot@example.com";
    assert.deepEqual(normalizeReportRecipientEmails([poison]), [poison]);
    assert.equal(isValidEmailAddress(poison), false);

    const definitionId = randomUUID();
    await db.execute(sql`
      insert into report_definitions
        (id, org_id, kind, report_type, slug, name, query, created_by, updated_by)
      values (${definitionId}, ${org.orgId}, 'custom', 'query', 'poison-quarantine',
              'Poison quarantine', '{}'::jsonb, null, null)
    `);
    const runId = randomUUID();
    await db.execute(sql`
      insert into report_runs
        (id, org_id, schedule_id, definition_id, trigger, status, scheduled_for,
         recipient_emails, next_attempt_at)
      values (${runId}, ${org.orgId}, null, ${definitionId}, 'scheduled', 'succeeded',
              ${new Date(Date.now() - 3_600_000)}, '[]'::jsonb, now())
    `);
    const pdf = Buffer.from("%PDF-1.7\npoison quarantine evidence");
    await db.execute(sql`
      insert into report_run_artifacts
        (org_id, run_id, filename, content_type, size_bytes, content_hash, bytes)
      values (${org.orgId}, ${runId}, 'poison-quarantine.pdf', 'application/pdf',
              ${pdf.length}, ${createHash("sha256").update(pdf).digest("hex")}, ${pdf})
    `);
    // The poison row sorts FIRST so a pre-fix dispatch dies on it before the
    // healthy row is ever reached — the exact production stall shape.
    const poisonId = randomUUID();
    const healthyId = randomUUID();
    await db.execute(sql`
      insert into report_delivery_outbox
        (id, org_id, run_id, recipient, status, attempt_count, next_attempt_at)
      values (${poisonId}, ${org.orgId}, ${runId}, ${poison}, 'pending', 0,
              ${new Date(Date.now() - 3_000_000)}),
             (${healthyId}, ${org.orgId}, ${runId}, 'healthy@example.com', 'pending', 0,
              ${new Date(Date.now() - 60_000)})
    `);

    const enqueued: string[] = [];
    const asOf = new Date(Date.now() + 60_000);
    // The stub stands in for the Redis queue, but production validation lives
    // inside enqueueEmail before queue.add — reproduce it so the poison row
    // throws exactly as it does on a live tick.
    assert.equal(await dispatchReportDeliveries(async (data) => {
      normalizeEmailDeliveryInput(data);
      enqueued.push(String(data.to));
      return [];
    }, asOf), 1);
    assert.deepEqual(enqueued, ["healthy@example.com"]);

    const rows = (await db.execute<{
      id: string; recipient: string; status: string; attempt_count: number;
      error: string | null; terminal_failed_at: Date | null; terminal_failed_by: string | null;
    }>(sql`
      select id, recipient, status, attempt_count, error, terminal_failed_at, terminal_failed_by
        from report_delivery_outbox where run_id = ${runId} order by recipient
    `));
    const poisonRow = rows.rows.find((row) => row.id === poisonId)!;
    assert.equal(poisonRow.status, "failed");
    assert.equal(poisonRow.attempt_count, MAX_DELIVERY_ATTEMPTS);
    assert.match(poisonRow.error ?? "", /invalid recipient/i);
    assert.ok(poisonRow.terminal_failed_at, "poison row must carry a terminal stamp");
    assert.equal(poisonRow.terminal_failed_by, EMAIL_DELIVERY_WORKER_IDENTITY);

    // The quarantine is stable: a later scan dispatches nothing and leaves the
    // poison row untouched instead of retrying it forever.
    assert.equal(await dispatchReportDeliveries(async () => { throw new Error("must not dispatch"); }, new Date(Date.now() + 120_000)), 0);
    const after = (await db.execute<{ status: string; attempt_count: number }>(sql`
      select status, attempt_count from report_delivery_outbox where id = ${poisonId}
    `)).rows[0]!;
    assert.deepEqual(after, { status: "failed", attempt_count: MAX_DELIVERY_ATTEMPTS });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

async function seedSucceededRunWithArtifact(orgId: string, tag: string): Promise<{ runId: string }> {
  const definitionId = randomUUID();
  await db.execute(sql`
    insert into report_definitions
      (id, org_id, kind, report_type, slug, name, query, created_by, updated_by)
    values (${definitionId}, ${orgId}, 'custom', 'query', ${`rebuild-${tag}`},
            'Rebuild sweep', '{}'::jsonb, null, null)
  `);
  const runId = randomUUID();
  await db.execute(sql`
    insert into report_runs
      (id, org_id, schedule_id, definition_id, trigger, status, scheduled_for,
       recipient_emails, next_attempt_at)
    values (${runId}, ${orgId}, null, ${definitionId}, 'scheduled', 'succeeded',
            ${new Date(Date.now() - 3_600_000)}, '[]'::jsonb, now())
  `);
  const pdf = Buffer.from(`%PDF-1.7\nrebuild sweep ${tag}`);
  await db.execute(sql`
    insert into report_run_artifacts
      (org_id, run_id, filename, content_type, size_bytes, content_hash, bytes)
    values (${orgId}, ${runId}, 'rebuild.pdf', 'application/pdf',
            ${pdf.length}, ${createHash("sha256").update(pdf).digest("hex")}, ${pdf})
  `);
  return { runId };
}

function rebuildKey(orgId: string, logId: string, to: string): string {
  // Mirrors the email worker's canonical key for report deliveries exactly.
  return deriveEmailDeliveryKey({ orgId, scope: `report:${logId}`, to });
}

test("a stuck enqueued delivery rebuilds: orphan job removed, row redispatched", { skip: !DB }, async () => {
  if (!process.env.REDIS_URL && !process.env.OPENBOOKS_REDIS_URL) {
    console.log("  # SKIP redis-backed orphan seeding needs REDIS_URL; row-rebuild half still runs");
  }
  const org = await createScratchOrg();
  try {
    const { runId } = await seedSucceededRunWithArtifact(org.orgId, "lost");
    // A dispatch that died after the DB mark but before/without a surviving
    // email job: 'enqueued' with a long-past next_attempt_at and no outcome.
    const logId = randomUUID();
    const jobId = `report-delivery|${logId}|1`;
    await db.execute(sql`
      insert into report_delivery_outbox
        (id, org_id, run_id, recipient, status, attempt_count, dispatch_count, queue_job_id, next_attempt_at)
      values (${logId}, ${org.orgId}, ${runId}, 'rebuild@example.com', 'enqueued', 1, 1, ${jobId},
              ${new Date(Date.now() - 3_600_000)})
    `);
    let orphanPresent: boolean | null = null;
    try {
      await enqueueEmail({
        orgId: org.orgId,
        to: "rebuild@example.com",
        subject: "orphan",
        html: "<p>orphan</p>",
        text: "orphan",
        attachments: [],
      }, { jobId });
      orphanPresent = (await getEmailQueue().getJob(jobId)) != null;
    } catch {
      orphanPresent = null;
    }
    const enqueued: string[] = [];
    assert.equal(await dispatchReportDeliveries(async (data) => {
      normalizeEmailDeliveryInput(data);
      enqueued.push(String(data.to));
      return [];
    }, new Date(Date.now() + 60_000)), 1);
    assert.deepEqual(enqueued, ["rebuild@example.com"]);
    if (orphanPresent) {
      assert.equal(await getEmailQueue().getJob(jobId) == null, true, "orphan job must be removed so rebuild cannot double-send");
    }
    const row = (await db.execute<{ status: string; dispatch_count: number; error: string | null }>(sql`
      select status, dispatch_count, error from report_delivery_outbox where id = ${logId}
    `)).rows[0]!;
    // The normal scan never takes 'enqueued' rows, so a new generation here
    // proves the rebuild sweep reset it.
    assert.equal(row.status, "enqueued");
    assert.equal(row.dispatch_count, 2);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a stuck enqueued delivery with a sent outcome reconciles to sent", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const { runId } = await seedSucceededRunWithArtifact(org.orgId, "sent");
    const logId = randomUUID();
    await db.execute(sql`
      insert into report_delivery_outbox
        (id, org_id, run_id, recipient, status, attempt_count, dispatch_count, next_attempt_at)
      values (${logId}, ${org.orgId}, ${runId}, 'sent@example.com', 'enqueued', 1, 1,
              ${new Date(Date.now() - 3_600_000)})
    `);
    // The provider accepted the send but the process died before the row
    // advanced: resending would duplicate, so the sweep must reconcile.
    const claim = await claimEmailDeliveryLog({
      orgId: org.orgId,
      deliveryKey: rebuildKey(org.orgId, logId, "sent@example.com"),
      jobId: rebuildKey(org.orgId, logId, "sent@example.com"),
      provider: "resend",
      recipients: ["sent@example.com"],
      subject: "Rebuild sweep",
    });
    await markEmailSent(org.orgId, claim.id, "re_sweep_1");
    assert.equal(await dispatchReportDeliveries(async () => { throw new Error("must not dispatch"); }, new Date(Date.now() + 60_000)), 0);
    const row = (await db.execute<{ status: string; dispatch_count: number }>(sql`
      select status, dispatch_count from report_delivery_outbox where id = ${logId}
    `)).rows[0]!;
    assert.equal(row.status, "sent");
    assert.equal(row.dispatch_count, 1);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a stuck enqueued delivery with a live job is left alone", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const { runId } = await seedSucceededRunWithArtifact(org.orgId, "live");
    const logId = randomUUID();
    await db.execute(sql`
      insert into report_delivery_outbox
        (id, org_id, run_id, recipient, status, attempt_count, dispatch_count, next_attempt_at)
      values (${logId}, ${org.orgId}, ${runId}, 'live@example.com', 'enqueued', 1, 1,
              ${new Date(Date.now() - 3_600_000)})
    `);
    // A claimed attempt with no outcome means the send may still be in
    // flight: rebuilding now would risk a duplicate.
    await claimEmailDeliveryLog({
      orgId: org.orgId,
      deliveryKey: rebuildKey(org.orgId, logId, "live@example.com"),
      jobId: rebuildKey(org.orgId, logId, "live@example.com"),
      provider: "resend",
      recipients: ["live@example.com"],
      subject: "Rebuild sweep",
    });
    assert.equal(await dispatchReportDeliveries(async () => { throw new Error("must not dispatch"); }, new Date(Date.now() + 60_000)), 0);
    const row = (await db.execute<{ status: string; dispatch_count: number }>(sql`
      select status, dispatch_count from report_delivery_outbox where id = ${logId}
    `)).rows[0]!;
    assert.deepEqual(row, { status: "enqueued", dispatch_count: 1 });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a stuck sending delivery rebuilds for redispatch after its worker dies", async () => {
  const org = await createScratchOrg();
  try {
    const { runId } = await seedSucceededRunWithArtifact(org.orgId, "sending-lost");
    // A worker that crashed after markReportDeliveryStarted but before any
    // send: 'sending' with a long-past claim timestamp and no email outcome.
    // The dispatch scan only takes pending/failed rows, so without recovery
    // this delivery would sit here forever.
    const logId = randomUUID();
    await db.execute(sql`
      insert into report_delivery_outbox
        (id, org_id, run_id, recipient, status, attempt_count, dispatch_count, next_attempt_at, updated_at)
      values (${logId}, ${org.orgId}, ${runId}, 'sending-lost@example.com', 'sending', 1, 1,
              ${new Date(Date.now() - 3_600_000)}, ${new Date(Date.now() - 3_600_000)})
    `);
    const enqueued: string[] = [];
    assert.equal(await dispatchReportDeliveries(async (data) => {
      normalizeEmailDeliveryInput(data);
      enqueued.push(String(data.to));
      return [];
    }, new Date(Date.now() + 60_000)), 1);
    assert.deepEqual(enqueued, ["sending-lost@example.com"]);
    const row = (await db.execute<{ status: string; dispatch_count: number }>(sql`
      select status, dispatch_count from report_delivery_outbox where id = ${logId}
    `)).rows[0]!;
    // Recovered to failed, then redispatched by the normal scan to enqueued
    // with a new generation — idempotent against the delivery key.
    assert.equal(row.status, "enqueued");
    assert.equal(row.dispatch_count, 2);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a stuck sending delivery with a sent outcome reconciles to sent", async () => {
  const org = await createScratchOrg();
  try {
    const { runId } = await seedSucceededRunWithArtifact(org.orgId, "sending-sent");
    const logId = randomUUID();
    await db.execute(sql`
      insert into report_delivery_outbox
        (id, org_id, run_id, recipient, status, attempt_count, dispatch_count, next_attempt_at, updated_at)
      values (${logId}, ${org.orgId}, ${runId}, 'sending-sent@example.com', 'sending', 1, 1,
              ${new Date(Date.now() - 3_600_000)}, ${new Date(Date.now() - 3_600_000)})
    `);
    // The provider accepted the send but the process died before the row
    // advanced: resending would duplicate, so recovery must reconcile.
    const claim = await claimEmailDeliveryLog({
      orgId: org.orgId,
      deliveryKey: rebuildKey(org.orgId, logId, "sending-sent@example.com"),
      jobId: rebuildKey(org.orgId, logId, "sending-sent@example.com"),
      provider: "resend",
      recipients: ["sending-sent@example.com"],
      subject: "Recovery sweep",
    });
    await markEmailSent(org.orgId, claim.id, "re_sweep_sending_1");
    assert.equal(await dispatchReportDeliveries(async () => { throw new Error("must not dispatch"); }, new Date(Date.now() + 60_000)), 0);
    const row = (await db.execute<{ status: string; dispatch_count: number }>(sql`
      select status, dispatch_count from report_delivery_outbox where id = ${logId}
    `)).rows[0]!;
    assert.equal(row.status, "sent");
    assert.equal(row.dispatch_count, 1);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a stuck sending delivery with a live attempt is left alone", async () => {
  const org = await createScratchOrg();
  try {
    const { runId } = await seedSucceededRunWithArtifact(org.orgId, "sending-live");
    const logId = randomUUID();
    await db.execute(sql`
      insert into report_delivery_outbox
        (id, org_id, run_id, recipient, status, attempt_count, dispatch_count, next_attempt_at, updated_at)
      values (${logId}, ${org.orgId}, ${runId}, 'sending-live@example.com', 'sending', 1, 1,
              ${new Date(Date.now() - 3_600_000)}, ${new Date(Date.now() - 3_600_000)})
    `);
    // A recent claim with no outcome means the send may still be in flight:
    // recovering now would risk a duplicate.
    await claimEmailDeliveryLog({
      orgId: org.orgId,
      deliveryKey: rebuildKey(org.orgId, logId, "sending-live@example.com"),
      jobId: rebuildKey(org.orgId, logId, "sending-live@example.com"),
      provider: "resend",
      recipients: ["sending-live@example.com"],
      subject: "Recovery sweep",
    });
    assert.equal(await dispatchReportDeliveries(async () => { throw new Error("must not dispatch"); }, new Date(Date.now() + 60_000)), 0);
    const row = (await db.execute<{ status: string; dispatch_count: number }>(sql`
      select status, dispatch_count from report_delivery_outbox where id = ${logId}
    `)).rows[0]!;
    assert.deepEqual(row, { status: "sending", dispatch_count: 1 });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

/** A queued scheduled run with a renderable definition, for lease-race tests. */
async function seedLeaseRaceRun(orgId: string, tag: string): Promise<{ runId: string }> {
  const definitionId = randomUUID();
  await db.execute(sql`
    insert into report_definitions
      (id, org_id, kind, report_type, slug, name, query, created_by, updated_by)
    values (${definitionId}, ${orgId}, 'custom', 'query', ${`lease-race-${tag}`},
            'Lease race', '{}'::jsonb, null, null)
  `);
  const runId = randomUUID();
  await db.execute(sql`
    insert into report_runs
      (id, org_id, schedule_id, definition_id, trigger, status, scheduled_for,
       recipient_emails, next_attempt_at)
    values (${runId}, ${orgId}, null, ${definitionId}, 'scheduled', 'queued',
            ${new Date(Date.now() - 3_600_000)}, '["lease-race@example.com"]'::jsonb, now())
  `);
  return { runId };
}

test("a superseded renderer's late failure cannot overwrite another renderer's success", async () => {
  const org = await createScratchOrg();
  try {
    const { runId } = await seedLeaseRaceRun(org.orgId, "late-failure");
    const live = Buffer.from("%PDF-1.7\nlive renderer bytes");
    const outcome = await processScheduledReportRun(runId, async () => {
      // Mid-render, the stale sweep reassigns the lease and a second
      // renderer claims it and succeeds — exactly the race the lease guards.
      // The winner is a REAL second run of the same function, so the stored
      // artifact and outbox below prove whose bytes survived.
      await db.execute(sql`
        update report_runs set status='queued', locked_at=null, updated_at=now()
         where id=${runId} and org_id=${org.orgId} and status='running'
      `);
      const liveOutcome = await processScheduledReportRun(runId, async () => live);
      assert.deepEqual(liveOutcome, { deliveries: 1 });
      throw new Error("renderer A failed after losing the lease");
    });
    assert.deepEqual(outcome, { skipped: true });
    const row = (await db.execute<{ status: string; error: string | null; attempt_count: number }>(sql`
      select status, error, attempt_count from report_runs where id=${runId}
    `)).rows[0]!;
    assert.equal(row.status, "succeeded", "the late failure must not overwrite success");
    assert.equal(row.error, null);
    assert.equal(row.attempt_count, 2);
    const owned = (await db.execute<{ content_hash: string; bytes: Buffer; recipients: string[] }>(sql`
      select a.content_hash, a.bytes,
             array(select d.recipient from report_delivery_outbox d
                    where d.run_id=${runId} order by d.recipient) as recipients
        from report_run_artifacts a where a.run_id=${runId}
    `)).rows;
    assert.equal(owned.length, 1, "exactly the live renderer's artifact is stored");
    assert.equal(owned[0]!.content_hash, createHash("sha256").update(live).digest("hex"));
    assert.deepEqual(Buffer.from(owned[0]!.bytes), live);
    assert.deepEqual(owned[0]!.recipients, ["lease-race@example.com"]);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a superseded renderer's bytes are never stored; the live renderer owns the artifact", async () => {
  const org = await createScratchOrg();
  try {
    const { runId } = await seedLeaseRaceRun(org.orgId, "late-success");
    const stale = Buffer.from("%PDF-1.7\nstale renderer bytes");
    const live = Buffer.from("%PDF-1.7\nlive renderer bytes");
    // Renderer A is slow: mid-render the sweep requeues the run, then A
    // finishes and commits. Its stale bytes must NOT be stored — the
    // conflict no-ops would otherwise make the live renderer's inserts skip
    // and the stale PDF would be stored and delivered.
    const outcome = await processScheduledReportRun(runId, async () => {
      await db.execute(sql`
        update report_runs set status='queued', locked_at=null, updated_at=now()
         where id=${runId} and org_id=${org.orgId} and status='running'
      `);
      return stale;
    });
    assert.deepEqual(outcome, { skipped: true });
    const liveOutcome = await processScheduledReportRun(runId, async () => live);
    assert.deepEqual(liveOutcome, { deliveries: 1 });
    const owned = (await db.execute<{ status: string; attempt_count: number; content_hash: string; bytes: Buffer; recipients: string[] }>(sql`
      select r.status, r.attempt_count, a.content_hash, a.bytes,
             array(select d.recipient from report_delivery_outbox d
                    where d.run_id=${runId} order by d.recipient) as recipients
        from report_runs r join report_run_artifacts a on a.run_id=r.id
       where r.id=${runId}
    `)).rows;
    assert.equal(owned.length, 1);
    assert.equal(owned[0]!.status, "succeeded");
    assert.equal(owned[0]!.attempt_count, 2);
    assert.equal(owned[0]!.content_hash, createHash("sha256").update(live).digest("hex"));
    assert.deepEqual(Buffer.from(owned[0]!.bytes), live, "the stale PDF must not be stored");
    assert.deepEqual(owned[0]!.recipients, ["lease-race@example.com"]);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
