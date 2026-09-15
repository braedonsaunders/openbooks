import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { metrics } from "@opentelemetry/api";
import {
  AggregationTemporality,
  DataPointType,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
  type DataPoint,
  type Histogram,
  type MetricData,
} from "@opentelemetry/sdk-metrics";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { ATTR_KIND, ATTR_SURFACE } from "./telemetry.ts";
import {
  claimPostingEffectsForDocument,
  listFailedPostingEffects,
  markPostingEffectsFailed,
  markPostingEffectsSucceeded,
  MAX_POSTING_EFFECTS_ATTEMPTS,
  PostingEffectsLeaseFencedError,
  processDuePostingEffects,
  recoverStalePostingEffects,
  replayTerminalPostingEffect,
} from "./posting-effects.ts";
import {
  POSTING_EFFECTS_WORKER_IDENTITY,
  TERMINAL_FAILURE_LOG_EVENT,
} from "./terminal-failure.ts";
import { createScratchOrg, dropScratchOrg } from "./test-fixtures.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

// In-memory metric sink for the duration-value test below: the same globals
// the boot registers, but exporting locally. Each test file runs in its own
// process, so this cannot leak into other files' assertions.
const metricExporter = new InMemoryMetricExporter(AggregationTemporality.DELTA);
const meterProvider = new MeterProvider({
  readers: [
    new PeriodicExportingMetricReader({ exporter: metricExporter, exportIntervalMillis: 3_600_000 }),
  ],
});
metrics.setGlobalMeterProvider(meterProvider);

async function collectDurations(): Promise<Array<DataPoint<Histogram>>> {
  await meterProvider.forceFlush();
  const snapshot = metricExporter
    .getMetrics()
    .flatMap((resource) => resource.scopeMetrics.flatMap((scope) => scope.metrics));
  metricExporter.reset();
  const metric = snapshot.find((candidate) => candidate.descriptor.name === "openbooks.outbox.attempt_duration");
  assert.ok(metric, "attempt_duration was not exported");
  assert.equal(metric.dataPointType, DataPointType.HISTOGRAM, "attempt_duration must be a histogram");
  return (metric as MetricData).dataPoints as Array<DataPoint<Histogram>>;
}

test("attempt ceiling terminalizes posting effects and authorized replay preserves audit evidence", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const actorId = randomUUID();
  const documentId = randomUUID();
  const entryId = randomUUID();
  const effectId = randomUUID();
  const terminalAt = new Date("2026-07-20T12:00:00.000Z");
  const logs: string[] = [];
  const originalLog = console.log;
  try {
    await db.transaction(async (tx) => {
      const role = await tx.execute<{ id: string }>(sql`
        insert into app_roles (org_id, key, name, is_built_in, permissions)
        values (${org.orgId}, 'posting-effects-operator', 'Posting Effects Operator', false, '[]'::jsonb)
        returning id
      `);
      await tx.execute(sql`
        insert into users (id, org_id, email, name, password_hash, is_active)
        values (${actorId}, ${org.orgId}, ${`posting-effects-${actorId.slice(0, 8)}@test.local`},
                'Posting Effects Operator', 'x', true)
      `);
      await tx.execute(sql`
        insert into role_assignments (org_id, user_id, role_id)
        values (${org.orgId}, ${actorId}, ${role.rows[0]!.id})
      `);
    });
    await db.execute(sql`
      insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
      values (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId},
              ${`POSTFX-${entryId}`}, ${org.date}, ${org.periodId}, 'draft', 'document')
    `);
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, document_number, document_date, currency, status, custom)
      values (${documentId}, ${org.orgId}, 'customer_invoice', ${`INV-${documentId}`},
              ${org.date}, 'CAD', 'draft', '{}'::jsonb)
    `);
    await db.execute(sql`
      insert into posting_effects
        (id, org_id, document_id, kind, entry_id, posting_date, actor_id,
         status, attempt_count, next_attempt_at)
      values (${effectId}, ${org.orgId}, ${documentId}, 'customer_invoice', ${entryId},
              ${org.date}, ${actorId}, 'failed', ${MAX_POSTING_EFFECTS_ATTEMPTS - 1},
              '2000-01-01T00:00:00Z')
    `);

    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    const result = await processDuePostingEffects(terminalAt, 1, async () => {
      throw new Error("inventory projection remained inconsistent");
    });
    console.log = originalLog;
    assert.deepEqual(result, { processed: 1, succeeded: 0, failed: 1, fenced: 0 });

    const failed = await listFailedPostingEffects(org.orgId);
    assert.equal(failed.length, 1);
    assert.equal(failed[0]!.id, effectId);
    assert.equal(failed[0]!.status, "terminal_failed");
    assert.equal(failed[0]!.attemptCount, MAX_POSTING_EFFECTS_ATTEMPTS);
    assert.equal(failed[0]!.terminalFailureReason, "inventory projection remained inconsistent");
    assert.equal(new Date(failed[0]!.terminalFailedAt!).toISOString(), terminalAt.toISOString());
    assert.equal(failed[0]!.terminalFailedBy, POSTING_EFFECTS_WORKER_IDENTITY);
    assert.equal(
      logs.filter((line) => line.includes(TERMINAL_FAILURE_LOG_EVENT) && line.includes(effectId)).length,
      1,
      "the terminal transition emits exactly one operator signal",
    );

    const terminalAudit = await db.execute<{ event: string; reason: string }>(sql`
      select changes->>'event' as event, changes->'after'->>'reason' as reason
        from audit_log
       where org_id=${org.orgId} and table_name='posting_effects' and row_id=${effectId}
         and request_id='posting_effects_terminal_failure'
    `);
    assert.deepEqual(terminalAudit.rows, [{
      event: "posting_effects_terminal_failure",
      reason: "inventory projection remained inconsistent",
    }]);

    const replayAt = new Date("2026-07-20T13:00:00.000Z");
    await replayTerminalPostingEffect({
      orgId: org.orgId,
      id: effectId,
      actorId,
      reason: "Controller verified the inventory configuration and approved a deterministic replay.",
      now: replayAt,
    });
    assert.deepEqual(await listFailedPostingEffects(org.orgId), []);
    const replayed = await db.execute<{
      status: string;
      attempt_count: number;
      terminal_failure_reason: string | null;
    }>(sql`
      select status, attempt_count, terminal_failure_reason
        from posting_effects where id=${effectId} and org_id=${org.orgId}
    `);
    assert.deepEqual(replayed.rows, [{ status: "pending", attempt_count: 0, terminal_failure_reason: null }]);

    const replayAudit = await db.execute<{ event: string; actor_id: string; reason: string }>(sql`
      select changes->>'event' as event, actor_id, changes->>'reason' as reason
        from audit_log
       where org_id=${org.orgId} and table_name='posting_effects' and row_id=${effectId}
         and request_id='posting_effects_replay'
    `);
    assert.deepEqual(replayAudit.rows, [{
      event: "posting_effects_replay_authorized",
      actor_id: actorId,
      reason: "Controller verified the inventory configuration and approved a deterministic replay.",
    }]);

    const replayResult = await processDuePostingEffects(replayAt, 1, async () => {});
    assert.deepEqual(replayResult, { processed: 1, succeeded: 1, failed: 0, fenced: 0 });
  } finally {
    console.log = originalLog;
    await dropScratchOrg(org.orgId);
  }
});

test("document claim reports each lifecycle state distinctly", { skip: !DB }, async () => {
  // Every branch of the claim fallback is a mutation target: a negated row
  // guard returns null for a pending claim, flipped status comparisons
  // misreport succeeded/running/terminal rows, and a shifted row index
  // loses the claim. Each row below pins one branch with exact values.
  const org = await createScratchOrg();
  const docIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const entryIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const effectIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  try {
    assert.equal(await claimPostingEffectsForDocument(randomUUID()), null);

    for (let i = 0; i < 4; i += 1) {
      await db.execute(sql`
        insert into journal_entries
          (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
        values (${entryIds[i]}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId},
                ${`POSTFX-CLAIM-${i}-${entryIds[i]}`}, ${org.date}, ${org.periodId}, 'draft', 'document')
      `);
      await db.execute(sql`
        insert into documents
          (id, org_id, kind, document_number, document_date, currency, status, custom)
        values (${docIds[i]}, ${org.orgId}, 'customer_invoice', ${`INV-CLAIM-${i}-${docIds[i]}`},
                ${org.date}, 'CAD', 'draft', '{}'::jsonb)
      `);
    }
    await db.execute(sql`
      insert into posting_effects
        (id, org_id, document_id, kind, entry_id, posting_date, status, next_attempt_at)
      values (${effectIds[0]}, ${org.orgId}, ${docIds[0]}, 'customer_invoice', ${entryIds[0]},
              ${org.date}, 'pending', '2000-01-01T00:00:00Z')
    `);
    await db.execute(sql`
      insert into posting_effects
        (id, org_id, document_id, kind, entry_id, posting_date, status,
         attempt_count, locked_at, lease_token, next_attempt_at)
      values (${effectIds[1]}, ${org.orgId}, ${docIds[1]}, 'customer_invoice', ${entryIds[1]},
              ${org.date}, 'running', 1, now(), gen_random_uuid(), '2000-01-01T00:00:00Z')
    `);
    await db.execute(sql`
      insert into posting_effects
        (id, org_id, document_id, kind, entry_id, posting_date, status,
         attempt_count, next_attempt_at)
      values (${effectIds[2]}, ${org.orgId}, ${docIds[2]}, 'customer_invoice', ${entryIds[2]},
              ${org.date}, 'failed', ${MAX_POSTING_EFFECTS_ATTEMPTS}, '2000-01-01T00:00:00Z')
    `);
    await db.execute(sql`
      insert into posting_effects
        (id, org_id, document_id, kind, entry_id, posting_date, status,
         attempt_count, terminal_failure_reason, terminal_failed_at, terminal_failed_by,
         next_attempt_at)
      values (${effectIds[3]}, ${org.orgId}, ${docIds[3]}, 'customer_invoice', ${entryIds[3]},
              ${org.date}, 'terminal_failed', ${MAX_POSTING_EFFECTS_ATTEMPTS},
              'poison', '2026-07-20T12:00:00Z', 'posting-effects-worker', '2000-01-01T00:00:00Z')
    `);

    const claimed = await claimPostingEffectsForDocument(docIds[0]!);
    assert.ok(claimed !== null && typeof claimed === "object");
    assert.equal(claimed.id, effectIds[0]);
    assert.equal(claimed.attempt_count, 1);

    await markPostingEffectsSucceeded(claimed, new Date("2026-07-20T12:00:00.000Z"));
    assert.equal(await claimPostingEffectsForDocument(docIds[0]!), "succeeded");

    // A running row the claim cannot take, and a failed row at the attempt
    // ceiling, both report "running" so the synchronous drain stands down
    // while the scheduler or recovery owns the work.
    assert.equal(await claimPostingEffectsForDocument(docIds[1]!), "running");
    assert.equal(await claimPostingEffectsForDocument(docIds[2]!), "running");
    assert.equal(await claimPostingEffectsForDocument(docIds[3]!), "terminal_failed");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("stale recovery spares fresh leases and stays silent without a terminal transition", { skip: !DB }, async () => {
  // A divided threshold (or a shifted staleness bound) recovers the fresh
  // lease too; negated becameTerminal guards write terminal audit evidence
  // and emit the operator signal for a routine retryable recovery.
  const org = await createScratchOrg();
  const documentId = randomUUID();
  const freshDocumentId = randomUUID();
  const entryId = randomUUID();
  const freshId = randomUUID();
  const staleId = randomUUID();
  const freshLease = randomUUID();
  const staleLease = randomUUID();
  const recoveryNow = new Date("2026-07-20T12:00:00.000Z");
  const freshAt = new Date(recoveryNow.getTime() - 60_000);
  const staleAt = new Date(recoveryNow.getTime() - 16 * 60_000);
  const logs: string[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  try {
    await db.execute(sql`
      insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
      values (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId},
              ${`POSTFX-SILENT-${entryId}`}, ${org.date}, ${org.periodId}, 'draft', 'document')
    `);
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, document_number, document_date, currency, status, custom)
      values (${documentId}, ${org.orgId}, 'vendor_bill', ${`BILL-SILENT-${documentId}`},
              ${org.date}, 'CAD', 'draft', '{}'::jsonb),
             (${freshDocumentId}, ${org.orgId}, 'vendor_bill', ${`BILL-SILENT-${freshDocumentId}`},
              ${org.date}, 'CAD', 'draft', '{}'::jsonb)
    `);
    await db.execute(sql`
      insert into posting_effects
        (id, org_id, document_id, kind, entry_id, posting_date, status,
         attempt_count, locked_at, lease_token, next_attempt_at)
      values (${freshId}, ${org.orgId}, ${freshDocumentId}, 'vendor_bill', ${entryId},
              ${org.date}, 'running', 0, ${freshAt}, ${freshLease}, '2000-01-01T00:00:00Z'),
             (${staleId}, ${org.orgId}, ${documentId}, 'vendor_bill', ${entryId},
              ${org.date}, 'running', 0, ${staleAt}, ${staleLease}, '2000-01-01T00:00:00Z')
    `);

    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    console.warn = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    console.error = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    assert.equal(await recoverStalePostingEffects(recoveryNow), 1);

    const rows = await db.execute<{
      id: string;
      status: string;
      attempt_count: number;
      lease_token: string | null;
      locked_at: Date | null;
    }>(sql`
      select id, status, attempt_count, lease_token, locked_at
        from posting_effects where org_id = ${org.orgId} order by id
    `);
    const fresh = rows.rows.find((r) => r.id === freshId)!;
    assert.deepEqual(
      { status: fresh.status, attempt_count: fresh.attempt_count, lease_token: fresh.lease_token },
      { status: "running", attempt_count: 0, lease_token: freshLease },
    );
    assert.equal(new Date(fresh.locked_at!).getTime(), freshAt.getTime());
    const stale = rows.rows.find((r) => r.id === staleId)!;
    assert.deepEqual(
      { status: stale.status, attempt_count: stale.attempt_count, lease_token: stale.lease_token },
      { status: "failed", attempt_count: 0, lease_token: null },
    );

    const terminalAudit = await db.execute<{ count: string }>(sql`
      select count(*)::text as count from audit_log
       where org_id = ${org.orgId} and table_name = 'posting_effects'
         and request_id = 'posting_effects_terminal_failure'
    `);
    assert.equal(terminalAudit.rows[0]!.count, "0");
    assert.deepEqual(
      logs.filter((line) => line.includes(TERMINAL_FAILURE_LOG_EVENT)),
      [],
    );
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
    await dropScratchOrg(org.orgId);
  }
});

test("failure evidence truncates at one thousand characters and replay guards its preconditions", { skip: !DB }, async () => {
  // The 1000-character evidence bound, the missing-row and non-terminal
  // replay guards, and the exact 10/1000-character reason acceptances each
  // pin one mutation: shifted bounds, negated existence checks, or narrowed
  // reason fences.
  const org = await createScratchOrg();
  const actorId = randomUUID();
  const docIds = [randomUUID(), randomUUID()];
  const entryIds = [randomUUID(), randomUUID()];
  const effectIds = [randomUUID(), randomUUID()];
  const failedAt = new Date("2026-07-20T12:00:00.000Z");
  try {
    await db.transaction(async (tx) => {
      const role = await tx.execute<{ id: string }>(sql`
        insert into app_roles (org_id, key, name, is_built_in, permissions)
        values (${org.orgId}, 'posting-effects-guard', 'Posting Effects Guard', false, '[]'::jsonb)
        returning id
      `);
      await tx.execute(sql`
        insert into users (id, org_id, email, name, password_hash, is_active)
        values (${actorId}, ${org.orgId}, ${`posting-effects-guard-${actorId.slice(0, 8)}@test.local`},
                'Posting Effects Guard', 'x', true)
      `);
      await tx.execute(sql`
        insert into role_assignments (org_id, user_id, role_id)
        values (${org.orgId}, ${actorId}, ${role.rows[0]!.id})
      `);
    });
    for (let i = 0; i < 2; i += 1) {
      await db.execute(sql`
        insert into journal_entries
          (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
        values (${entryIds[i]}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId},
                ${`POSTFX-GUARD-${i}-${entryIds[i]}`}, ${org.date}, ${org.periodId}, 'draft', 'document')
      `);
      await db.execute(sql`
        insert into documents
          (id, org_id, kind, document_number, document_date, currency, status, custom)
        values (${docIds[i]}, ${org.orgId}, 'customer_invoice', ${`INV-GUARD-${i}-${docIds[i]}`},
                ${org.date}, 'CAD', 'draft', '{}'::jsonb)
      `);
      await db.execute(sql`
        insert into posting_effects
          (id, org_id, document_id, kind, entry_id, posting_date, status,
           attempt_count, next_attempt_at)
        values (${effectIds[i]}, ${org.orgId}, ${docIds[i]}, 'customer_invoice', ${entryIds[i]},
                ${org.date}, 'failed', ${MAX_POSTING_EFFECTS_ATTEMPTS - 1}, '2000-01-01T00:00:00Z')
      `);
    }

    const first = await claimPostingEffectsForDocument(docIds[0]!);
    assert.ok(first !== null && typeof first === "object");
    await markPostingEffectsFailed(first, new Error("x".repeat(2000)), failedAt);
    const stored = await db.execute<{ error: string }>(sql`
      select error from posting_effects where id = ${effectIds[0]} and org_id = ${org.orgId}
    `);
    assert.equal(stored.rows[0]!.error.length, 1000);

    await assert.rejects(
      () => replayTerminalPostingEffect({
        orgId: org.orgId,
        id: randomUUID(),
        actorId,
        reason: "Controller verified the failure and approved a replay.",
      }),
      /was not found/,
    );
    await assert.rejects(
      () => replayTerminalPostingEffect({
        orgId: org.orgId,
        id: effectIds[1]!,
        actorId,
        reason: "Controller verified the failure and approved a replay.",
      }),
      /only terminal-failed/,
    );

    // Terminalize both rows, then replay at the exact reason-length fences:
    // 10 and 1000 characters are legal; 9 and 1001 already throw elsewhere.
    await db.execute(sql`
      update posting_effects set attempt_count = ${MAX_POSTING_EFFECTS_ATTEMPTS - 1}, status = 'failed'
       where id in (${effectIds[0]}, ${effectIds[1]}) and org_id = ${org.orgId}
    `);
    for (const docId of docIds) {
      const row = await claimPostingEffectsForDocument(docId!);
      assert.ok(row !== null && typeof row === "object");
      await markPostingEffectsFailed(row, new Error("ceiling reached"), failedAt);
    }
    await replayTerminalPostingEffect({
      orgId: org.orgId,
      id: effectIds[0]!,
      actorId,
      reason: "0123456789",
    });
    await replayTerminalPostingEffect({
      orgId: org.orgId,
      id: effectIds[1]!,
      actorId,
      reason: "y".repeat(1000),
    });
    const replayed = await db.execute<{ id: string; status: string; attempt_count: number }>(sql`
      select id, status, attempt_count from posting_effects where org_id = ${org.orgId} order by id
    `);
    assert.deepEqual(replayed.rows, replayed.rows.map((r) => ({
      id: r.id,
      status: "pending",
      attempt_count: 0,
    })));
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

/** Bulk-seed `count` due (or failed) effects with real documents and entries. */
async function seedEffects(
  org: { orgId: string; bookId: string; subsidiaryId: string; periodId: string; date: string },
  count: number,
  prefix: string,
  status: "pending" | "failed",
): Promise<void> {
  await db.execute(sql`
    with docs as (
      insert into documents
        (id, org_id, kind, document_number, document_date, currency, status, custom)
      select gen_random_uuid(), ${org.orgId}, 'customer_invoice',
             ${prefix} || '-D-' || g, ${org.date}, 'CAD', 'draft', '{}'::jsonb
        from generate_series(1, ${count}) g
      returning id
    ),
    numbered_docs as (select id, row_number() over (order by id) as rn from docs),
    entries as (
      insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
      select gen_random_uuid(), ${org.orgId}, ${org.bookId}, ${org.subsidiaryId},
             ${prefix} || '-E-' || rn, ${org.date}, ${org.periodId}, 'draft', 'document'
        from numbered_docs
      returning id
    ),
    numbered_entries as (select id, row_number() over (order by id) as rn from entries)
    insert into posting_effects
      (org_id, document_id, kind, entry_id, posting_date, status, next_attempt_at)
    select ${org.orgId}, d.id, 'customer_invoice', e.id, ${org.date},
           ${status}, '2000-01-01T00:00:00Z'
      from numbered_docs d join numbered_entries e on e.rn = d.rn
  `);
}

test("failed-effects listing caps the default page at one hundred rows", { skip: !DB }, async () => {
  // The default limit is a mutation target (100 -> 99/101): only a store
  // holding more than a page distinguishes the cap from "everything".
  const org = await createScratchOrg();
  try {
    await seedEffects(org, 105, "CAP", "failed");
    const page = await listFailedPostingEffects(org.orgId);
    assert.equal(page.length, 100);
    assert.equal((await listFailedPostingEffects(org.orgId, 3)).length, 3);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("the due drain honors its default, zero and explicit batch caps", { skip: !DB }, async () => {
  // The default limit (50 -> 49/51), the lower clamp (1 -> 0/2, observed
  // through limit 0 over two rows), and the loop bounds each pin one
  // mutation of the batch arithmetic.
  const now = new Date("2026-07-20T12:00:00.000Z");
  const noop = async () => {};
  const orgDefault = await createScratchOrg();
  try {
    await seedEffects(orgDefault, 55, "BAT-D", "pending");
    assert.deepEqual(await processDuePostingEffects(now, undefined, noop), {
      processed: 50,
      succeeded: 50,
      failed: 0,
      fenced: 0,
    });
  } finally {
    await dropScratchOrg(orgDefault.orgId);
  }
  const orgZero = await createScratchOrg();
  try {
    await seedEffects(orgZero, 2, "BAT-Z", "pending");
    assert.deepEqual(await processDuePostingEffects(now, 0, noop), {
      processed: 1,
      succeeded: 1,
      failed: 0,
      fenced: 0,
    });
  } finally {
    await dropScratchOrg(orgZero.orgId);
  }
  const orgTwo = await createScratchOrg();
  try {
    await seedEffects(orgTwo, 3, "BAT-T", "pending");
    assert.deepEqual(await processDuePostingEffects(now, 2, noop), {
      processed: 2,
      succeeded: 2,
      failed: 0,
      fenced: 0,
    });
  } finally {
    await dropScratchOrg(orgTwo.orgId);
  }
});

test("the due drain never takes more than two hundred rows per call", { skip: !DB }, async () => {
  // The 200-row safety cap (200 -> 199/201) and the loop-bound mutations
  // (i = -1, i <= batch, break-on-row) only separate with a store deeper
  // than the cap: 201 due rows must still drain exactly 200.
  const now = new Date("2026-07-20T12:00:00.000Z");
  const org = await createScratchOrg();
  try {
    await seedEffects(org, 201, "BAT-C", "pending");
    assert.deepEqual(await processDuePostingEffects(now, 500, async () => {}), {
      processed: 200,
      succeeded: 200,
      failed: 0,
      fenced: 0,
    });
    const left = await db.execute<{ count: string }>(sql`
      select count(*)::text as count from posting_effects
       where org_id = ${org.orgId} and status = 'pending'
    `);
    assert.equal(left.rows[0]!.count, "1");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("the due drain reports wall-clock attempt durations", { skip: !DB }, async () => {
  // The duration argument is a mutation target (Date.now() - startedAt ->
  // Date.now() + startedAt): only a value assertion separates a millisecond
  // duration from a ~3.5e12 epoch sum, which the clamping below cannot catch.
  const org = await createScratchOrg();
  try {
    await seedEffects(org, 2, "BAT-M", "pending");
    let calls = 0;
    const result = await processDuePostingEffects(new Date("2026-07-20T12:00:00.000Z"), 10, async () => {
      calls += 1;
      if (calls === 1) throw new Error("first attempt fails");
    });
    assert.deepEqual(result, { processed: 2, succeeded: 1, failed: 1, fenced: 0 });
    const points = (await collectDurations()).filter(
      (point) => point.attributes[ATTR_SURFACE] === "posting_effects",
    );
    assert.ok(points.length >= 1, "expected duration points");
    for (const point of points) {
      const sum = point.value.sum ?? -1;
      assert.ok(
        sum >= 0 && sum < 3_600_000,
        `duration sum ${String(sum)} for kind ${String(point.attributes[ATTR_KIND])} is not a wall-clock duration`,
      );
    }
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a failure completion raced by a lease change counts fenced", { skip: !DB }, async () => {
  // markPostingEffectsFailed throws LeaseFencedError when the lease moved
  // under it; the drain must count that fenced rather than failed — and
  // must not let the fenced error escape, under the negated handler.
  const org = await createScratchOrg();
  const documentId = randomUUID();
  const entryId = randomUUID();
  const effectId = randomUUID();
  try {
    await db.execute(sql`
      insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
      values (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId},
              ${`POSTFX-RACE-${entryId}`}, ${org.date}, ${org.periodId}, 'draft', 'document')
    `);
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, document_number, document_date, currency, status, custom)
      values (${documentId}, ${org.orgId}, 'vendor_bill', ${`BILL-RACE-${documentId}`},
              ${org.date}, 'CAD', 'draft', '{}'::jsonb)
    `);
    await db.execute(sql`
      insert into posting_effects
        (id, org_id, document_id, kind, entry_id, posting_date, status, next_attempt_at)
      values (${effectId}, ${org.orgId}, ${documentId}, 'vendor_bill', ${entryId},
              ${org.date}, 'pending', '2000-01-01T00:00:00Z')
    `);
    const result = await processDuePostingEffects(
      new Date("2026-07-20T12:00:00.000Z"),
      1,
      async (row) => {
        await db.execute(sql`
          update posting_effects set lease_token = gen_random_uuid() where id = ${row.id}
        `);
        throw new Error("drain failed after the lease moved");
      },
    );
    assert.deepEqual(result, { processed: 1, succeeded: 0, failed: 0, fenced: 1 });
    // The fenced failure completion reports a wall-clock duration too: the
    // recording on that branch is a mutation target of its own.
    for (const point of (await collectDurations()).filter(
      (point) => point.attributes[ATTR_SURFACE] === "posting_effects",
    )) {
      const sum = point.value.sum ?? -1;
      assert.ok(
        sum >= 0 && sum < 3_600_000,
        `duration sum ${String(sum)} for kind ${String(point.attributes[ATTR_KIND])} is not a wall-clock duration`,
      );
    }
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a directly fenced drain completion counts fenced", { skip: !DB }, async () => {
  // When the drain itself reports a lease fence, the outer handler counts
  // fenced without attempting a completion — and the recording on that
  // branch carries a wall-clock duration.
  const org = await createScratchOrg();
  try {
    await seedEffects(org, 1, "BAT-F", "pending");
    const result = await processDuePostingEffects(new Date("2026-07-20T12:00:00.000Z"), 1, async () => {
      throw new PostingEffectsLeaseFencedError("simulated completion steal");
    });
    assert.deepEqual(result, { processed: 1, succeeded: 0, failed: 0, fenced: 1 });
    for (const point of (await collectDurations()).filter(
      (point) => point.attributes[ATTR_SURFACE] === "posting_effects",
    )) {
      const sum = point.value.sum ?? -1;
      assert.ok(
        sum >= 0 && sum < 3_600_000,
        `duration sum ${String(sum)} for kind ${String(point.attributes[ATTR_KIND])} is not a wall-clock duration`,
      );
    }
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a recovered posting-effect lease fences the stale worker completion", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const documentId = randomUUID();
  const entryId = randomUUID();
  const effectId = randomUUID();
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
      insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
      values (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId},
              ${`POSTFX-FENCE-${entryId}`}, ${org.date}, ${org.periodId}, 'draft', 'document')
    `);
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, document_number, document_date, currency, status, custom)
      values (${documentId}, ${org.orgId}, 'vendor_bill', ${`BILL-FENCE-${documentId}`},
              ${org.date}, 'CAD', 'draft', '{}'::jsonb)
    `);
    await db.execute(sql`
      insert into posting_effects
        (id, org_id, document_id, kind, entry_id, posting_date, status, next_attempt_at)
      values (${effectId}, ${org.orgId}, ${documentId}, 'vendor_bill', ${entryId},
              ${org.date}, 'pending', '2000-01-01T00:00:00Z')
    `);

    const staleWorker = processDuePostingEffects(firstNow, 1, async (row) => {
      oldLease = row.lease_token;
      signalOldClaimed();
      await oldHeld;
    });
    await oldClaimed;
    assert.ok(oldLease, "the first claim must carry a lease token");

    assert.equal(await recoverStalePostingEffects(recoveryNow), 1);
    const replacement = await processDuePostingEffects(recoveryNow, 1, async (row) => {
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
      select status, attempt_count, lease_token from posting_effects where id=${effectId}
    `);
    assert.deepEqual(stored.rows, [{ status: "succeeded", attempt_count: 2, lease_token: null }]);
  } finally {
    releaseOld?.();
    await dropScratchOrg(org.orgId);
  }
});
