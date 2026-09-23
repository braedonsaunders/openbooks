import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { computeNextRunAt } from "@openbooks/reports";
import { enqueueEmail, enqueueReportRun, type EnqueueEmailData } from "@openbooks/jobs";
import { deriveEmailDeliveryKey, isValidEmailAddress, scheduledReportEmail } from "@openbooks/emails";
import { storeEmailAttachments } from "./email-attachments.ts";
import { getEmailQueue } from "@openbooks/jobs";
import { businessToday } from "../platform/business-date.ts";
import { db } from "../platform/db.ts";
import {
  EMAIL_DELIVERY_WORKER_IDENTITY,
  logTerminalFailure,
  REPORT_RUN_WORKER_IDENTITY,
} from "../platform/terminal-failure.ts";
import {
  ATTR_DEFINITION_ID,
  ATTR_KIND,
  ATTR_ORG_ID,
  ATTR_RUN_ID,
  ATTR_SURFACE,
  recordOutboxAttempt,
  runInSpan,
} from "../platform/telemetry.ts";

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
  // The claim below is a lease: locked_at names this renderer's ownership and
  // the stale-run sweep (dispatchQueuedReportRuns) may reassign it after
  // STALE_RUN_MS. Every terminal write below is conditional on still holding
  // that lease — a renderer whose lease was stolen stands down instead of
  // letting a late failure overwrite another renderer's success.
  const claimed = (await db.execute<{ org_id: string; definition_id: string; recipient_emails: string[]; attempt_count: number; locked_at: Date | string }>(sql`
    update report_runs
       set status='running', attempt_count=attempt_count+1, started_at=coalesce(started_at,now()),
           locked_at=now(), error=null, updated_at=now()
     where id=${runId} and trigger='scheduled' and status in ('queued','failed')
       and attempt_count < ${MAX_RUN_ATTEMPTS}
     returning org_id, definition_id, recipient_emails, attempt_count, locked_at
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

        // The artifact and delivery inserts are idempotent (conflict no-ops),
        // so a superseded renderer's transaction is harmless — but only the
        // lease holder's status write may land. A stolen lease (locked_at no
        // longer ours) means the sweep reassigned this run; stand down and
        // let the current owner drive it to terminal.
        const completed = await db.transaction(async (tx) => {
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
          const stamped = (await tx.execute<{ id: string }>(sql`
            update report_runs set status='succeeded', finished_at=now(), locked_at=null,
                   next_attempt_at=null, updated_at=now()
             where id=${runId} and org_id=${row.org_id}
               and status='running' and locked_at=${row.locked_at}
             returning id
          `));
          return stamped.rows.length > 0;
        });
        if (!completed) return { skipped: true };
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
        // Conditional on the lease for the same reason as the success path:
        // a late failure from a superseded renderer must not overwrite the
        // current owner's outcome (in particular, another renderer's success).
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
             and status='running' and locked_at=${row.locked_at}
           returning (${terminal}
                     and terminal_failed_by = ${REPORT_RUN_WORKER_IDENTITY}
                     and terminal_failed_at = ${failedAt}) as "becameTerminal"
        `));
        // No row: the lease moved on (stale sweep reassigned or another
        // renderer finished). The current owner drives the outcome; this
        // render's failure is stale evidence, not a new failure.
        if (!marked.rows[0]) return { skipped: true };
        if (marked.rows[0].becameTerminal) {
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

/**
 * Quarantine an outbox row whose recipient can never be dispatched. Schedule
 * writes accept a looser address shape than the provider validation the queue
 * enforces, so such an address reaches this scan through the front door — and
 * without this guard its enqueue throw aborts the whole scan ahead of every
 * healthy row behind it, every tick, forever. A malformed address never heals,
 * so the row goes straight to the delivery ceiling with the same terminal
 * stamp + structured log a poison row earns through the attempt path, and the
 * scan moves on. Other enqueue failures (Redis down, oversized artifact) still
 * throw: those are transient and must retry, never quarantine.
 */
async function quarantineUndeliverableReportDelivery(
  row: { id: string; org_id: string; recipient: string },
  now: Date,
): Promise<void> {
  const reason = `invalid recipient email address: ${row.recipient}`.slice(0, 1000);
  const marked = (await db.execute<{ becameTerminal: boolean }>(sql`
    update report_delivery_outbox set status='failed', error=${reason},
           attempt_count=${MAX_DELIVERY_ATTEMPTS}, next_attempt_at=${now},
           terminal_failed_at = coalesce(terminal_failed_at, ${now}),
           terminal_failed_by = case when terminal_failed_at is null
                                      then ${EMAIL_DELIVERY_WORKER_IDENTITY}
                                      else terminal_failed_by end,
           updated_at=${now}
     where id=${row.id} and org_id=${row.org_id} and status in ('pending','failed')
     returning (terminal_failed_by = ${EMAIL_DELIVERY_WORKER_IDENTITY}
                and terminal_failed_at = ${now}) as "becameTerminal"
  `));
  if (marked.rows[0]?.becameTerminal) {
    logTerminalFailure({
      surface: "report_delivery_outbox",
      id: row.id,
      orgId: row.org_id,
      attempts: MAX_DELIVERY_ATTEMPTS,
      error: reason,
      markedBy: EMAIL_DELIVERY_WORKER_IDENTITY,
      at: now,
    });
  }
}

/**
 * Stuck-'enqueued' rebuild horizon. A dispatch marks the row 'enqueued' and
 * hands the email queue a deterministic job; the row only advances when that
 * job's worker reports back. Worst-case legitimate processing (five queue
 * attempts on exponential backoff) finishes well inside fifteen minutes, so
 * a row still 'enqueued' past it lost its email job to a worker crash or a
 * Redis loss — and the dispatch scan below only takes pending/failed rows,
 * so without this sweep the delivery is silently lost.
 */
const STUCK_ENQUEUED_REBUILD_MINUTES = 15;
/**
 * A claimed-but-undecided email send younger than this may still be in
 * flight; rebuilding it now would risk a duplicate.
 */
const REBUILD_LIVE_ACTIVITY_MINUTES = 5;

/**
 * Crash-rebuild sweep for deliveries stuck 'enqueued'. For each stuck row:
 * a recorded provider acceptance reconciles the row to 'sent' (resending
 * would duplicate); a live attempt is left alone; otherwise the orphaned
 * queue job is removed best-effort by its deterministic id and the row goes
 * back to 'failed' so the normal scan redispatches it with a new
 * generation. The canonical email log is keyed per delivery independent of
 * generation, so even a surviving orphan converges to a single send — and
 * per-row isolation keeps one bad row from stalling the sweep.
 */
async function rebuildStuckEnqueuedDeliveries(now: Date): Promise<number> {
  const horizon = new Date(now.getTime() - STUCK_ENQUEUED_REBUILD_MINUTES * 60_000);
  const liveAfter = new Date(now.getTime() - REBUILD_LIVE_ACTIVITY_MINUTES * 60_000);
  const stale = (await db.execute<{
    id: string; org_id: string; recipient: string; dispatch_count: number; queue_job_id: string | null;
  }>(sql`
    select d.id, d.org_id, d.recipient, d.dispatch_count, d.queue_job_id
      from report_delivery_outbox d
     where d.status = 'enqueued' and d.next_attempt_at < ${horizon}
       and d.terminal_failed_at is null
     order by d.next_attempt_at
     limit 100
  `));
  let rebuilt = 0;
  for (const row of stale.rows) {
    try {
      const deliveryKey = deriveEmailDeliveryKey({ orgId: row.org_id, scope: `report:${row.id}`, to: row.recipient });
      const log = (await db.execute<{ id: string; status: string; provider_message_id: string | null; updated_at: string | Date }>(sql`
        select id, status, provider_message_id, updated_at from email_log
         where org_id = ${row.org_id} and delivery_key = ${deliveryKey}
         order by updated_at desc
         limit 5
      `));
      const sent = log.rows.find((entry) => entry.status === "sent");
      if (sent) {
        await markReportDeliverySent(row.org_id, row.id, sent.id, sent.provider_message_id ?? "unknown");
        continue;
      }
      // The driver returns timestamptz as a string; compare as Dates (a raw
      // string >= Date comparison is always false and would rebuild live rows).
      if (log.rows.some((entry) => (entry.status === "queued" || entry.status === "sending") && new Date(entry.updated_at) >= liveAfter)) {
        continue;
      }
      try {
        const queue = getEmailQueue();
        const candidates = new Set(
          [row.queue_job_id, `report-delivery|${row.id}|${row.dispatch_count - 1}`].filter((id): id is string => typeof id === "string" && id.length > 0),
        );
        for (const jobId of candidates) {
          await queue.remove(jobId);
        }
      } catch {
        // Redis down: the redispatch below fails too and retries — never a duplicate.
      }
      await db.execute(sql`
        update report_delivery_outbox set status='failed',
               error='delivery job lost before send; rebuilt for redispatch',
               next_attempt_at=${now}, updated_at=${now}
         where id=${row.id} and org_id=${row.org_id} and status='enqueued'
      `);
      rebuilt++;
    } catch (error) {
      console.error(`[reports] rebuild of stuck delivery ${row.id} failed:`, error);
    }
  }
  return rebuilt;
}

/**
 * Crash-recovery sweep for deliveries stuck 'sending'. `markReportDeliveryStarted`
 * moves a row to 'sending' when its email job starts, but the dispatch scan
 * below only takes 'pending'/'failed' rows — so a worker crash between the
 * mark and the send strands the delivery forever. A 'sending' row whose claim
 * timestamp (updated_at) is past the stuck horizon lost its worker: a recorded
 * provider acceptance reconciles it to 'sent' (resending would duplicate); a
 * live attempt is left alone; otherwise the orphaned queue job is removed
 * best-effort and the row goes back to 'failed' for redispatch. Redispatch is
 * idempotent against the email delivery key — the email worker resolves every
 * generation of this delivery to the same canonical email_log row
 * (`report:<deliveryId>`), so a surviving orphan converges to a single send.
 */
async function recoverStuckSendingDeliveries(now: Date): Promise<number> {
  const horizon = new Date(now.getTime() - STUCK_ENQUEUED_REBUILD_MINUTES * 60_000);
  const liveAfter = new Date(now.getTime() - REBUILD_LIVE_ACTIVITY_MINUTES * 60_000);
  const stale = (await db.execute<{
    id: string; org_id: string; recipient: string; dispatch_count: number; queue_job_id: string | null;
  }>(sql`
    select d.id, d.org_id, d.recipient, d.dispatch_count, d.queue_job_id
      from report_delivery_outbox d
     where d.status = 'sending' and d.updated_at < ${horizon}
       and d.terminal_failed_at is null
     order by d.updated_at
     limit 100
  `));
  let recovered = 0;
  for (const row of stale.rows) {
    try {
      const deliveryKey = deriveEmailDeliveryKey({ orgId: row.org_id, scope: `report:${row.id}`, to: row.recipient });
      const log = (await db.execute<{ id: string; status: string; provider_message_id: string | null; updated_at: string | Date }>(sql`
        select id, status, provider_message_id, updated_at from email_log
         where org_id = ${row.org_id} and delivery_key = ${deliveryKey}
         order by updated_at desc
         limit 5
      `));
      const sent = log.rows.find((entry) => entry.status === "sent");
      if (sent) {
        await markReportDeliverySent(row.org_id, row.id, sent.id, sent.provider_message_id ?? "unknown");
        continue;
      }
      // The driver returns timestamptz as a string; compare as Dates (a raw
      // string >= Date comparison is always false and would recover live rows).
      if (log.rows.some((entry) => (entry.status === "queued" || entry.status === "sending") && new Date(entry.updated_at) >= liveAfter)) {
        continue;
      }
      try {
        const queue = getEmailQueue();
        const candidates = new Set(
          [row.queue_job_id, `report-delivery|${row.id}|${row.dispatch_count - 1}`].filter((id): id is string => typeof id === "string" && id.length > 0),
        );
        for (const jobId of candidates) {
          await queue.remove(jobId);
        }
      } catch {
        // Redis down: the redispatch below fails too and retries — never a duplicate.
      }
      const moved = (await db.execute<{ id: string }>(sql`
        update report_delivery_outbox set status='failed',
               error='delivery worker lost while sending; rebuilt for redispatch',
               next_attempt_at=${now}, updated_at=${now}
         where id=${row.id} and org_id=${row.org_id} and status='sending'
         returning id
      `));
      if (moved.rows[0]) recovered++;
    } catch (error) {
      console.error(`[reports] recovery of stuck sending delivery ${row.id} failed:`, error);
    }
  }
  return recovered;
}

/** Dispatch per-recipient outbox rows; deterministic generation ids close the DB/Redis crash gap. */
export async function dispatchReportDeliveries(
  enqueue: (data: EnqueueEmailData, options: { jobId: string }) => Promise<unknown> = enqueueEmail,
  now = new Date(),
): Promise<number> {
  // Crash-rebuild first: deliveries whose email job died after the 'enqueued'
  // mark — or after the 'sending' mark — would otherwise sit outside the
  // pending/failed scan forever.
  await rebuildStuckEnqueuedDeliveries(now);
  await recoverStuckSendingDeliveries(now);
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
    if (!isValidEmailAddress(row.recipient)) {
      await quarantineUndeliverableReportDelivery(row, now);
      continue;
    }
    const mail = scheduledReportEmail({ orgName: row.org_name, reportName: row.report_name, attachmentName: row.filename });
    const jobId = `report-delivery|${row.id}|${row.dispatch_count}`;
    // Stage the rendered bytes outside the queue payload: the worker fetches
    // them at send time instead of Redis holding file contents for days.
    const attachments = await storeEmailAttachments([
      { filename: row.filename, content: Buffer.from(row.bytes).toString("base64"), contentType: row.content_type },
    ]);
    await enqueue({
      orgId: row.org_id,
      to: row.recipient,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      attachments,
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

// Only a dispatched row ('sending', or 'enqueued' when the rebuild sweep
// reconciles a recorded provider acceptance after a crash) may complete as
// 'sent'; a stale retry/racing callback must not rewrite a failed or
// already-sent row into a second recorded send.
export async function markReportDeliverySent(orgId: string, deliveryId: string, emailLogId: string, providerMessageId: string): Promise<void> {
  await db.execute(sql`
    update report_delivery_outbox set status='sent', email_log_id=${emailLogId}, provider_message_id=${providerMessageId},
           sent_at=now(), error=null, updated_at=now() where id=${deliveryId} and org_id=${orgId} and status in ('sending','enqueued')
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
