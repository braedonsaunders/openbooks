import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import {
  dispatchQueuedReportRuns,
  dispatchReportDeliveries,
  markReportDeliverySent,
  markReportDeliveryStarted,
  materializeDueReportRuns,
  processScheduledReportRun,
} from "./report-delivery.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "./test-fixtures.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

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
    const runs = (await db.execute(sql`
      select id, status, scheduled_for, recipient_emails, filters, attempt_count
        from report_runs where schedule_id=${scheduleId}
    `)) as unknown as { rows: { id: string; status: string; scheduled_for: Date; recipient_emails: string[]; filters: Record<string, unknown>; attempt_count: number }[] };
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
    const afterQueueFailure = (await db.execute(sql`
      select status, dispatch_count from report_runs where id=${runs.rows[0]!.id}
    `)) as unknown as { rows: { status: string; dispatch_count: number }[] };
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
    const evidence = (await db.execute(sql`
      select r.status, r.attempt_count, a.size_bytes, a.content_hash, a.bytes,
             count(d.id)::int as deliveries
        from report_runs r
        join report_run_artifacts a on a.run_id=r.id
        left join report_delivery_outbox d on d.run_id=r.id
       where r.id=${runs.rows[0]!.id}
       group by r.id, a.id
    `)) as unknown as { rows: { status: string; attempt_count: number; size_bytes: number; content_hash: string; bytes: Buffer; deliveries: number }[] };
    assert.deepEqual(
      { status: evidence.rows[0]!.status, attempts: evidence.rows[0]!.attempt_count, size: evidence.rows[0]!.size_bytes, deliveries: evidence.rows[0]!.deliveries },
      { status: "succeeded", attempts: 1, size: pdf.length, deliveries: 2 },
    );
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

    const delivery = (await db.execute(sql`
      select id from report_delivery_outbox where run_id=${runs.rows[0]!.id} order by recipient limit 1
    `)) as unknown as { rows: { id: string }[] };
    const log = (await db.execute(sql`
      insert into email_log (org_id, recipients, recipient_primary, subject, status, category_key)
      values (${org.orgId}, '["audit@example.com"]'::jsonb, 'audit@example.com', 'Delivery contract', 'sent', 'report')
      returning id
    `)) as unknown as { rows: { id: string }[] };
    await markReportDeliveryStarted(org.orgId, delivery.rows[0]!.id, "contract-job");
    await markReportDeliverySent(org.orgId, delivery.rows[0]!.id, log.rows[0]!.id, "provider-123");
    const sent = (await db.execute(sql`
      select status, attempt_count, email_log_id, provider_message_id, sent_at is not null as has_sent_at
        from report_delivery_outbox where id=${delivery.rows[0]!.id}
    `)) as unknown as { rows: Record<string, unknown>[] };
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
    const failed = (await db.execute(sql`
      select r.status, r.attempt_count,
             exists(select 1 from report_run_artifacts a where a.run_id=r.id) as has_artifact,
             exists(select 1 from report_delivery_outbox d where d.run_id=r.id) as has_delivery
        from report_runs r where r.id=${retryRunId}
    `)) as unknown as { rows: Record<string, unknown>[] };
    assert.deepEqual(failed.rows[0], { status: "failed", attempt_count: 1, has_artifact: false, has_delivery: false });
    await processScheduledReportRun(retryRunId, async () => pdf);
    const retried = (await db.execute(sql`
      select r.status, r.attempt_count, count(a.id)::int as artifacts, count(d.id)::int as deliveries
        from report_runs r left join report_run_artifacts a on a.run_id=r.id
        left join report_delivery_outbox d on d.run_id=r.id
       where r.id=${retryRunId} group by r.id
    `)) as unknown as { rows: Record<string, unknown>[] };
    assert.deepEqual(retried.rows[0], { status: "succeeded", attempt_count: 2, artifacts: 1, deliveries: 1 });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
