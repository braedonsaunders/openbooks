import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, pool } from "../platform/db.ts";
import { postProjectGlEntry } from "../projects/recognition.ts";
import { featureGateLockKey } from "../organization/org-feature-lock.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedApprovalFlow,
  seedFlowActors,
  type ScratchOrg,
} from "../testing/fixtures.ts";
import { decideGate, DecisionFailedError } from "../flows/gates.ts";
import {
  postAllocationRun,
  previewAllocationRun,
  rerunAllocationRun,
  reverseAllocationRun,
} from "./period-run.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

// ---------------------------------------------------------------------------
// A1 allocations feature fence: preview/submit while the switch is ON, turn
// it OFF in Company Settings → Features, and the authoritative posting
// transaction must refuse by name with zero writes — including the approval
// engine's release, which must leave the run pending (retryable) instead of
// recording a successful release.
// ---------------------------------------------------------------------------

async function setAllocations(orgId: string, on: boolean): Promise<void> {
  await db.execute(sql`
    update orgs set settings = jsonb_set(
      settings, '{features}',
      coalesce(settings->'features', '{}'::jsonb) || ${JSON.stringify({ allocations: on })}::jsonb, true)
    where id = ${orgId}
  `);
}

async function seedDepartment(orgId: string, name: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into departments (id, org_id, name, is_active, custom)
    values (${id}, ${orgId}, ${name}, true, '{}'::jsonb)`);
  return id;
}

async function seedPeriodRule(opts: {
  org: ScratchOrg;
  publisherId: string;
  poolAccountId: string;
  approvalFlowId?: string | null;
}): Promise<{ ruleId: string; versionId: string }> {
  const ruleId = randomUUID();
  const versionId = randomUUID();
  const key = `fence-${ruleId.slice(0, 8)}`;
  await db.execute(sql`
    insert into allocation_rules (id, org_id, key, name, mode, sort_order, is_active, is_system, custom)
    values (${ruleId}, ${opts.org.orgId}, ${key}, ${`Rule ${key}`}, 'period', 100, true, false, '{}'::jsonb)`);
  await db.execute(sql`
    insert into allocation_rule_versions
      (id, org_id, rule_id, version_no, status, effective_from, effective_to,
       book_scope, book_ids, account_scope, dimension_filters, source_measure,
       basis_kind, driver_id, driver_as_of, basis_config,
       target_kind, dynamic_target, impact, residual_policy, solve_method,
       run_policy, run_offset_days, approval_flow_id, memo_template, published_at, published_by)
    values (${versionId}, ${opts.org.orgId}, ${ruleId}, 1, 'draft', '2026-01-01', null,
       'primary', '[]'::jsonb,
       ${JSON.stringify({ kind: "accounts", accountIds: [opts.poolAccountId] })}::jsonb,
       '{}'::jsonb, 'period_activity',
       'fixed_percent', null, 'period', '{}'::jsonb,
       'explicit', '{}'::jsonb, 'reclass', 'largest_share', 'sequential',
       'manual', 0, ${opts.approvalFlowId ?? null},
       'Allocation {{rule.name}} for {{period.name}}', now(), ${opts.publisherId})`);
  const deptA = await seedDepartment(opts.org.orgId, `A-${ruleId.slice(0, 4)}`);
  const deptB = await seedDepartment(opts.org.orgId, `B-${ruleId.slice(0, 4)}`);
  let sequence = 1;
  for (const [dept, percent] of [[deptA, "60.0000"], [deptB, "40.0000"]] as const) {
    await db.execute(sql`
      insert into allocation_rule_targets
        (id, org_id, version_id, sequence, target_account_id, department_id,
         fixed_percent, weight, is_remainder, label, custom)
      values (${randomUUID()}, ${opts.org.orgId}, ${versionId}, ${sequence},
              null, ${dept}, ${percent}, null, false, ${`Dept ${sequence}`}, '{}'::jsonb)`);
    sequence += 1;
  }
  await db.execute(sql`
    update allocation_rule_versions
       set status = 'published', definition_hash = ${`testhash-${versionId}`}
     where id = ${versionId} and org_id = ${opts.org.orgId}`);
  await db.execute(sql`
    update allocation_rules set current_version_id = ${versionId}
     where id = ${ruleId} and org_id = ${opts.org.orgId}`);
  return { ruleId, versionId };
}

/** One balanced source entry: DR pool account / CR bank. */
async function seedSourceEntry(org: ScratchOrg, actorId: string, amount: string): Promise<void> {
  const entryId = await postProjectGlEntry({
    orgId: org.orgId,
    actorId,
    origin: "manual",
    entryNumber: `FENCE-SEED-${randomUUID()}`,
    postingDate: org.date,
    memo: "Fence source pool",
    subsidiaryId: org.subsidiaryId,
    currency: "CAD",
    lines: [
      { accountId: org.accounts.adjustment, amount },
      { accountId: org.accounts.bank, amount: amount.startsWith("-") ? amount.slice(1) : `-${amount}` },
    ],
  });
  assert.ok(entryId);
}

async function runRow(runId: string): Promise<{
  status: string;
  journalEntryId: string | null;
  reversalEntryId: string | null;
  flowRunId: string | null;
  error: string | null;
}> {
  const rows = (await db.execute<{
    status: string;
    journal_entry_id: string | null;
    reversal_entry_id: string | null;
    flow_run_id: string | null;
    error: string | null;
  }>(sql`
    select status, journal_entry_id, reversal_entry_id, flow_run_id::text, error
      from allocation_runs where id = ${runId}`)).rows;
  const row = rows[0];
  assert.ok(row);
  return {
    status: row.status,
    journalEntryId: row.journal_entry_id,
    reversalEntryId: row.reversal_entry_id,
    flowRunId: row.flow_run_id,
    error: row.error,
  };
}

async function journalLineCount(orgId: string): Promise<number> {
  const rows = (await db.execute<{ count: string }>(sql`
    select count(*)::text as count from journal_lines where org_id = ${orgId}`)).rows;
  return Number(rows[0]?.count ?? 0);
}

async function lineageCount(orgId: string, runId: string): Promise<number> {
  const rows = (await db.execute<{ count: string }>(sql`
    select count(*)::text as count from allocation_lineage
     where org_id = ${orgId} and run_id = ${runId}`)).rows;
  return Number(rows[0]?.count ?? 0);
}

async function pendingGateForRun(runId: string): Promise<{ id: string } | null> {
  const rows = (await db.execute<{ id: string }>(sql`
    select id from flow_gates
     where subject_kind = 'allocation_run' and subject_id = ${runId} and status = 'pending'`)).rows;
  return rows[0] ?? null;
}

test("direct post with the feature off is refused by name with zero writes", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const actors = await seedFlowActors(org.orgId);
  try {
    await setAllocations(org.orgId, true);
    await seedSourceEntry(org, actors.adminId, "1000.0000");
    const { ruleId } = await seedPeriodRule({
      org,
      publisherId: actors.adminId,
      poolAccountId: org.accounts.adjustment,
    });
    const preview = await previewAllocationRun({
      orgId: org.orgId,
      ruleId,
      periodId: org.periodId,
      bookId: org.bookId,
      actorId: actors.submitterId,
      trigger: "manual",
    });
    // The switch flips after preview: the authoritative transaction refuses.
    await setAllocations(org.orgId, false);
    const linesBefore = await journalLineCount(org.orgId);
    await assert.rejects(
      postAllocationRun(preview.id, actors.submitterId, "Post monthly cost sweep"),
      (e: unknown) => {
        assert.ok(e instanceof Error, `expected an Error, got ${String(e)}`);
        assert.match(e.message, /Allocations are turned off for this organization/);
        assert.match(e.message, /Company Settings → Features/);
        assert.match(e.message, /to post this run/);
        return true;
      },
      "posting with the feature off must refuse by name",
    );
    const row = await runRow(preview.id);
    assert.equal(row.status, "previewed");
    assert.equal(row.journalEntryId, null);
    assert.equal(row.flowRunId, null);
    assert.equal(await journalLineCount(org.orgId), linesBefore);
    assert.equal(await lineageCount(org.orgId, preview.id), 0);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("posting with the feature on is unchanged", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const actors = await seedFlowActors(org.orgId);
  try {
    await setAllocations(org.orgId, true);
    await seedSourceEntry(org, actors.adminId, "1000.0000");
    const { ruleId } = await seedPeriodRule({
      org,
      publisherId: actors.adminId,
      poolAccountId: org.accounts.adjustment,
    });
    const preview = await previewAllocationRun({
      orgId: org.orgId,
      ruleId,
      periodId: org.periodId,
      bookId: org.bookId,
      actorId: actors.submitterId,
      trigger: "manual",
    });
    const posted = await postAllocationRun(preview.id, actors.submitterId, "Post monthly cost sweep");
    assert.equal(posted.status, "posted");
    assert.ok(posted.journalEntryId);
    assert.ok((await lineageCount(org.orgId, preview.id)) > 0);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("approval after a disable refuses without recording: run stays pending, gate stays pending", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const actors = await seedFlowActors(org.orgId);
  try {
    await setAllocations(org.orgId, true);
    const { flowId } = await seedApprovalFlow(org.orgId, {
      subjectKind: "allocation_run",
      assignees: [{ type: "user", userId: actors.approver1Id }],
      mode: "any",
    });
    await seedSourceEntry(org, actors.adminId, "1000.0000");
    const { ruleId } = await seedPeriodRule({
      org,
      publisherId: actors.adminId,
      poolAccountId: org.accounts.adjustment,
      approvalFlowId: flowId,
    });
    const preview = await previewAllocationRun({
      orgId: org.orgId,
      ruleId,
      periodId: org.periodId,
      bookId: org.bookId,
      actorId: actors.submitterId,
      trigger: "manual",
    });
    await postAllocationRun(preview.id, actors.submitterId, "Please approve the sweep");
    const gate = await pendingGateForRun(preview.id);
    assert.ok(gate);
    // The switch flips while the approval is pending: the release refuses.
    await setAllocations(org.orgId, false);
    const linesBefore = await journalLineCount(org.orgId);
    await assert.rejects(
      decideGate({ gateId: gate.id, decision: "approved", userId: actors.approver1Id }),
      (e: unknown) => {
        assert.ok(e instanceof DecisionFailedError, `expected DecisionFailedError, got ${String(e)}`);
        assert.match(e.message, /Allocations are turned off for this organization/);
        assert.match(e.message, /was not recorded/);
        return true;
      },
      "approving a run whose feature was disabled must not record the release",
    );
    // Nothing recorded, nothing posted: the run waits in pending_approval
    // with its gate still pending, so re-enabling and retrying can land it.
    const stillPending = await pendingGateForRun(preview.id);
    assert.ok(stillPending, "the gate stays pending so the decision can be retried");
    assert.equal(stillPending.id, gate.id);
    const row = await runRow(preview.id);
    assert.equal(row.status, "pending_approval");
    assert.equal(row.journalEntryId, null);
    assert.equal(await journalLineCount(org.orgId), linesBefore);
    assert.equal(await lineageCount(org.orgId, preview.id), 0);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("reverse with the feature off is refused, the posted run stands", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const actors = await seedFlowActors(org.orgId);
  try {
    await setAllocations(org.orgId, true);
    await seedSourceEntry(org, actors.adminId, "1000.0000");
    const { ruleId } = await seedPeriodRule({
      org,
      publisherId: actors.adminId,
      poolAccountId: org.accounts.adjustment,
    });
    const preview = await previewAllocationRun({
      orgId: org.orgId,
      ruleId,
      periodId: org.periodId,
      bookId: org.bookId,
      actorId: actors.submitterId,
      trigger: "manual",
    });
    await postAllocationRun(preview.id, actors.submitterId, "Post monthly cost sweep");
    await setAllocations(org.orgId, false);
    const linesBefore = await journalLineCount(org.orgId);
    await assert.rejects(
      reverseAllocationRun(preview.id, actors.submitterId, "Unwind the sweep", {
        reversalDate: org.date,
      }),
      /Allocations are turned off for this organization.*to reverse this run/,
      "reversing with the feature off must refuse by name",
    );
    const row = await runRow(preview.id);
    assert.equal(row.status, "posted");
    assert.equal(row.reversalEntryId, null);
    assert.equal(await journalLineCount(org.orgId), linesBefore);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("re-run with the feature off is refused, the posted run stands", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const actors = await seedFlowActors(org.orgId);
  try {
    await setAllocations(org.orgId, true);
    await seedSourceEntry(org, actors.adminId, "1000.0000");
    const { ruleId } = await seedPeriodRule({
      org,
      publisherId: actors.adminId,
      poolAccountId: org.accounts.adjustment,
    });
    const preview = await previewAllocationRun({
      orgId: org.orgId,
      ruleId,
      periodId: org.periodId,
      bookId: org.bookId,
      actorId: actors.submitterId,
      trigger: "manual",
    });
    await postAllocationRun(preview.id, actors.submitterId, "Post monthly cost sweep");
    await setAllocations(org.orgId, false);
    await assert.rejects(
      rerunAllocationRun(preview.id, actors.submitterId, "Re-run after late activity", {
        reversalDate: org.date,
      }),
      /Allocations are turned off for this organization.*to re-run this run/,
      "re-running with the feature off must refuse by name",
    );
    const row = await runRow(preview.id);
    assert.equal(row.status, "posted");
    assert.ok(row.journalEntryId);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a disable racing a post serializes on the fence: the post sees the final state", { skip: !DB }, async () => {
  // The disabler holds the per-org feature-gate advisory lock (exactly as
  // the Features toggle transaction does) with its flag write uncommitted.
  // A fenced post must block on that lock instead of slipping through, then
  // refuse once the disable commits — the outcome is always ordered, never
  // both applied.
  const org = await createScratchOrg();
  const actors = await seedFlowActors(org.orgId);
  const disabler = await pool.connect();
  try {
    await setAllocations(org.orgId, true);
    await seedSourceEntry(org, actors.adminId, "1000.0000");
    const { ruleId } = await seedPeriodRule({
      org,
      publisherId: actors.adminId,
      poolAccountId: org.accounts.adjustment,
    });
    const preview = await previewAllocationRun({
      orgId: org.orgId,
      ruleId,
      periodId: org.periodId,
      bookId: org.bookId,
      actorId: actors.submitterId,
      trigger: "manual",
    });
    const linesBefore = await journalLineCount(org.orgId);
    await disabler.query("begin");
    await disabler.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
      featureGateLockKey(org.orgId),
    ]);
    await disabler.query(
      `update orgs set settings = jsonb_set(
         settings, '{features}',
         coalesce(settings->'features', '{}'::jsonb) || '{"allocations":false}'::jsonb, true)
       where id = $1`,
      [org.orgId],
    );
    const attempt = postAllocationRun(preview.id, actors.submitterId, "Racing post");
    const settled = Promise.allSettled([attempt]);
    let sightings = 0;
    for (let i = 0; i < 200; i += 1) {
      const waiting = await db.execute<{ n: number }>(sql`select count(*)::int as n
        from pg_stat_activity
       where datname = current_database()
         and pid <> pg_backend_pid()
         and wait_event_type = 'Lock'
         and wait_event = 'advisory'`);
      if (waiting.rows[0]!.n > 0) sightings += 1;
      if (sightings >= 3) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(sightings >= 3, "the racing post must wait on the disable's fence");
    await disabler.query("commit");
    const [result] = await settled;
    assert.equal(result!.status, "rejected", "the post must refuse once the disable commits");
    assert.match(
      String((result as PromiseRejectedResult).reason?.message ?? result),
      /Allocations are turned off for this organization/,
    );
    const row = await runRow(preview.id);
    assert.equal(row.status, "previewed");
    assert.equal(row.journalEntryId, null);
    assert.equal(await journalLineCount(org.orgId), linesBefore);
  } finally {
    try {
      await disabler.query("rollback");
    } catch {
      // Already committed above; the rollback only guards the failure path.
    }
    disabler.release();
    await dropScratchOrg(org.orgId);
  }
});
