import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { deriveEmailDeliveryKey, reconcileDeliveryAttempts } from "@openbooks/emails";
import { businessToday } from "./business-date.ts";
import { db } from "./db.ts";
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
import {
  EMAIL_DELIVERY_WORKER_IDENTITY,
  REPORT_RUN_WORKER_IDENTITY,
  TERMINAL_FAILURE_LOG_EVENT,
} from "./terminal-failure.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "./test-fixtures.ts";

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
