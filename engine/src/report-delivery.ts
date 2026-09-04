import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { computeNextRunAt } from "@openbooks/reports";
import { enqueueEmail, enqueueReportRun, type EnqueueEmailData } from "@openbooks/jobs";
import { scheduledReportEmail } from "@openbooks/emails";
import { businessToday } from "./business-date.ts";
import { db } from "./db.ts";
import {
  EMAIL_DELIVERY_WORKER_IDENTITY,
  logTerminalFailure,
  REPORT_RUN_WORKER_IDENTITY,
} from "./terminal-failure.ts";
import {
  ATTR_DEFINITION_ID,
  ATTR_KIND,
  ATTR_ORG_ID,
  ATTR_RUN_ID,
  ATTR_SURFACE,
  recordOutboxAttempt,
  runInSpan,
} from "./telemetry.ts";

/**
 * Scheduled report runs and their per-recipient delivery outbox — same
 * claim/run/fail/retry contract as scheduler_outbox (see that module for the
 * tick loop). Redis/BullMQ queues are rebuilt from these tables after a crash.
 *
 * Terminal failures are not silent: the attempt whose failure reaches the run
 * ceiling (MAX_RUN_ATTEMPTS) or, for deliveries, a queue-giveup at the delivery
 * ceiling (MAX_DELIVERY_ATTEMPTS) stamps terminal_failed_at /
 * terminal_failed_by exactly once and emits one structured
 * "scheduler.terminal_failure" log line plus one `openbooks.terminal_failures`
 * metric increment (see telemetry.ts). Operators alert on poison rows with:
 *
 *   select id, org_id, definition_id, error, attempt_count,
 *          terminal_failed_at, terminal_failed_by
 *     from report_runs where terminal_failed_at is not null
 *    order by terminal_failed_at desc;
 *
 *   select id, org_id, recipient, error, attempt_count,
 *          terminal_failed_at, terminal_failed_by
 *     from report_delivery_outbox where terminal_failed_at is not null
 *    order by terminal_failed_at desc;
 */

export const MAX_RUN_ATTEMPTS = 5;
export const MAX_DELIVERY_ATTEMPTS = 10;
const STALE_RUN_MS = 15 * 60_000;

type CadenceRow = {
  id: string;
  org_id: string;
  definition_id: string;
  cadence: "daily" | "weekly" | "monthly";
  day_of_week: number | null;
  day_of_month: number | null;
  hour: number;
  minute: number;
  timezone: string;
  recipient_emails: string[];
  filters: Record<string, unknown> | null;
  next_run_at: Date | string;
  authorization_snapshot: Record<string, unknown> | null;
};

/**
 * Atomically convert due cadence occurrences into durable report-run outbox
 * rows and advance each schedule. Concurrent scanners use SKIP LOCKED and the
 * schedule/occurrence unique key independently prevents duplicate materialization.
 */
export async function materializeDueReportRuns(now = new Date(), limit = 50): Promise<string[]> {
  return db.transaction(async (tx) => {
    const due = (await tx.execute<CadenceRow>(sql`
      select id, org_id, definition_id, cadence, day_of_week, day_of_month,
             hour, minute, timezone, recipient_emails, filters, next_run_at, authorization_snapshot
        from report_schedules
       where active and next_run_at <= ${now}
       order by next_run_at
       for update skip locked
       limit ${Math.max(1, Math.min(limit, 500))}
    `));
    const runIds: string[] = [];
    for (const schedule of due.rows) {
      const scheduledFor = new Date(schedule.next_run_at);
      const next = computeNextRunAt({
        cadence: schedule.cadence,
        dayOfWeek: schedule.day_of_week,
        dayOfMonth: schedule.day_of_month,
        hour: schedule.hour,
        minute: schedule.minute,
        timezone: schedule.timezone,
      }, scheduledFor);
      const inserted = (await tx.execute<{ id: string }>(sql`
        insert into report_runs
          (org_id, schedule_id, definition_id, trigger, status, scheduled_for,
           recipient_emails, filters, next_attempt_at, authorization_snapshot)
        values (${schedule.org_id}, ${schedule.id}, ${schedule.definition_id}, 'scheduled', 'queued',
                ${scheduledFor}, ${JSON.stringify(schedule.recipient_emails ?? [])}::jsonb,
                ${JSON.stringify(schedule.filters)}::jsonb, now(), ${JSON.stringify(schedule.authorization_snapshot)}::jsonb)
        on conflict (schedule_id, scheduled_for)
          where schedule_id is not null and scheduled_for is not null
        do nothing
        returning id
      `));
      if (inserted.rows[0]) runIds.push(inserted.rows[0].id);
      await tx.execute(sql`
        update report_schedules set next_run_at=${next}, updated_at=now()
         where id=${schedule.id} and org_id=${schedule.org_id}
      `);
    }
    return runIds;
  });
}

/** Rebuild the Redis report queue from its durable database outbox. */
export async function dispatchQueuedReportRuns(
  enqueue: typeof enqueueReportRun = enqueueReportRun,
  now = new Date(),
): Promise<number> {
  await db.execute(sql`
    update report_runs set status='queued', locked_at=null, next_attempt_at=${now}, updated_at=now()
     where trigger='scheduled' and status='running' and locked_at < ${new Date(now.getTime() - STALE_RUN_MS)}
  `);
  const rows = (await db.execute<{ id: string; org_id: string; definition_id: string; schedule_id: string; dispatch_count: number }>(sql`
    select id, org_id, definition_id, schedule_id, dispatch_count
      from report_runs
     where trigger='scheduled'
       and status in ('queued','failed')
       and attempt_count < ${MAX_RUN_ATTEMPTS}
       and coalesce(next_attempt_at, created_at) <= ${now}
     order by coalesce(next_attempt_at, created_at)
     limit 100
  `));
  let dispatched = 0;
  for (const row of rows.rows) {
    const jobId = `report-run|${row.id}|${row.dispatch_count}`;
    await enqueue(
      { runId: row.id, orgId: row.org_id, definitionId: row.definition_id, scheduleId: row.schedule_id },
      { jobId },
    );
    await db.execute(sql`
      update report_runs set dispatch_count=dispatch_count+1, updated_at=now()
       where id=${row.id} and org_id=${row.org_id} and dispatch_count=${row.dispatch_count} and status in ('queued','failed')
    `);
    dispatched++;
  }
  return dispatched;
}

export type ReportRenderer = (orgId: string, definitionId: string, runId: string) => Promise<Buffer>;

/** Render once, retain immutable bytes/hash, and create recipient outbox rows atomically. */
export async function processScheduledReportRun(runId: string, render: ReportRenderer): Promise<{ skipped?: true; deliveries?: number }> {
  const claimed = (await db.execute<{ org_id: string; definition_id: string; recipient_emails: string[]; attempt_count: number }>(sql`
    update report_runs
       set status='running', attempt_count=attempt_count+1, started_at=coalesce(started_at,now()),
           locked_at=now(), error=null, updated_at=now()
     where id=${runId} and trigger='scheduled' and status in ('queued','failed')
       and attempt_count < ${MAX_RUN_ATTEMPTS}
     returning org_id, definition_id, recipient_emails, attempt_count
  `));
  const row = claimed.rows[0];
  if (!row) {
    const complete = (await db.execute(sql`select 1 from report_run_artifacts where run_id=${runId}`));
    return complete.rows[0] ? { skipped: true } : { skipped: true };
  }

  return runInSpan(
    "report_run.process",
    {
      [ATTR_SURFACE]: "report_runs",
      [ATTR_KIND]: "scheduled_report",
      [ATTR_ORG_ID]: row.org_id,
      [ATTR_RUN_ID]: runId,
      [ATTR_DEFINITION_ID]: row.definition_id,
    },
    async () => {
      const startedAt = Date.now();
      try {
        const meta = (await db.execute<{ report_name: string }>(sql`
          select rd.name as report_name from report_definitions rd
           where rd.id=${row.definition_id} and rd.org_id=${row.org_id}
        `));
        if (!meta.rows[0]) throw new Error("scheduled report definition is unavailable");
        const pdf = await render(row.org_id, row.definition_id, runId);
        if (pdf.length === 0) throw new Error("scheduled report renderer returned an empty artifact");
        const slug = meta.rows[0].report_name.replace(/[^a-z0-9]+/gi, "-").toLowerCase().replace(/^-|-$/g, "");
        const filename = `${slug || "report"}-${await businessToday(row.org_id)}.pdf`;
        const hash = createHash("sha256").update(pdf).digest("hex");
        const recipients = [...new Set((row.recipient_emails ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean))];

        await db.transaction(async (tx) => {
          await tx.execute(sql`
            insert into report_run_artifacts
              (org_id, run_id, filename, content_type, size_bytes, content_hash, bytes)
            values (${row.org_id}, ${runId}, ${filename}, 'application/pdf', ${pdf.length}, ${hash}, ${pdf})
            on conflict (run_id) do nothing
          `);
          for (const recipient of recipients) {
            await tx.execute(sql`
              insert into report_delivery_outbox (org_id, run_id, recipient, status, next_attempt_at)
              values (${row.org_id}, ${runId}, ${recipient}, 'pending', now())
              on conflict (run_id, recipient) do nothing
            `);
          }
          await tx.execute(sql`
            update report_runs set status='succeeded', finished_at=now(), locked_at=null,
                   next_attempt_at=null, updated_at=now() where id=${runId} and org_id=${row.org_id}
          `);
        });
        recordOutboxAttempt("report_runs", "scheduled_report", "succeeded", Date.now() - startedAt);
        return { deliveries: recipients.length };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        recordOutboxAttempt("report_runs", "scheduled_report", "failed", Date.now() - startedAt);
        // attempt_count was incremented by this run's claim, so it is the ordinal
        // of the attempt that just failed; reaching the ceiling here is the one
        // and only transition to terminal.
        const terminal = row.attempt_count >= MAX_RUN_ATTEMPTS;
        const failedAt = new Date();
        const delay = Math.min(60 * 60_000, 60_000 * 2 ** Math.max(0, row.attempt_count - 1));
        const marked = (await db.execute<{ becameTerminal: boolean }>(sql`
          update report_runs set status='failed', error=${message.slice(0, 1000)}, finished_at=${failedAt},
                 locked_at=null, next_attempt_at=${new Date(failedAt.getTime() + delay)},
                 terminal_failed_at = case when ${terminal}
                                          then coalesce(terminal_failed_at, ${failedAt})
                                          else terminal_failed_at end,
                 terminal_failed_by = case when ${terminal} and terminal_failed_at is null
                                          then ${REPORT_RUN_WORKER_IDENTITY}
                                          else terminal_failed_by end,
                 updated_at=${failedAt}
           where id=${runId} and org_id=${row.org_id}
           returning (${terminal}
                     and terminal_failed_by = ${REPORT_RUN_WORKER_IDENTITY}
                     and terminal_failed_at = ${failedAt}) as "becameTerminal"
        `));
        if (marked.rows[0]?.becameTerminal) {
          logTerminalFailure({
            surface: "report_runs",
            id: runId,
            orgId: row.org_id,
            attempts: row.attempt_count,
            error: message.slice(0, 1000),
            markedBy: REPORT_RUN_WORKER_IDENTITY,
            at: failedAt,
          });
        }
        throw error;
      }
    },
  );
}

/** Dispatch per-recipient outbox rows; deterministic generation ids close the DB/Redis crash gap. */
export async function dispatchReportDeliveries(
  enqueue: (data: EnqueueEmailData, options?: { jobId?: string }) => Promise<unknown> = enqueueEmail,
  now = new Date(),
): Promise<number> {
  const due = (await db.execute<{
    id: string; org_id: string; run_id: string; recipient: string; dispatch_count: number;
    filename: string; content_type: string; bytes: Buffer; report_name: string; org_name: string;
  }>(sql`
    select d.id, d.org_id, d.run_id, d.recipient, d.dispatch_count,
           a.filename, a.content_type, a.bytes, rd.name as report_name, o.name as org_name
      from report_delivery_outbox d
      join report_runs r on r.id=d.run_id and r.org_id=d.org_id
      join report_run_artifacts a on a.run_id=r.id and a.org_id=r.org_id
      join report_definitions rd on rd.id=r.definition_id and rd.org_id=r.org_id
      join orgs o on o.id=r.org_id
     where d.status in ('pending','failed') and d.next_attempt_at <= ${now}
       and d.attempt_count < ${MAX_DELIVERY_ATTEMPTS}
     order by d.next_attempt_at
     limit 100
  `));
  let dispatched = 0;
  for (const row of due.rows) {
    const mail = scheduledReportEmail({ orgName: row.org_name, reportName: row.report_name, attachmentName: row.filename });
    const jobId = `report-delivery|${row.id}|${row.dispatch_count}`;
    await enqueue({
      orgId: row.org_id,
      to: row.recipient,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      attachments: [{ filename: row.filename, content: Buffer.from(row.bytes).toString("base64"), contentType: row.content_type }],
      meta: { category: "report", reportRunId: row.run_id, reportDeliveryId: row.id },
    }, { jobId });
    await db.execute(sql`
      update report_delivery_outbox set status='enqueued', dispatch_count=dispatch_count+1,
             queue_job_id=${jobId}, error=null, updated_at=now()
       where id=${row.id} and org_id=${row.org_id} and status in ('pending','failed') and dispatch_count=${row.dispatch_count}
    `);
    dispatched++;
  }
  return dispatched;
}

export async function markReportDeliveryStarted(orgId: string, deliveryId: string, jobId: string | null): Promise<void> {
  await db.execute(sql`
    update report_delivery_outbox set status='sending', attempt_count=attempt_count+1,
           last_attempt_at=now(), queue_job_id=coalesce(${jobId},queue_job_id), updated_at=now()
     where id=${deliveryId} and org_id=${orgId} and status in ('enqueued','sending')
  `);
}

// Only 'sending' (the state markReportDeliveryStarted set) may complete as
// 'sent'; a stale retry/racing callback must not rewrite an enqueued, failed
// or already-sent row into a second recorded send.
export async function markReportDeliverySent(orgId: string, deliveryId: string, emailLogId: string, providerMessageId: string): Promise<void> {
  await db.execute(sql`
    update report_delivery_outbox set status='sent', email_log_id=${emailLogId}, provider_message_id=${providerMessageId},
           sent_at=now(), error=null, updated_at=now() where id=${deliveryId} and org_id=${orgId} and status='sending'
  `);
}

// Only a delivery that has not recorded a send may become 'suppressed'; a
// stale retry/racing callback must not rewrite an already-sent row into a
// suppression, erasing the evidence that the report email was delivered.
export async function markReportDeliverySuppressed(orgId: string, deliveryId: string, emailLogId: string, reason: string): Promise<void> {
  await db.execute(sql`
    update report_delivery_outbox set status='suppressed', email_log_id=${emailLogId}, error=${reason.slice(0, 1000)},
           updated_at=now() where id=${deliveryId} and org_id=${orgId}
             and status = any(array['pending','enqueued','sending','failed'])
  `);
}

export async function markReportDeliveryFailed(
  orgId: string,
  deliveryId: string,
  emailLogId: string,
  error: string,
  finalQueueAttempt: boolean,
): Promise<void> {
  // Only the sending attempt that owns this callback may record a failure.
  // A delayed callback must not rewrite a row already completed as sent (or
  // otherwise moved on by a newer lifecycle transition).
  // A queue giveup only strands the row forever once attempt_count has also
  // reached the delivery ceiling — until then the scanner re-enqueues failed
  // rows. That conjunction is the one and only terminal transition, so stamp
  // and log it in the same statement that records the failure.
  const failedAt = new Date();
  const marked = (await db.execute<{
    becameTerminal: boolean;
    attempts: number;
  }>(sql`
    update report_delivery_outbox set status=${finalQueueAttempt ? "failed" : "enqueued"}, email_log_id=${emailLogId},
           error=${error.slice(0, 1000)}, next_attempt_at=${new Date(failedAt.getTime() + 5 * 60_000)},
           terminal_failed_at = case when ${finalQueueAttempt} and attempt_count >= ${MAX_DELIVERY_ATTEMPTS}
                                     then coalesce(terminal_failed_at, ${failedAt})
                                     else terminal_failed_at end,
           terminal_failed_by = case when ${finalQueueAttempt} and attempt_count >= ${MAX_DELIVERY_ATTEMPTS}
                                      and terminal_failed_at is null
                                     then ${EMAIL_DELIVERY_WORKER_IDENTITY}
                                     else terminal_failed_by end,
           updated_at=${failedAt}
     where id=${deliveryId} and org_id=${orgId} and status='sending'
     returning attempt_count as "attempts",
               (attempt_count >= ${MAX_DELIVERY_ATTEMPTS}
                and terminal_failed_by = ${EMAIL_DELIVERY_WORKER_IDENTITY}
                and terminal_failed_at = ${failedAt}) as "becameTerminal"
  `));
  const row = marked.rows[0];
  if (row?.becameTerminal) {
    logTerminalFailure({
      surface: "report_delivery_outbox",
      id: deliveryId,
      orgId,
      attempts: row.attempts,
      error: error.slice(0, 1000),
      markedBy: EMAIL_DELIVERY_WORKER_IDENTITY,
      at: failedAt,
    });
  }
}
