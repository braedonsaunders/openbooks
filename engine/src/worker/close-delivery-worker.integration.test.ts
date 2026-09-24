import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { startCloseRun } from "../close/run-start.ts";
import { db } from "../platform/db.ts";
import { processCloseDeliveryJobData } from "./close-delivery-worker.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

async function seedPackage(orgId: string, recipients: unknown): Promise<{ packageId: string; periodId: string; bookId: string }> {
  const period = (await db.execute<{ id: string }>(sql`
    select id from accounting_periods where org_id = ${orgId} order by starts_on limit 1
  `)).rows[0]!;
  const book = (await db.execute<{ id: string }>(sql`
    select id from accounting_books where org_id = ${orgId} limit 1
  `)).rows[0]!;
  assert.ok(period?.id && book?.id, "scratch org must carry a period and a book");
  const packageId = randomUUID();
  await db.execute(sql`
    insert into close_reporting_packages (id, org_id, name, reports, recipients, delivery)
    values (${packageId}, ${orgId}, 'recipient contract',
            '[{"slug":"no-such-report"}]'::jsonb, ${JSON.stringify(recipients)}::jsonb, '{}'::jsonb)
  `);
  return { packageId, periodId: period.id, bookId: book.id };
}

test("close delivery refuses a malformed recipient before any render work", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const { packageId, periodId, bookId } = await seedPackage(org.orgId, ["not-an-email"]);
    // The bogus slug guarantees the pre-fix code reaches the render phase
    // (and dies there) instead of tripping over anything else first.
    await assert.rejects(
      processCloseDeliveryJobData({ orgId: org.orgId, packageId, periodId, bookId }),
      /invalid recipient/,
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function seedReportablePackage(orgId: string, senderId: string, delivery = "{}"): Promise<{
  packageId: string; definitionId: string; runId: string; periodId: string; bookId: string;
}> {
  const definitionId = randomUUID();
  await db.execute(sql`
    insert into report_definitions (id, org_id, kind, report_type, slug, name, query, statement, created_by)
    values (${definitionId}, ${orgId}, 'custom', 'query', 'close-probe', 'Close probe',
            '{"entity":"trial_balance","columns":["account"]}'::jsonb, null, ${senderId})`);
  const packageId = randomUUID();
  await db.execute(sql`
    insert into close_reporting_packages (id, org_id, name, reports, recipients, delivery, created_by)
    values (${packageId}, ${orgId}, 'close probe package', '[{"slug":"close-probe"}]'::jsonb,
            '["ops@scratch.test"]'::jsonb, ${delivery}::jsonb, ${senderId})`);
  const period = (await db.execute<{ id: string }>(sql`
    select id from accounting_periods where org_id = ${orgId} order by starts_on limit 1
  `)).rows[0]!;
  const book = (await db.execute<{ id: string }>(sql`
    select id from accounting_books where org_id = ${orgId} limit 1
  `)).rows[0]!;
  assert.ok(period?.id && book?.id, "scratch org must carry a period and a book");
  const runId = await startCloseRun({
    orgId, periodId: period.id, bookId: book.id, actorId: senderId, reportingPackageId: packageId,
  });
  await db.execute(sql`
    update close_runs set status = 'closed', reporting_package_id = ${packageId}
     where id = ${runId} and org_id = ${orgId}`);
  return { packageId, definitionId, runId, periodId: period.id, bookId: book.id };
}

test("close package renders through a minted report run and delivers", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const sender = await createScratchUser(org.orgId, "Sender", "sender");
    const { packageId, definitionId, runId } = await seedReportablePackage(org.orgId, sender);
    // The renderer and the mail queue are injected: no app server or Redis
    // in this partition. The worker must still drive the real path —
    // context, run minting, staging, enqueue, delivered event.
    const renderedParams: Array<Record<string, string>> = [];
    const enqueued: Array<{ data: unknown; options: unknown }> = [];
    const result = await processCloseDeliveryJobData(
      { orgId: org.orgId, packageId, runId, senderId: sender },
      {
        renderReport: async (renderOrgId, renderDefinitionId, params) => {
          assert.equal(renderOrgId, org.orgId);
          assert.equal(renderDefinitionId, definitionId);
          renderedParams.push(params);
          return Buffer.from("%PDF-1.4 close-probe\n%%EOF");
        },
        enqueueEmail: async (data, options) => {
          enqueued.push({ data, options });
          return [{ id: "email-job-1" }];
        },
      },
    ) as { reports: number; files: number; recipients: number };
    assert.equal(result.reports, 1);
    assert.equal(result.files, 1);
    assert.equal(result.recipients, 1);

    // The render rode a durable close-package run, not a bare definition.
    assert.equal(renderedParams.length, 1);
    const reportRunId = renderedParams[0]!.runId;
    assert.match(reportRunId ?? "", UUID_RE, "the render must carry its report run id");
    const runs = (await db.execute<{
      trigger: string; status: string; definition_id: string;
      snapshotUser: string | null; closePackageId: string | null; closeRunId: string | null;
    }>(sql`
      select trigger, status, definition_id::text as definition_id,
             authorization_snapshot->>'userId' as "snapshotUser",
             filters->'closePackage'->>'packageId' as "closePackageId",
             filters->'closePackage'->>'runId' as "closeRunId"
        from report_runs where id = ${reportRunId} and org_id = ${org.orgId}`)).rows;
    assert.equal(runs.length, 1, "the render must mint its run row");
    assert.equal(runs[0]!.trigger, "close-package");
    assert.equal(runs[0]!.status, "succeeded");
    assert.equal(runs[0]!.definition_id, definitionId);
    assert.equal(runs[0]!.snapshotUser, sender);
    assert.equal(runs[0]!.closePackageId, packageId);
    assert.equal(runs[0]!.closeRunId, runId);

    // The bundle was handed to mail and the delivery recorded.
    assert.equal(enqueued.length, 1);
    assert.deepEqual((enqueued[0]!.data as { to: string[] }).to, ["ops@scratch.test"]);
    const events = (await db.execute<{ event_type: string; payload: unknown }>(sql`
      select event_type, payload from close_events
       where org_id = ${org.orgId} and run_id = ${runId} and event_type = 'package.delivered'`)).rows;
    assert.equal(events.length, 1, "delivery must record its event");
    assert.equal((events[0]!.payload as { reports: number }).reports, 1);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("close delivery without a sender falls back to the package author", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const author = await createScratchUser(org.orgId, "Author", "author");
    const { packageId, runId } = await seedReportablePackage(org.orgId, author);
    const seen: Array<Record<string, string>> = [];
    await processCloseDeliveryJobData(
      // No senderId: a job enqueued before the principal travelled.
      { orgId: org.orgId, packageId, runId },
      {
        renderReport: async (_orgId, _definitionId, params) => {
          seen.push(params);
          return Buffer.from("%PDF-1.4 close-probe\n%%EOF");
        },
        enqueueEmail: async () => [{ id: "email-job-1" }],
      },
    );
    const reportRunId = seen[0]!.runId ?? "";
    assert.match(reportRunId, UUID_RE);
    const rows = (await db.execute<{ snapshotUser: string | null }>(sql`
      select authorization_snapshot->>'userId' as "snapshotUser"
        from report_runs where id = ${reportRunId} and org_id = ${org.orgId}`)).rows;
    assert.equal(rows[0]?.snapshotUser, author);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("an enqueue failure records no delivery and fails the job (provable non-acceptance)", { skip: !DB }, async () => {
  // C-51: a throw at enqueueEmail is a failure, never a success. With the
  // queue reachable and the job provably absent, the settlement drops the
  // attempt's staged refs and rethrows — the worker must not record
  // package.delivered and must fail so BullMQ retries.
  const org = await createScratchOrg();
  try {
    const sender = await createScratchUser(org.orgId, "Sender", "sender");
    const { packageId, runId } = await seedReportablePackage(org.orgId, sender);
    await assert.rejects(
      processCloseDeliveryJobData(
        { orgId: org.orgId, packageId, runId, senderId: sender },
        {
          renderReport: async () => Buffer.from("%PDF-1.4 close-probe\n%%EOF"),
          enqueueEmail: async () => {
            throw new Error("redis outage at add");
          },
          probeQueuedJob: async () => null,
        },
      ),
      /redis outage at add/,
    );
    const delivered = (await db.execute<{ id: string }>(sql`
      select id from close_events
       where org_id = ${org.orgId} and run_id = ${runId} and event_type = 'package.delivered'`)).rows;
    assert.equal(delivered.length, 0, "a failed handoff must never read as delivered");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("an enqueue failure with an unreachable queue records no delivery and fails the job", { skip: !DB }, async () => {
  // Companion case: the queue cannot even be probed (outage), so the
  // settlement keeps the staged refs and rethrows — same worker outcome.
  const org = await createScratchOrg();
  try {
    const sender = await createScratchUser(org.orgId, "Sender", "sender");
    const { packageId, runId } = await seedReportablePackage(org.orgId, sender);
    await assert.rejects(
      processCloseDeliveryJobData(
        { orgId: org.orgId, packageId, runId, senderId: sender },
        {
          renderReport: async () => Buffer.from("%PDF-1.4 close-probe\n%%EOF"),
          enqueueEmail: async () => {
            throw new Error("redis outage at add");
          },
          probeQueuedJob: async () => {
            throw new Error("redis outage at probe");
          },
        },
      ),
      /redis outage at add/,
    );
    const delivered = (await db.execute<{ id: string }>(sql`
      select id from close_events
       where org_id = ${org.orgId} and run_id = ${runId} and event_type = 'package.delivered'`)).rows;
    assert.equal(delivered.length, 0, "a failed handoff must never read as delivered");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

async function seedMisconfiguredPackage(
  orgId: string,
  senderId: string,
  patch: { recipients?: string; reports?: string; delivery?: string },
): Promise<{ packageId: string; runId: string }> {
  const packageId = randomUUID();
  await db.execute(sql`
    insert into close_reporting_packages (id, org_id, name, reports, recipients, delivery, created_by)
    values (${packageId}, ${orgId}, 'misconfigured package',
            ${patch.reports ?? '[{"slug":"close-probe"}]'}::jsonb,
            ${patch.recipients ?? '["ops@scratch.test"]'}::jsonb,
            ${patch.delivery ?? '{}'}::jsonb, ${senderId})`);
  const period = (await db.execute<{ id: string }>(sql`
    select id from accounting_periods where org_id = ${orgId} order by starts_on limit 1
  `)).rows[0]!;
  const book = (await db.execute<{ id: string }>(sql`
    select id from accounting_books where org_id = ${orgId} limit 1
  `)).rows[0]!;
  const runId = await startCloseRun({
    orgId, periodId: period.id, bookId: book.id, actorId: senderId, reportingPackageId: packageId,
  });
  await db.execute(sql`
    update close_runs set status = 'closed', reporting_package_id = ${packageId}
     where id = ${runId} and org_id = ${orgId}`);
  return { packageId, runId };
}

async function deliveryFailures(orgId: string, runId: string | null): Promise<{ reason: string | null }[]> {
  const rows = (await db.execute<{ reason: string | null }>(sql`
    select payload->>'reason' as reason from close_events
     where org_id = ${orgId}
       and ((${runId}::uuid is null and run_id is null)
         or (${runId}::uuid is not null and run_id = ${runId}::uuid))
       and event_type = 'package.delivery_failed'`)).rows;
  return rows;
}

test("a scheduled package with no recipients fails named and visible, never skipped", { skip: !DB }, async () => {
  // C-52: zero recipients on an on-publish package is misconfiguration,
  // not a skip. The worker records package.delivery_failed on the run
  // timeline and throws so BullMQ never marks it complete.
  const org = await createScratchOrg();
  try {
    const sender = await createScratchUser(org.orgId, "Sender", "sender");
    const { packageId, runId } = await seedMisconfiguredPackage(org.orgId, sender, { recipients: "[]" });
    await assert.rejects(
      processCloseDeliveryJobData({ orgId: org.orgId, packageId, runId, senderId: sender }, {}),
      /no recipients/,
    );
    assert.deepEqual(await deliveryFailures(org.orgId, runId), [{ reason: "no-recipients" }]);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a scheduled package with no reports fails named and visible, never skipped", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const sender = await createScratchUser(org.orgId, "Sender", "sender");
    const { packageId, runId } = await seedMisconfiguredPackage(org.orgId, sender, { reports: "[]" });
    await assert.rejects(
      processCloseDeliveryJobData({ orgId: org.orgId, packageId, runId, senderId: sender }, {}),
      /no reports/,
    );
    assert.deepEqual(await deliveryFailures(org.orgId, runId), [{ reason: "no-reports" }]);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a manual-cadence package skips quietly on cadence-driven ticks", { skip: !DB }, async () => {
  // C-52: manual cadence is a legitimate skip for cadence-driven sends —
  // auto-delivery is off, and the job completes without recording a
  // failure. Only the explicit send-now marker (C-52b) opts back in; the
  // payload shape alone never does, so unmarked jobs of either shape skip.
  const org = await createScratchOrg();
  try {
    const sender = await createScratchUser(org.orgId, "Sender", "sender");
    const { packageId, runId } = await seedMisconfiguredPackage(org.orgId, sender, {
      recipients: "[]",
      delivery: '{"cadence":"manual"}',
    });
    const tick = await processCloseDeliveryJobData(
      { orgId: org.orgId, packageId, runId, senderId: sender }, {},
    ) as { skipped: string };
    assert.equal(tick.skipped, "manual cadence");
    assert.deepEqual(await deliveryFailures(org.orgId, runId), []);

    const period = (await db.execute<{ id: string }>(sql`
      select id from accounting_periods where org_id = ${org.orgId} order by starts_on limit 1
    `)).rows[0]!;
    const book = (await db.execute<{ id: string }>(sql`
      select id from accounting_books where org_id = ${org.orgId} limit 1
    `)).rows[0]!;
    const unmarkedSendNow = await processCloseDeliveryJobData(
      { orgId: org.orgId, packageId, periodId: period.id, bookId: book.id, senderId: sender }, {},
    ) as { skipped: string };
    assert.equal(unmarkedSendNow.skipped, "manual cadence");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("Send now on a manual-cadence package delivers", { skip: !DB }, async () => {
  // C-52b: manual cadence means "only when someone sends it" — an explicit
  // Send now carries the manual-trigger marker and must deliver exactly
  // like a scheduled package: report run minted, bundle handed to mail,
  // delivery recorded.
  const org = await createScratchOrg();
  try {
    const sender = await createScratchUser(org.orgId, "Sender", "sender");
    const { packageId, definitionId, periodId, bookId } = await seedReportablePackage(
      org.orgId, sender, '{"cadence":"manual"}',
    );
    const idempotencyKey = randomUUID();
    const renderedParams: Array<Record<string, string>> = [];
    const enqueued: Array<{ data: unknown; options: unknown }> = [];
    const result = await processCloseDeliveryJobData(
      { orgId: org.orgId, packageId, periodId, bookId, senderId: sender, manualTrigger: true, idempotencyKey },
      {
        renderReport: async (renderOrgId, renderDefinitionId, params) => {
          assert.equal(renderOrgId, org.orgId);
          assert.equal(renderDefinitionId, definitionId);
          renderedParams.push(params);
          return Buffer.from("%PDF-1.4 close-probe\n%%EOF");
        },
        enqueueEmail: async (data, options) => {
          enqueued.push({ data, options });
          return [{ id: "email-job-1" }];
        },
      },
    ) as { reports: number; files: number; recipients: number };
    assert.equal(result.reports, 1);
    assert.equal(result.files, 1);
    assert.equal(result.recipients, 1);

    // The render rode a durable close-package run with no close run —
    // send-now has no run context.
    assert.equal(renderedParams.length, 1);
    const reportRunId = renderedParams[0]!.runId;
    assert.match(reportRunId ?? "", UUID_RE, "the render must carry its report run id");
    const runs = (await db.execute<{
      trigger: string; status: string; closePackageId: string | null; closeRunId: string | null;
    }>(sql`
      select trigger, status,
             filters->'closePackage'->>'packageId' as "closePackageId",
             filters->'closePackage'->>'runId' as "closeRunId"
        from report_runs where id = ${reportRunId} and org_id = ${org.orgId}`)).rows;
    assert.equal(runs.length, 1, "the render must mint its run row");
    assert.equal(runs[0]!.trigger, "close-package");
    assert.equal(runs[0]!.status, "succeeded");
    assert.equal(runs[0]!.closePackageId, packageId);
    assert.equal(runs[0]!.closeRunId, null);

    // The bundle was handed to mail and the delivery recorded with no run.
    assert.equal(enqueued.length, 1);
    assert.deepEqual((enqueued[0]!.data as { to: string[] }).to, ["ops@scratch.test"]);
    assert.equal(
      (enqueued[0]!.options as { jobId: string }).jobId,
      `close-package|manual|${org.orgId}|${packageId}|${periodId}|${bookId}|${idempotencyKey}`,
      "the queued email identity must come from the request's idempotency key",
    );
    const events = (await db.execute<{ event_type: string; payload: unknown }>(sql`
      select event_type, payload from close_events
       where org_id = ${org.orgId} and run_id is null and event_type = 'package.delivered'`)).rows;
    assert.equal(events.length, 1, "delivery must record its event");
    assert.equal((events[0]!.payload as { reports: number }).reports, 1);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("manual Send now refuses a job with no request idempotency key", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const sender = await createScratchUser(org.orgId, "Sender", "sender");
    const { packageId, periodId, bookId } = await seedReportablePackage(
      org.orgId, sender, '{"cadence":"manual"}',
    );
    let emailEnqueues = 0;
    await assert.rejects(
      processCloseDeliveryJobData(
        { orgId: org.orgId, packageId, periodId, bookId, senderId: sender, manualTrigger: true },
        {
          renderReport: async () => Buffer.from("%PDF-1.4 close-probe\n%%EOF"),
          enqueueEmail: async () => {
            emailEnqueues += 1;
            return [{ id: "email-job-1" }];
          },
        },
      ),
      /missing the request idempotency key.*retry through Send now/,
    );
    assert.equal(emailEnqueues, 0, "an unattributed manual intent must never send email");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("close delivery without any principal refuses by name", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const nobody = await createScratchUser(org.orgId, "Nobody", "nobody");
    const definitionId = randomUUID();
    await db.execute(sql`
      insert into report_definitions (id, org_id, kind, report_type, slug, name, query, statement, created_by)
      values (${definitionId}, ${org.orgId}, 'custom', 'query', 'close-probe', 'Close probe',
              '{"entity":"trial_balance","columns":["account"]}'::jsonb, null, ${nobody})`);
    // created_by intentionally null: no sender, no author.
    const packageId = randomUUID();
    await db.execute(sql`
      insert into close_reporting_packages (id, org_id, name, reports, recipients, delivery, created_by)
      values (${packageId}, ${org.orgId}, 'authorless package', '[{"slug":"close-probe"}]'::jsonb,
              '["ops@scratch.test"]'::jsonb, '{}'::jsonb, null)`);
    const period = (await db.execute<{ id: string }>(sql`
      select id from accounting_periods where org_id = ${org.orgId} order by starts_on limit 1
    `)).rows[0]!;
    const book = (await db.execute<{ id: string }>(sql`
      select id from accounting_books where org_id = ${org.orgId} limit 1
    `)).rows[0]!;
    await assert.rejects(
      processCloseDeliveryJobData(
        { orgId: org.orgId, packageId, periodId: period.id, bookId: book.id },
        { enqueueEmail: async () => [{ id: "email-job-1" }] },
      ),
      /no recorded sender/,
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
