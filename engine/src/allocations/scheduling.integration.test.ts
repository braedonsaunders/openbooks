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
import {
  ALLOCATION_RUN_OUTBOX_KIND,
  allocationRunOccurrenceKey,
  ensureAllocationRunOutboxRows,
  processAllocationRunOutboxRow,
  runAllocationCloseAction,
} from "./scheduling.ts";
import type {
  PeriodRunEngine,
  PostRunInput,
  PreviewRunInput,
} from "./a8-shims.ts";
import type { RunComputation } from "./types.ts";

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
  overrides: { runPolicy?: string; status?: string; isActive?: boolean; mode?: string } = {},
): Promise<{ ruleId: string; versionId: string }> {
  const rule = (
    await db.execute<{ id: string }>(sql`
      insert into allocation_rules (org_id, key, name, mode, is_active)
      values (${org.orgId}, ${`sched-${randomUUID().slice(0, 8)}`}, 'Scheduled rule', ${overrides.mode ?? "period"}, ${overrides.isActive ?? true})
      returning id
    `)
  ).rows[0]!;
  const version = (
    await db.execute<{ id: string }>(sql`
      insert into allocation_rule_versions
        (org_id, rule_id, version_no, status, effective_from, definition_hash,
         run_policy, run_offset_days, book_scope, book_ids)
      values (${org.orgId}, ${rule.id}, 1, ${overrides.status ?? "published"}, '2026-01-01', 'sched',
              ${overrides.runPolicy ?? "auto_preview"}, 0, 'books', ${JSON.stringify([org.bookId])}::jsonb)
      returning id
    `)
  ).rows[0]!;
  await db.execute(sql`
    update allocation_rules set current_version_id = ${version.id} where id = ${rule.id}
  `);
  return { ruleId: rule.id, versionId: version.id };
}

function fakeEngine(calls: { preview: PreviewRunInput[]; post: PostRunInput[] }): PeriodRunEngine {
  return {
    // Stands in for A3's previewAllocationRun: computes (a fixed source
    // total) and persists the previewed run the post step resolves.
    preview: async (input) => {
      calls.preview.push(input);
      const version = (
        await db.execute<{ current_version_id: string }>(sql`
          select current_version_id from allocation_rules where id = ${input.ruleId}
        `)
      ).rows[0]!;
      await db.execute(sql`
        insert into allocation_runs (org_id, rule_id, version_id, definition_hash, period_id, book_id, status)
        values (${input.orgId}, ${input.ruleId}, ${version.current_version_id}, 'fake',
                ${input.periodId}, ${input.bookId}, 'previewed')
      `);
      return { ruleId: input.ruleId, sourceTotal: "7.50" } as unknown as RunComputation;
    },
    post: async (input) => {
      calls.post.push(input);
      return { runId: input.runId, journalEntryId: null };
    },
    reverse: async () => {
      throw new Error("scheduling never reverses");
    },
    rerun: async () => {
      throw new Error("scheduling never reruns");
    },
  };
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

test("processing previews and posts through the injected engine", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await enableAllocations(org.orgId);
    const { ruleId } = await seedPeriodRule(org, { runPolicy: "auto_post" });
    assert.equal(await ensureAllocationRunOutboxRows(), 1);
    const row = (await outboxRows(org.orgId))[0]!;

    const calls = { preview: [] as PreviewRunInput[], post: [] as PostRunInput[] };
    const result = await processAllocationRunOutboxRow(row, fakeEngine(calls));
    assert.deepEqual(result, { outcome: "ran", note: "previewed and posted (source 7.50)" });
    assert.equal(calls.preview.length, 1);
    assert.deepEqual(
      {
        ruleId: calls.preview[0]!.ruleId,
        periodId: calls.preview[0]!.periodId,
        bookId: calls.preview[0]!.bookId,
        triggerKind: calls.preview[0]!.triggerKind,
        subsidiaryId: calls.preview[0]!.subsidiaryId,
      },
      { ruleId, periodId: org.periodId, bookId: org.bookId, triggerKind: "scheduled", subsidiaryId: null },
    );
    assert.equal(calls.post.length, 1);
    // Posting addresses the persisted preview, not the occurrence: the
    // posted run id is the previewed row the fake just wrote.
    const previewedId = (
      await db.execute<{ id: string }>(sql`
        select id from allocation_runs
         where org_id = ${org.orgId} and rule_id = ${ruleId}
           and period_id = ${org.periodId} and book_id = ${org.bookId} and status = 'previewed'
         order by created_at desc limit 1
      `)
    ).rows[0]!.id;
    assert.equal(calls.post[0]!.runId, previewedId);
    assert.match(calls.post[0]!.reason, /auto_post/);

    // auto_preview fires preview only.
    await db.execute(sql`
      update allocation_rule_versions set run_policy = 'auto_preview'
       where org_id = ${org.orgId} and rule_id = ${ruleId}
    `);
    const again = await processAllocationRunOutboxRow(row, fakeEngine(calls));
    assert.deepEqual(again, { outcome: "ran", note: "previewed (source 7.50)" });
    assert.equal(calls.preview.length, 2);
    assert.equal(calls.post.length, 1);

    // Feature off ⇒ the engine is never touched.
    await enableAllocations(org.orgId, false);
    const skipped = await processAllocationRunOutboxRow(row, fakeEngine(calls));
    assert.deepEqual(skipped, { outcome: "skipped", note: "allocations feature is off" });
    assert.equal(calls.preview.length, 2);
    await enableAllocations(org.orgId, true);

    // A retired rule skips quietly: the schedule legitimately went away.
    await db.execute(sql`
      update allocation_rule_versions set status = 'retired'
       where org_id = ${org.orgId} and rule_id = ${ruleId}
    `);
    const retired = await processAllocationRunOutboxRow(row, fakeEngine(calls));
    assert.equal(retired.outcome, "skipped");
    assert.equal(calls.preview.length, 2);

    await assert.rejects(
      processAllocationRunOutboxRow({ id: row.id, org_id: org.orgId, payload: {} }, fakeEngine(calls)),
      /ruleId, periodId, and bookId/,
    );
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

    const calls = { preview: [] as PreviewRunInput[], post: [] as PostRunInput[] };
    const engine = fakeEngine(calls);
    const previewed = await runAllocationCloseAction({
      orgId: org.orgId,
      runId,
      actorId: actors.submitterId,
      config: { ruleIds: [first.ruleId], post: false },
      commitStage,
      runner: engine,
    });
    assert.deepEqual(previewed, { previewed: 1, posted: 0 });
    assert.equal(calls.preview.length, 1);
    assert.equal(calls.preview[0]!.triggerKind, "close_automation");
    assert.equal(calls.preview[0]!.periodId, org.periodId);
    assert.equal(calls.post.length, 0);

    // Posting flows through when asked.
    const posted = await runAllocationCloseAction({
      orgId: org.orgId,
      runId,
      actorId: actors.submitterId,
      config: { ruleIds: [second.ruleId], post: true },
      commitStage,
      runner: engine,
    });
    assert.deepEqual(posted, { previewed: 1, posted: 1 });
    assert.equal(calls.post.length, 1);
    assert.match(calls.post[0]!.reason, /close automation/);

    // 'all' fans out in rule order; a resumed attempt adopts committed
    // stages instead of re-firing.
    staged.clear();
    const all = await runAllocationCloseAction({
      orgId: org.orgId,
      runId,
      actorId: actors.submitterId,
      config: { ruleIds: "all", post: true },
      commitStage,
      runner: engine,
    });
    assert.deepEqual(all, { previewed: 2, posted: 2 });
    const resumed = await runAllocationCloseAction({
      orgId: org.orgId,
      runId,
      actorId: actors.submitterId,
      config: { ruleIds: "all", post: true },
      commitStage,
      runner: engine,
    });
    assert.deepEqual(resumed, { previewed: 0, posted: 0 });

    await assert.rejects(
      runAllocationCloseAction({
        orgId: org.orgId,
        runId,
        actorId: actors.submitterId,
        config: { ruleIds: [randomUUID()], post: false },
        commitStage,
        runner: engine,
      }),
      /not found/,
    );
    await enableAllocations(org.orgId, false);
    await assert.rejects(
      runAllocationCloseAction({
        orgId: org.orgId,
        runId,
        actorId: actors.submitterId,
        config: { ruleIds: "all", post: false },
        commitStage,
        runner: engine,
      }),
      /requires the allocations feature/,
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
