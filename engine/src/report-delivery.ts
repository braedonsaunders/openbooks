import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { computeNextRunAt } from "@openbooks/reports";
import { enqueueEmail, enqueueReportRun, type EnqueueEmailData } from "@openbooks/jobs";
import { scheduledReportEmail } from "@openbooks/emails";
import { db } from "./db.ts";

const MAX_RUN_ATTEMPTS = 5;
const MAX_DELIVERY_ATTEMPTS = 10;
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
             hour, minute, timezone, recipient_emails, filters, next_run_at
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
           recipient_emails, filters, next_attempt_at)
        values (${schedule.org_id}, ${schedule.id}, ${schedule.definition_id}, 'scheduled', 'queued',
                ${scheduledFor}, ${JSON.stringify(schedule.recipient_emails ?? [])}::jsonb,
                ${JSON.stringify(schedule.filters)}::jsonb, now())
        on conflict (schedule_id, scheduled_for)
          where schedule_id is not null and scheduled_for is not null
        do nothing
        returning id
      `));
      if (inserted.rows[0]) runIds.push(inserted.rows[0].id);
      await tx.execute(sql`
        update report_schedules set next_run_at=${next}, updated_at=now()
         where id=${schedule.id}
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
       where id=${row.id} and dispatch_count=${row.dispatch_count} and status in ('queued','failed')
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

  try {
    const meta = (await db.execute<{ report_name: string }>(sql`
      select rd.name as report_name from report_definitions rd
       where rd.id=${row.definition_id} and rd.org_id=${row.org_id}
    `));
    if (!meta.rows[0]) throw new Error("scheduled report definition is unavailable");
    const pdf = await render(row.org_id, row.definition_id, runId);
    if (pdf.length === 0) throw new Error("scheduled report renderer returned an empty artifact");
    const slug = meta.rows[0].report_name.replace(/[^a-z0-9]+/gi, "-").toLowerCase().replace(/^-|-$/g, "");
    const filename = `${slug || "report"}-${new Date().toISOString().slice(0, 10)}.pdf`;
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
               next_attempt_at=null, updated_at=now() where id=${runId}
      `);
    });
    return { deliveries: recipients.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const delay = Math.min(60 * 60_000, 60_000 * 2 ** Math.max(0, row.attempt_count - 1));
    await db.execute(sql`
      update report_runs set status='failed', error=${message.slice(0, 1000)}, finished_at=now(),
             locked_at=null, next_attempt_at=${new Date(Date.now() + delay)}, updated_at=now()
       where id=${runId}
    `);
    throw error;
  }
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
       where id=${row.id} and status in ('pending','failed') and dispatch_count=${row.dispatch_count}
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

export async function markReportDeliverySent(orgId: string, deliveryId: string, emailLogId: string, providerMessageId: string): Promise<void> {
  await db.execute(sql`
    update report_delivery_outbox set status='sent', email_log_id=${emailLogId}, provider_message_id=${providerMessageId},
           sent_at=now(), error=null, updated_at=now() where id=${deliveryId} and org_id=${orgId}
  `);
}

export async function markReportDeliverySuppressed(orgId: string, deliveryId: string, emailLogId: string, reason: string): Promise<void> {
  await db.execute(sql`
    update report_delivery_outbox set status='suppressed', email_log_id=${emailLogId}, error=${reason.slice(0, 1000)},
           updated_at=now() where id=${deliveryId} and org_id=${orgId}
  `);
}

export async function markReportDeliveryFailed(
  orgId: string,
  deliveryId: string,
  emailLogId: string,
  error: string,
  finalQueueAttempt: boolean,
): Promise<void> {
  await db.execute(sql`
    update report_delivery_outbox set status=${finalQueueAttempt ? "failed" : "enqueued"}, email_log_id=${emailLogId},
           error=${error.slice(0, 1000)}, next_attempt_at=${new Date(Date.now() + 5 * 60_000)}, updated_at=now()
     where id=${deliveryId} and org_id=${orgId}
  `);
}
