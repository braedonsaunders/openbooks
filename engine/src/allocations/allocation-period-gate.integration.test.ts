import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { setPeriodLockState } from "../close.ts";
import { postProjectGlEntry } from "../project-recognition.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
  type ScratchOrg,
} from "../test-fixtures.ts";
import {
  postAllocationRun,
  previewAllocationRun,
} from "./period-run.ts";

/**
 * One period gate for allocations (fleet 8, P7): the period-run posting
 * check routes through assertPeriodModulesOpen instead of raw
 * period_module_is_closed SQL. Policy is preserved — an allocation posting
 * is new local activity, not historical replay, so a source-owned imported
 * lock refuses exactly like a user lock. Both lock flavors are pinned
 * below, plus an open-period sanity post.
 */
const DB = !!process.env.OPENBOOKS_DB_URL;

const IMPORTED_REASON = "close.importedPeriodLockReason";

/** User-owned close, through the same lock writer the close flow uses. */
async function closeGlForUser(org: ScratchOrg, actorId: string): Promise<void> {
  await setPeriodLockState({
    orgId: org.orgId,
    periodId: org.periodId,
    bookId: org.bookId,
    module: "gl",
    state: "closed",
    actorId,
    reason: "fleet8 f2: user-owned GL close",
  });
}

/**
 * Source-owned close, mirroring exactly what the migration mirror lands
 * (engine/src/sync/migrate.ts): every module locked with the imported reason.
 */
async function closeAllImported(org: ScratchOrg): Promise<void> {
  for (const module of ["ar", "ap", "banking", "assets", "tax", "gl"] as const) {
    await db.execute(sql`
      insert into period_locks
        (org_id, period_id, book_id, module, state, locked_at, reason)
      values (${org.orgId}, ${org.periodId}, ${org.bookId}, ${module},
              'closed', now(), ${IMPORTED_REASON})
      on conflict (org_id, period_id, book_id, subsidiary_id, module)
      do update set state = excluded.state,
        locked_at = excluded.locked_at,
        reason = excluded.reason,
        reopen_expires_at = null,
        version = period_locks.version + 1,
        updated_at = now()`);
  }
}

async function seedDepartment(orgId: string, name: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into departments (id, org_id, name, is_active, custom)
    values (${id}, ${orgId}, ${name}, true, '{}'::jsonb)`);
  return id;
}

function negate(amount: string): string {
  return amount.startsWith("-") ? amount.slice(1) : `-${amount}`;
}

async function seedSweepRule(org: ScratchOrg, tag: string): Promise<string> {
  const deptA = await seedDepartment(org.orgId, `Gate A ${tag}`);
  const deptB = await seedDepartment(org.orgId, `Gate B ${tag}`);
  const ruleId = randomUUID();
  const versionId = randomUUID();
  const key = `f2-gate-${tag}`;
  await db.execute(sql`
    insert into allocation_rules (id, org_id, key, name, mode, sort_order, is_active, is_system, custom)
    values (${ruleId}, ${org.orgId}, ${key}, ${`Rule ${key}`}, 'period', 100, true, false, '{}'::jsonb)`);
  await db.execute(sql`
    insert into allocation_rule_versions
      (id, org_id, rule_id, version_no, status, effective_from, effective_to,
       book_scope, book_ids, account_scope, dimension_filters, source_measure,
       basis_kind, driver_id, driver_as_of, basis_config,
       target_kind, dynamic_target, impact, residual_policy, solve_method,
       run_policy, run_offset_days, memo_template, published_at)
    values (${versionId}, ${org.orgId}, ${ruleId}, 1, 'draft', '2026-01-01', null,
       'primary', '[]'::jsonb,
       ${JSON.stringify({ kind: "accounts", accountIds: [org.accounts.adjustment] })}::jsonb,
       '{}'::jsonb, 'period_activity', 'fixed_percent', null, 'period', '{}'::jsonb,
       'explicit', '{}'::jsonb, 'reclass', 'largest_share', 'sequential',
       'manual', 0, 'Allocation {{rule.name}} for {{period.name}}', now())`);
  let sequence = 1;
  for (const [dept, percent, label] of [[deptA, "60.0000", "Dept A"], [deptB, "40.0000", "Dept B"]] as const) {
    await db.execute(sql`
      insert into allocation_rule_targets
        (id, org_id, version_id, sequence, target_account_id, department_id,
         fixed_percent, weight, is_remainder, label, custom)
      values (${randomUUID()}, ${org.orgId}, ${versionId}, ${sequence},
              null, ${dept}, ${percent}, null, false, ${`${label} ${tag}`}, '{}'::jsonb)`);
    sequence += 1;
  }
  await db.execute(sql`
    update allocation_rule_versions
       set status = 'published', definition_hash = ${`testhash-${versionId}`}, published_at = now()
     where id = ${versionId} and org_id = ${org.orgId}`);
  await db.execute(sql`
    update allocation_rules set current_version_id = ${versionId}
     where id = ${ruleId} and org_id = ${org.orgId}`);
  return ruleId;
}

/** One balanced source entry feeding the sweep pool account. */
async function seedSourceEntry(org: ScratchOrg, actorId: string, amount: string): Promise<void> {
  const entryId = await postProjectGlEntry({
    orgId: org.orgId,
    actorId,
    origin: "manual",
    entryNumber: `SEED-${randomUUID()}`,
    postingDate: org.date,
    memo: "Allocation source pool",
    subsidiaryId: org.subsidiaryId,
    currency: "CAD",
    lines: [
      { accountId: org.accounts.adjustment, amount },
      { accountId: org.accounts.bank, amount: negate(amount) },
    ],
  });
  assert.ok(entryId);
}

async function previewOpenRun(org: ScratchOrg, actorId: string, tag: string): Promise<string> {
  const ruleId = await seedSweepRule(org, tag);
  await seedSourceEntry(org, actorId, "1000");
  const preview = await previewAllocationRun({
    orgId: org.orgId,
    ruleId,
    periodId: org.periodId,
    bookId: org.bookId,
    actorId,
    trigger: "manual",
  });
  assert.equal(preview.status, "previewed");
  return preview.id;
}

test("open period: the sweep still posts (setup can post, refusal is load-bearing)", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const runId = await previewOpenRun(org, actorId, "open");
    const posted = await postAllocationRun(runId, actorId, "Post monthly cost sweep");
    assert.equal(posted.status, "posted");
    assert.ok(posted.journalEntryId);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("allocation posting refuses a user-closed GL period", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const runId = await previewOpenRun(org, actorId, "user");
    await closeGlForUser(org, actorId);
    await assert.rejects(
      postAllocationRun(runId, actorId, "Post monthly cost sweep into a closed period"),
      /the GL period .* is closed and cannot take allocation postings/,
      "an allocation posting into a user-closed period must be refused",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("allocation posting refuses a source-owned imported lock", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const runId = await previewOpenRun(org, actorId, "imported");
    await closeAllImported(org);
    await assert.rejects(
      postAllocationRun(runId, actorId, "Post monthly cost sweep into an imported lock"),
      /the GL period .* is closed and cannot take allocation postings/,
      "an allocation posting into an imported lock must be refused: it is new activity, not replay",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
