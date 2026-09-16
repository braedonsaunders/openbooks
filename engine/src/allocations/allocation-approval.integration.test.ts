import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { postProjectGlEntry } from "../project-recognition.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedApprovalFlow,
  seedFlowActors,
  type ScratchOrg,
} from "../test-fixtures.ts";
import { decideGate } from "../flows/gates.ts";
import { getFlowAdapter } from "../flows/registry.ts";
import { postAllocationRun, previewAllocationRun } from "./period-run.ts";
import { processAllocationRunOutboxRow } from "./scheduling.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

// ---------------------------------------------------------------------------
// A14 approval flows for period-mode allocation runs: a version with
// approval_flow_id posts ONLY after the flow approves. postAllocationRun
// opens the flow and waits in pending_approval (no journal); the flow
// engine's release posts (actor = approver) or records the rejection.
// ---------------------------------------------------------------------------

async function enableAllocations(orgId: string): Promise<void> {
  await db.execute(sql`
    update orgs set settings = jsonb_set(
      settings, '{features}',
      coalesce(settings->'features', '{}'::jsonb) || '{"allocations":true}'::jsonb, true)
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
  runPolicy?: string;
}): Promise<{ ruleId: string; versionId: string }> {
  const ruleId = randomUUID();
  const versionId = randomUUID();
  const key = `appr-${ruleId.slice(0, 8)}`;
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
       ${opts.runPolicy ?? "manual"}, 0, ${opts.approvalFlowId ?? null},
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
    entryNumber: `APPR-SEED-${randomUUID()}`,
    postingDate: org.date,
    memo: "Approval source pool",
    subsidiaryId: org.subsidiaryId,
    currency: "CAD",
    lines: [
      { accountId: org.accounts.adjustment, amount, departmentId: null },
      { accountId: org.accounts.bank, amount: amount.startsWith("-") ? amount.slice(1) : `-${amount}` },
    ],
  });
  assert.ok(entryId);
}

async function runRow(runId: string): Promise<{
  status: string;
  journalEntryId: string | null;
  flowRunId: string | null;
  error: string | null;
  requestedBy: string | null;
}> {
  const rows = (await db.execute<{
    status: string;
    journal_entry_id: string | null;
    flow_run_id: string | null;
    error: string | null;
    requested_by: string | null;
  }>(sql`
    select status, journal_entry_id, flow_run_id::text, error, requested_by::text as requested_by
      from allocation_runs where id = ${runId}`)).rows;
  const row = rows[0];
  assert.ok(row);
  return {
    status: row.status,
    journalEntryId: row.journal_entry_id,
    flowRunId: row.flow_run_id,
    error: row.error,
    requestedBy: row.requested_by,
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

async function pendingGateForRun(runId: string): Promise<{ id: string; assigneeUserId: string } | null> {
  const rows = (await db.execute<{ id: string; assigneeUserId: string }>(sql`
    select id, assignee_user_id as "assigneeUserId" from flow_gates
     where subject_kind = 'allocation_run' and subject_id = ${runId} and status = 'pending'`)).rows;
  return rows[0] ?? null;
}

async function journalCreator(entryId: string): Promise<string | null> {
  const rows = (await db.execute<{ created_by: string | null }>(sql`
    select created_by::text from journal_entries where id = ${entryId}`)).rows;
  return rows[0]?.created_by ?? null;
}

test("allocation_run is a registered flow subject with no writable fields", { skip: !DB }, async () => {
  const adapter = getFlowAdapter("allocation_run");
  assert.ok(adapter);
  assert.equal(adapter.subjectKind, "allocation_run");
  assert.equal(adapter.writableFields.size, 0);
});

test("post with an approval flow opens the flow and waits — no journal", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const actors = await seedFlowActors(org.orgId);
  try {
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
    const linesBefore = await journalLineCount(org.orgId);
    const preview = await previewAllocationRun({
      orgId: org.orgId,
      ruleId,
      periodId: org.periodId,
      bookId: org.bookId,
      actorId: actors.submitterId,
      trigger: "manual",
    });
    const opened = await postAllocationRun(preview.id, actors.submitterId, "Please approve the sweep");
    assert.equal(opened.status, "pending_approval");
    assert.ok(opened.flowRunId);
    const row = await runRow(preview.id);
    assert.equal(row.status, "pending_approval");
    assert.equal(row.flowRunId, opened.flowRunId);
    assert.equal(row.journalEntryId, null);
    assert.equal(row.requestedBy, actors.submitterId);
    assert.equal(await journalLineCount(org.orgId), linesBefore);
    assert.equal(await lineageCount(org.orgId, preview.id), 0);
    const gate = await pendingGateForRun(preview.id);
    assert.ok(gate);
    assert.equal(gate.assigneeUserId, actors.approver1Id);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("flow approval posts the run with journal + lineage as the approver", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const actors = await seedFlowActors(org.orgId);
  try {
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
    await decideGate({ gateId: gate.id, decision: "approved", userId: actors.approver1Id });
    const row = await runRow(preview.id);
    assert.equal(row.status, "posted");
    assert.ok(row.journalEntryId);
    assert.equal(await journalCreator(row.journalEntryId!), actors.approver1Id);
    assert.ok((await lineageCount(org.orgId, preview.id)) > 0);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("flow rejection records failure with no journal and untouched lineage", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const actors = await seedFlowActors(org.orgId);
  try {
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
    const linesBefore = await journalLineCount(org.orgId);
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
    await decideGate({
      gateId: gate.id,
      decision: "rejected",
      userId: actors.approver1Id,
      comment: "Wrong period",
    });
    const row = await runRow(preview.id);
    assert.equal(row.status, "failed");
    assert.ok(row.error?.startsWith("rejected:"));
    assert.equal(row.journalEntryId, null);
    assert.equal(await journalLineCount(org.orgId), linesBefore);
    assert.equal(await lineageCount(org.orgId, preview.id), 0);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("scheduler auto_post with a flow waits in pending_approval, never posts", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const actors = await seedFlowActors(org.orgId);
  try {
    await enableAllocations(org.orgId);
    const { flowId } = await seedApprovalFlow(org.orgId, {
      subjectKind: "allocation_run",
      assignees: [{ type: "user", userId: actors.approver1Id }],
      mode: "any",
    });
    await seedSourceEntry(org, actors.adminId, "500.0000");
    const { ruleId } = await seedPeriodRule({
      org,
      publisherId: actors.adminId,
      poolAccountId: org.accounts.adjustment,
      approvalFlowId: flowId,
      runPolicy: "auto_post",
    });
    const outcome = await processAllocationRunOutboxRow({
      id: randomUUID(),
      org_id: org.orgId,
      payload: { ruleId, periodId: org.periodId, bookId: org.bookId },
    });
    assert.equal(outcome.outcome, "ran");
    const posted = (await db.execute<{ count: string }>(sql`
      select count(*)::text as count from allocation_runs
       where org_id = ${org.orgId} and rule_id = ${ruleId} and status = 'posted'`)).rows;
    assert.equal(Number(posted[0]?.count ?? 0), 0);
    const waiting = (await db.execute<{ id: string }>(sql`
      select id from allocation_runs
       where org_id = ${org.orgId} and rule_id = ${ruleId} and status = 'pending_approval'`)).rows;
    assert.equal(waiting.length, 1);
    assert.ok(await pendingGateForRun(waiting[0]!.id));
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("version without a flow posts directly — behaviour unchanged", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const actors = await seedFlowActors(org.orgId);
  try {
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
    assert.equal(posted.flowRunId, null);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("misconfigured approval flow fails closed — the run stays previewed", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const actors = await seedFlowActors(org.orgId);
  try {
    await seedSourceEntry(org, actors.adminId, "1000.0000");
    const { ruleId } = await seedPeriodRule({
      org,
      publisherId: actors.adminId,
      poolAccountId: org.accounts.adjustment,
      approvalFlowId: randomUUID(),
    });
    const preview = await previewAllocationRun({
      orgId: org.orgId,
      ruleId,
      periodId: org.periodId,
      bookId: org.bookId,
      actorId: actors.submitterId,
      trigger: "manual",
    });
    await assert.rejects(
      postAllocationRun(preview.id, actors.submitterId, "Please approve the sweep"),
      /approval flow/,
    );
    assert.equal((await runRow(preview.id)).status, "previewed");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a period closed after approval was requested refuses at approval time", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const actors = await seedFlowActors(org.orgId);
  try {
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
    await db.execute(sql`
      insert into period_locks (org_id, period_id, book_id, subsidiary_id, module, state, locked_at, reason)
      values (${org.orgId}, ${org.periodId}, ${org.bookId}, null, 'gl', 'closed', now(),
              'approval-time close must refuse the posting')`);
    const decided = await decideGate({ gateId: gate.id, decision: "approved", userId: actors.approver1Id });
    assert.equal(decided.runStatus, "failed");
    const row = await runRow(preview.id);
    assert.equal(row.journalEntryId, null);
    assert.equal(await lineageCount(org.orgId, preview.id), 0);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
