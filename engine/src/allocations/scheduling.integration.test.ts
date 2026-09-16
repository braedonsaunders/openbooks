import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "../db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
  type ScratchOrg,
} from "../test-fixtures.ts";
import { ensureCloseDefaults } from "../close.ts";
import { postProjectGlEntry } from "../project-recognition.ts";
import {
  ALLOCATION_RUN_OUTBOX_KIND,
  allocationRunOccurrenceKey,
  ensureAllocationRunOutboxRows,
  processAllocationRunOutboxRow,
  runAllocationCloseAction,
} from "./scheduling.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

async function enableAllocations(orgId: string, on = true): Promise<void> {
  await db.execute(sql`
    update orgs set settings = jsonb_set(
      settings, '{features}',
      coalesce(settings->'features', '{}'::jsonb) || ${JSON.stringify({ allocations: on })}::jsonb, true)
    where id = ${orgId}
  `);
}

async function seedPeriodRule(
  org: ScratchOrg,
  overrides: {
    runPolicy?: string;
    status?: string;
    isActive?: boolean;
    mode?: string;
    omitPublisher?: boolean;
  } = {},
): Promise<{ ruleId: string; versionId: string; publishedBy: string | null }> {
  const actors = await seedFlowActors(org.orgId);
  const rule = (
    await db.execute<{ id: string }>(sql`
      insert into allocation_rules (org_id, key, name, mode, is_active)
      values (${org.orgId}, ${`sched-${randomUUID().slice(0, 8)}`}, 'Scheduled rule', ${overrides.mode ?? "period"}, ${overrides.isActive ?? true})
      returning id
    `)
  ).rows[0]!;
  // Targets are immutable once published: draft → targets → publish.
  const version = (
    await db.execute<{ id: string }>(sql`
      insert into allocation_rule_versions
        (org_id, rule_id, version_no, status, effective_from, definition_hash,
         run_policy, run_offset_days, book_scope, book_ids, account_scope)
      values (${org.orgId}, ${rule.id}, 1, 'draft', '2026-01-01', 'sched',
              ${overrides.runPolicy ?? "auto_preview"}, 0, 'books', ${JSON.stringify([org.bookId])}::jsonb,
              ${JSON.stringify({ kind: "accounts", accountIds: [org.accounts.adjustment] })}::jsonb)
      returning id
    `)
  ).rows[0]!;
  const deptId = (
    await db.execute<{ id: string }>(sql`
      insert into departments (org_id, name, is_active, custom)
      values (${org.orgId}, ${`Sched ${randomUUID().slice(0, 8)}`}, true, '{}'::jsonb)
      returning id
    `)
  ).rows[0]!.id;
  await db.execute(sql`
    insert into allocation_rule_targets
      (org_id, version_id, sequence, department_id, fixed_percent, is_remainder, custom)
    values (${org.orgId}, ${version.id}, 1, ${deptId}, '100.0000', false, '{}'::jsonb)`);
  await db.execute(
    overrides.omitPublisher
      ? sql`
    update allocation_rule_versions
       set status = ${overrides.status ?? "published"}, published_at = now()
     where id = ${version.id}`
      : sql`
    update allocation_rule_versions
       set status = ${overrides.status ?? "published"}, published_at = now(), published_by = ${actors.adminId}
     where id = ${version.id}`,
  );
  await db.execute(sql`
    update allocation_rules set current_version_id = ${version.id} where id = ${rule.id}
  `);
  // A real source pool for the sweep (the tests post for real).
  await postProjectGlEntry({
    orgId: org.orgId,
    actorId: actors.adminId,
    origin: "manual",
    entryNumber: `SCHED-SEED-${randomUUID()}`,
    postingDate: org.date,
    memo: "Scheduler sweep pool",
    subsidiaryId: org.subsidiaryId,
    currency: "CAD",
    lines: [
      { accountId: org.accounts.adjustment, amount: "100.0000" },
      { accountId: org.accounts.bank, amount: "-100.0000" },
    ],
  });
  return {
    ruleId: rule.id,
    versionId: version.id,
    publishedBy: overrides.omitPublisher ? null : actors.adminId,
  };
}

async function runStatusCount(orgId: string, ruleId: string, status: string): Promise<number> {
  const rows = (await db.execute<{ count: string }>(sql`
    select count(*)::text as count from allocation_runs
     where org_id = ${orgId} and rule_id = ${ruleId} and status = ${status}`)).rows;
  return Number(rows[0]?.count ?? 0);
}

async function outboxRows(orgId: string): Promise<
  Array<{ id: string; org_id: string | null; payload: unknown }>
> {
  const result = await db.execute<{ id: string; org_id: string | null; payload: unknown }>(sql`
    select id, org_id, payload from scheduler_outbox
     where org_id = ${orgId} and kind = ${ALLOCATION_RUN_OUTBOX_KIND}
     order by created_at
  `);
  return result.rows;
}

test("enqueue is idempotent and honors policy, runs, feature, and status guards", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await enableAllocations(org.orgId);
    const { ruleId } = await seedPeriodRule(org);
    const key = allocationRunOccurrenceKey(ruleId, org.periodId, org.bookId);

    assert.equal(await ensureAllocationRunOutboxRows(), 1);
    const rows = await outboxRows(org.orgId);
    assert.equal(rows.length, 1);
    assert.equal(
      (await db.execute<{ occurrence_key: string }>(sql`
        select occurrence_key from scheduler_outbox where id = ${rows[0]!.id}
      `)).rows[0]!.occurrence_key,
      key,
    );
    const payload = rows[0]!.payload as Record<string, string>;
    assert.deepEqual(
      { ruleId: payload.ruleId, periodId: payload.periodId, bookId: payload.bookId },
      { ruleId, periodId: org.periodId, bookId: org.bookId },
    );

    // Second tick changes nothing: the occurrence key is the idempotency key.
    assert.equal(await ensureAllocationRunOutboxRows(), 0);
    assert.equal((await outboxRows(org.orgId)).length, 1);

    // Manual policy never enqueues.
    await db.execute(sql`delete from scheduler_outbox where org_id = ${org.orgId}`);
    await db.execute(sql`
      update allocation_rule_versions set run_policy = 'manual'
       where org_id = ${org.orgId} and rule_id = ${ruleId}
    `);
    assert.equal(await ensureAllocationRunOutboxRows(), 0);

    // A previewed run already covers the occurrence.
    await db.execute(sql`
      update allocation_rule_versions set run_policy = 'auto_preview'
       where org_id = ${org.orgId} and rule_id = ${ruleId}
    `);
    const versionId = (
      await db.execute<{ id: string }>(sql`
        select id from allocation_rule_versions where org_id = ${org.orgId} and rule_id = ${ruleId}
      `)
    ).rows[0]!.id;
    await db.execute(sql`
      insert into allocation_runs (org_id, rule_id, version_id, definition_hash, period_id, book_id, status)
      values (${org.orgId}, ${ruleId}, ${versionId}, 'sched', ${org.periodId}, ${org.bookId}, 'previewed')
    `);
    assert.equal(await ensureAllocationRunOutboxRows(), 0);

    // A failed run does not block the next attempt.
    await db.execute(sql`
      update allocation_runs set status = 'failed'
       where org_id = ${org.orgId} and rule_id = ${ruleId}
    `);
    assert.equal(await ensureAllocationRunOutboxRows(), 1);
    await db.execute(sql`delete from scheduler_outbox where org_id = ${org.orgId}`);

    // Feature off ⇒ nothing enqueues.
    await enableAllocations(org.orgId, false);
    assert.equal(await ensureAllocationRunOutboxRows(), 0);
    await enableAllocations(org.orgId, true);

    // A retired version has no schedule.
    await db.execute(sql`
      update allocation_rule_versions set status = 'retired'
       where org_id = ${org.orgId} and rule_id = ${ruleId}
    `);
    await db.execute(sql`delete from allocation_runs where org_id = ${org.orgId} and rule_id = ${ruleId}`);
    assert.equal(await ensureAllocationRunOutboxRows(), 0);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("processing previews and posts through the real engine", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await enableAllocations(org.orgId);
    const { ruleId, publishedBy } = await seedPeriodRule(org, { runPolicy: "auto_post" });
    assert.equal(await ensureAllocationRunOutboxRows(), 1);
    const row = (await outboxRows(org.orgId))[0]!;

    const result = await processAllocationRunOutboxRow(row);
    assert.deepEqual(result, { outcome: "ran", note: "previewed and posted (source 100.0000)" });
    assert.equal(await runStatusCount(org.orgId, ruleId, "posted"), 1);
    // Unattended firings attribute to the published version's publisher,
    // never a borrowed human or a faceless system actor.
    const requestedBy = (await db.execute<{ requested_by: string }>(sql`
      select requested_by from allocation_runs
       where org_id = ${org.orgId} and rule_id = ${ruleId} and status = 'posted'`)).rows[0]
      ?.requested_by;
    assert.equal(requestedBy, publishedBy);

    // auto_preview fires preview only.
    await db.execute(sql`
      update allocation_rule_versions set run_policy = 'auto_preview'
       where org_id = ${org.orgId} and rule_id = ${ruleId}
    `);
    const again = await processAllocationRunOutboxRow(row);
    assert.deepEqual(again, { outcome: "ran", note: "previewed (source 100.0000)" });
    assert.equal(await runStatusCount(org.orgId, ruleId, "posted"), 1);
    assert.equal(await runStatusCount(org.orgId, ruleId, "previewed"), 1);

    // Feature off ⇒ the engine is never touched.
    await enableAllocations(org.orgId, false);
    const skipped = await processAllocationRunOutboxRow(row);
    assert.deepEqual(skipped, { outcome: "skipped", note: "allocations feature is off" });
    assert.equal(await runStatusCount(org.orgId, ruleId, "previewed"), 1);
    await enableAllocations(org.orgId, true);

    // A retired rule skips quietly: the schedule legitimately went away.
    await db.execute(sql`
      update allocation_rule_versions set status = 'retired'
       where org_id = ${org.orgId} and rule_id = ${ruleId}
    `);
    const retired = await processAllocationRunOutboxRow(row);
    assert.equal(retired.outcome, "skipped");
    assert.equal(await runStatusCount(org.orgId, ruleId, "previewed"), 1);

    await assert.rejects(
      processAllocationRunOutboxRow({ id: row.id, org_id: org.orgId, payload: {} }),
      /ruleId, periodId, and bookId/,
    );

  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("unattended runs refuse a published version with no publisher", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await enableAllocations(org.orgId);
    // Bypass the publish service (which always stamps published_by and
    // freezes it via the version guard): a draft flipped to published by
    // hand carries no publisher.
    const { ruleId } = await seedPeriodRule(org, { runPolicy: "auto_post", omitPublisher: true });
    assert.equal(await ensureAllocationRunOutboxRows(), 1);
    const target = (await outboxRows(org.orgId)).find(
      (candidate) => (candidate.payload as { ruleId?: string }).ruleId === ruleId,
    )!;
    await assert.rejects(processAllocationRunOutboxRow(target), /no publisher/);
    assert.equal(await runStatusCount(org.orgId, ruleId, "previewed"), 0);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("close action previews and posts selected rules with stage checkpoints", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await enableAllocations(org.orgId);
    const actors = await seedFlowActors(org.orgId);
    const defaults = await ensureCloseDefaults(org.orgId, actors.adminId);
    const runId = (
      await db.execute<{ id: string }>(sql`
        insert into close_runs
          (org_id, period_id, book_id, blueprint_id, reporting_package_id, status,
           current_stage, target_close_date, scope, started_at, started_by, created_by, updated_by)
        values (${org.orgId}, ${org.periodId}, ${org.bookId}, ${defaults.blueprintId},
                ${defaults.reportingPackageId}, 'in_progress', 'review', current_date + 30,
                '{}'::jsonb, now(), ${actors.submitterId}, ${actors.submitterId}, ${actors.submitterId})
        returning id
      `)
    ).rows[0]!.id;
    const first = await seedPeriodRule(org);
    const second = await seedPeriodRule(org);

    const staged = new Set<string>();
    const commitStage = async (
      stageKey: string,
      effect: (tx: SqlExecutor) => Promise<void>,
    ): Promise<boolean> => {
      if (staged.has(stageKey)) return false;
      await effect(db);
      staged.add(stageKey);
      return true;
    };

    // Each rule sweeps for real; posting twice for one occurrence stays
    // refused by the one-posted-run guard, so the fan-out below posts each
    // rule exactly once.
    const previewed = await runAllocationCloseAction({
      orgId: org.orgId,
      runId,
      config: { ruleIds: [first.ruleId], post: false },
      commitStage,
    });
    assert.deepEqual(previewed, { previewed: 1, posted: 0 });
    assert.equal(await runStatusCount(org.orgId, first.ruleId, "previewed"), 1);
    assert.equal(await runStatusCount(org.orgId, first.ruleId, "posted"), 0);

    // Preview-only flows through when asked.
    const previewedSecond = await runAllocationCloseAction({
      orgId: org.orgId,
      runId,
      config: { ruleIds: [second.ruleId], post: false },
      commitStage,
    });
    assert.deepEqual(previewedSecond, { previewed: 1, posted: 0 });

    // 'all' with posting fans out in rule order; a resumed attempt adopts
    // committed stages instead of re-firing.
    staged.clear();
    const all = await runAllocationCloseAction({
      orgId: org.orgId,
      runId,
      config: { ruleIds: "all", post: true },
      commitStage,
    });
    assert.deepEqual(all, { previewed: 2, posted: 2 });
    assert.equal(await runStatusCount(org.orgId, first.ruleId, "posted"), 1);
    assert.equal(await runStatusCount(org.orgId, second.ruleId, "posted"), 1);
    // Close automation is unattended too: runs attribute to each rule's
    // publisher, not to the close initiator.
    const closeRequestedBy = (await db.execute<{ requested_by: string }>(sql`
      select requested_by from allocation_runs
       where org_id = ${org.orgId} and status = 'posted'`)).rows
      .map((row) => row.requested_by)
      .sort();
    assert.deepEqual(closeRequestedBy, [first.publishedBy, second.publishedBy].sort());
    // The close-automation reason lands in the audit log.
    const reasons = (await db.execute<{ reason: string | null }>(sql`
      select changes->>'reason' as reason from audit_log
       where org_id = ${org.orgId} and table_name = 'allocation_runs'
         and changes->>'mode' = 'allocation_run_post'`)).rows
      .map((audit) => audit.reason);
    assert.ok(reasons.some((reason) => reason?.match(/close automation/)));
    const resumed = await runAllocationCloseAction({
      orgId: org.orgId,
      runId,
      config: { ruleIds: "all", post: true },
      commitStage,
    });
    assert.deepEqual(resumed, { previewed: 0, posted: 0 });

    await assert.rejects(
      runAllocationCloseAction({
        orgId: org.orgId,
        runId,
          config: { ruleIds: [randomUUID()], post: false },
        commitStage,
      }),
      /not found/,
    );
    await enableAllocations(org.orgId, false);
    await assert.rejects(
      runAllocationCloseAction({
        orgId: org.orgId,
        runId,
          config: { ruleIds: "all", post: false },
        commitStage,
      }),
      /requires the allocations feature/,
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
