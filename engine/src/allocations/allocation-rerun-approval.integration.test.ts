import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { postProjectGlEntry } from "../projects/recognition.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedApprovalFlow,
  seedFlowActors,
  type ScratchOrg,
} from "../testing/fixtures.ts";
import { decideGate } from "../flows/gates.ts";
import { postAllocationRun, previewAllocationRun, rerunAllocationRun } from "./period-run.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

// ---------------------------------------------------------------------------
// A3 approval-governed rerun: the old posted run stays effective while its
// replacement waits in pending_approval. Approval reverses the old run and
// posts the replacement atomically; rejection leaves the old run posted and
// untouched. Non-approval reruns keep the immediate reverse+post.
// ---------------------------------------------------------------------------

async function enableAllocations(orgId: string): Promise<void> {
  await db.execute(sql`
    update orgs set settings = jsonb_set(
      settings, '{features}',
      coalesce(settings->'features', '{}'::jsonb) || '{"allocations":true}'::jsonb, true)
    where id = ${orgId}
  `);
}

/**
 * The approval-time swap reverses as of today (real clock): the scratch org
 * opens July 2026 only, so open a regular period covering today for the
 * reversal to land in.
 */
async function seedTodayPeriod(org: ScratchOrg): Promise<void> {
  const cal = (await db.execute<{ fiscal_calendar_id: string }>(sql`
    select fiscal_calendar_id from accounting_periods where id = ${org.periodId}`)).rows[0]!
    .fiscal_calendar_id;
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  const pad = (n: number): string => String(n).padStart(2, "0");
  const lastDay = new Date(y, m, 0).getDate();
  const name = `${y}-${pad(m)}`;
  // Idempotent when today falls in the scratch org's own month: the
  // (calendar, year, number) conflict means the period already exists.
  await db.execute(sql`
    insert into accounting_periods
      (id, org_id, fiscal_calendar_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment)
    values (${randomUUID()}, ${org.orgId}, ${cal}, ${y}, ${m}, ${name},
            ${`${name}-01`}, ${`${name}-${pad(lastDay)}`}, false)
    on conflict (org_id, fiscal_calendar_id, fiscal_year, period_number) do nothing`);
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
  approvalFlowId: string;
}): Promise<{ ruleId: string; versionId: string; deptA: string; deptB: string }> {
  const ruleId = randomUUID();
  const versionId = randomUUID();
  const key = `rr-${ruleId.slice(0, 8)}`;
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
       'manual', 0, ${opts.approvalFlowId},
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
  return { ruleId, versionId, deptA, deptB };
}

/** Balanced source entry: DR pool account / CR bank. */
async function seedSourceEntry(org: ScratchOrg, actorId: string, amount: string): Promise<void> {
  const entryId = await postProjectGlEntry({
    orgId: org.orgId,
    actorId,
    origin: "manual",
    entryNumber: `RR-SEED-${randomUUID()}`,
    postingDate: org.date,
    memo: "Rerun source pool",
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
  reversesRunId: string | null;
  supersededByRunId: string | null;
  error: string | null;
}> {
  const rows = (await db.execute<{
    status: string;
    journal_entry_id: string | null;
    reversal_entry_id: string | null;
    reverses_run_id: string | null;
    superseded_by_run_id: string | null;
    error: string | null;
  }>(sql`
    select status, journal_entry_id, reversal_entry_id,
           reverses_run_id::text, superseded_by_run_id::text, error
      from allocation_runs where id = ${runId}`)).rows;
  const row = rows[0];
  assert.ok(row);
  return {
    status: row.status,
    journalEntryId: row.journal_entry_id,
    reversalEntryId: row.reversal_entry_id,
    reversesRunId: row.reverses_run_id,
    supersededByRunId: row.superseded_by_run_id,
    error: row.error,
  };
}

async function pendingGateForRun(runId: string): Promise<{ id: string } | null> {
  const rows = (await db.execute<{ id: string }>(sql`
    select id from flow_gates
     where subject_kind = 'allocation_run' and subject_id = ${runId} and status = 'pending'`)).rows;
  return rows[0] ?? null;
}

/** Pool-account balances per department (null = unattributed). */
async function deptTotals(orgId: string, accountId: string): Promise<Map<string | null, string>> {
  const rows = (await db.execute<{ department_id: string | null; total: string }>(sql`
    select l.department_id, sum(l.amount)::text as total
      from journal_lines l join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
     where l.org_id = ${orgId} and l.account_id = ${accountId}
       and e.status in ('posted', 'reversed')
     group by l.department_id`)).rows;
  return new Map(rows.map((row) => [row.department_id, row.total]));
}

test("an approval-governed rerun leaves the posted run effective while the replacement waits", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const actors = await seedFlowActors(org.orgId);
  try {
    await enableAllocations(org.orgId);
    await seedTodayPeriod(org);
    const { flowId } = await seedApprovalFlow(org.orgId, {
      subjectKind: "allocation_run",
      assignees: [{ type: "user", userId: actors.approver1Id }],
      mode: "any",
    });
    await seedSourceEntry(org, actors.adminId, "1000.0000");
    const { ruleId, deptA, deptB } = await seedPeriodRule({
      org,
      publisherId: actors.adminId,
      poolAccountId: org.accounts.adjustment,
      approvalFlowId: flowId,
    });
    const first = await previewAllocationRun({
      orgId: org.orgId,
      ruleId,
      periodId: org.periodId,
      bookId: org.bookId,
      actorId: actors.submitterId,
      trigger: "manual",
    });
    await postAllocationRun(first.id, actors.submitterId, "Please approve the sweep");
    const firstGate = await pendingGateForRun(first.id);
    assert.ok(firstGate);
    await decideGate({ gateId: firstGate.id, decision: "approved", userId: actors.approver1Id });
    assert.equal((await runRow(first.id)).status, "posted");
    // New source arrives after posting: the correction needs approval too.
    await seedSourceEntry(org, actors.adminId, "500.0000");
    const rerun = await rerunAllocationRun(first.id, actors.submitterId, "Re-run after late activity", {
      reversalDate: org.date,
    });
    assert.equal(rerun.idempotent, false);
    assert.equal(rerun.run.status, "pending_approval");
    assert.equal(rerun.run.reversesRunId, first.id);
    // The old run stands: still posted, journal intact, no reversal — and
    // the GL still carries its allocation (600/400 on the 1000 pool), not a
    // gap. The extra 500 waits unattributed until approval.
    const old = await runRow(first.id);
    assert.equal(old.status, "posted");
    assert.ok(old.journalEntryId);
    assert.equal(old.reversalEntryId, null);
    assert.equal(old.supersededByRunId, null);
    const fresh = await runRow(rerun.run.id);
    assert.equal(fresh.status, "pending_approval");
    assert.equal(fresh.journalEntryId, null);
    assert.equal(fresh.reversesRunId, first.id);
    const waiting = await deptTotals(org.orgId, org.accounts.adjustment);
    assert.equal(waiting.get(deptA), "600.0000");
    assert.equal(waiting.get(deptB), "400.0000");
    assert.equal(waiting.get(null), "500.0000");
    // Approval swaps atomically: the old run reverses and the replacement
    // posts in one transaction — the pool reprices to 900/600.
    const swapGate = await pendingGateForRun(rerun.run.id);
    assert.ok(swapGate);
    await decideGate({ gateId: swapGate.id, decision: "approved", userId: actors.approver1Id });
    const swappedOld = await runRow(first.id);
    assert.equal(swappedOld.status, "reversed");
    assert.ok(swappedOld.reversalEntryId);
    assert.equal(swappedOld.supersededByRunId, rerun.run.id);
    const swappedFresh = await runRow(rerun.run.id);
    assert.equal(swappedFresh.status, "posted");
    assert.ok(swappedFresh.journalEntryId);
    assert.notEqual(swappedFresh.journalEntryId, old.journalEntryId);
    assert.equal(swappedFresh.reversesRunId, first.id);
    const swapped = await deptTotals(org.orgId, org.accounts.adjustment);
    assert.equal(swapped.get(deptA), "900.0000");
    assert.equal(swapped.get(deptB), "600.0000");
    assert.equal(swapped.get(null), "0.0000");
    // Exactly one posted run holds the occurrence: the replacement.
    const postedCount = (await db.execute<{ count: string }>(sql`
      select count(*)::text as count from allocation_runs
       where org_id = ${org.orgId} and rule_id = ${ruleId} and status = 'posted'`)).rows;
    assert.equal(Number(postedCount[0]?.count ?? 0), 1);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("rejecting a rerun replacement leaves the posted run standing", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const actors = await seedFlowActors(org.orgId);
  try {
    await enableAllocations(org.orgId);
    await seedTodayPeriod(org);
    const { flowId } = await seedApprovalFlow(org.orgId, {
      subjectKind: "allocation_run",
      assignees: [{ type: "user", userId: actors.approver1Id }],
      mode: "any",
    });
    await seedSourceEntry(org, actors.adminId, "1000.0000");
    const { ruleId, deptA, deptB } = await seedPeriodRule({
      org,
      publisherId: actors.adminId,
      poolAccountId: org.accounts.adjustment,
      approvalFlowId: flowId,
    });
    const first = await previewAllocationRun({
      orgId: org.orgId,
      ruleId,
      periodId: org.periodId,
      bookId: org.bookId,
      actorId: actors.submitterId,
      trigger: "manual",
    });
    await postAllocationRun(first.id, actors.submitterId, "Please approve the sweep");
    const firstGate = await pendingGateForRun(first.id);
    assert.ok(firstGate);
    await decideGate({ gateId: firstGate.id, decision: "approved", userId: actors.approver1Id });
    await seedSourceEntry(org, actors.adminId, "500.0000");
    const rerun = await rerunAllocationRun(first.id, actors.submitterId, "Re-run after late activity", {
      reversalDate: org.date,
    });
    assert.equal(rerun.run.status, "pending_approval");
    const rejectGate = await pendingGateForRun(rerun.run.id);
    assert.ok(rejectGate);
    await decideGate({
      gateId: rejectGate.id,
      decision: "rejected",
      userId: actors.approver1Id,
      comment: "Late activity belongs next period",
    });
    // The replacement is marked rejected by name; the old run is byte-for-byte
    // still posted — journal intact, no reversal, still effective (600/400).
    const refused = await runRow(rerun.run.id);
    assert.equal(refused.status, "failed");
    assert.ok(refused.error?.startsWith("rejected:"));
    assert.equal(refused.journalEntryId, null);
    const standing = await runRow(first.id);
    assert.equal(standing.status, "posted");
    assert.ok(standing.journalEntryId);
    assert.equal(standing.reversalEntryId, null);
    assert.equal(standing.supersededByRunId, null);
    const totals = await deptTotals(org.orgId, org.accounts.adjustment);
    assert.equal(totals.get(deptA), "600.0000");
    assert.equal(totals.get(deptB), "400.0000");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
