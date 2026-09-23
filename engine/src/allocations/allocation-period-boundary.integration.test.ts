import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { postProjectGlEntry } from "../projects/recognition.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "../testing/fixtures.ts";
import {
  AllocationRuleError,
  createDraftVersion,
  createRule,
  publishVersion,
} from "./rules.ts";
import { postAllocationRun, previewAllocationRun } from "./period-run.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);
const AUDIT = { actorId: null, reason: "boundary test" };

// ---------------------------------------------------------------------------
// A2 period-boundary policy: a period sweep prices the whole period's pool
// under one version, so period-mode effective dates must sit on
// accounting-period boundaries. Publish proves mid-period dates against the
// known calendar; runs refuse any period crossed by a version edge (legacy
// windows included), naming the versions and the crossing date.
// ---------------------------------------------------------------------------

async function enableAllocations(orgId: string): Promise<void> {
  await db.execute(sql`
    update orgs set settings = jsonb_set(
      settings, '{features}',
      coalesce(settings->'features', '{}'::jsonb) || '{"allocations":true}'::jsonb, true)
    where id = ${orgId}
  `);
}

/** Scratch orgs open July 2026 only: add regular January + February 2026. */
async function seedJanFeb(org: ScratchOrg): Promise<{ janId: string; febId: string }> {
  const cal = (await db.execute<{ fiscal_calendar_id: string }>(sql`
    select fiscal_calendar_id from accounting_periods where id = ${org.periodId}`)).rows[0]!
    .fiscal_calendar_id;
  const janId = randomUUID();
  const febId = randomUUID();
  await db.execute(sql`
    insert into accounting_periods
      (id, org_id, fiscal_calendar_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment)
    values (${janId}, ${org.orgId}, ${cal}, 2026, 1, '2026-01', '2026-01-01', '2026-01-31', false),
           (${febId}, ${org.orgId}, ${cal}, 2026, 2, '2026-02', '2026-02-01', '2026-02-28', false)`);
  return { janId, febId };
}

async function seedDepartment(orgId: string, name: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into departments (id, org_id, name, is_active, custom)
    values (${id}, ${orgId}, ${name}, true, '{}'::jsonb)`);
  return id;
}

interface SeedVersion {
  versionNo: number;
  from: string;
  to: string | null;
  targets: { departmentId: string; percent: string }[];
}

/**
 * Legacy-style seeding straight to published (bypasses the publish-time
 * boundary proof, the way pre-fix data was created).
 */
async function seedPublishedRule(
  org: ScratchOrg,
  key: string,
  publisherId: string,
  poolAccountId: string,
  versions: SeedVersion[],
): Promise<string> {
  const ruleId = randomUUID();
  await db.execute(sql`
    insert into allocation_rules (id, org_id, key, name, mode, sort_order, is_active, is_system, custom)
    values (${ruleId}, ${org.orgId}, ${key}, ${`Rule ${key}`}, 'period', 100, true, false, '{}'::jsonb)`);
  let currentVersionId: string | null = null;
  for (const version of versions) {
    const versionId = randomUUID();
    await db.execute(sql`
      insert into allocation_rule_versions
        (id, org_id, rule_id, version_no, status, effective_from, effective_to,
         book_scope, book_ids, account_scope, dimension_filters, source_measure,
         basis_kind, driver_id, driver_as_of, basis_config,
         target_kind, dynamic_target, impact, residual_policy, solve_method,
         run_policy, run_offset_days, memo_template, published_at, published_by)
      values (${versionId}, ${org.orgId}, ${ruleId}, ${version.versionNo}, 'draft', ${version.from}, ${version.to},
         'primary', '[]'::jsonb,
         ${JSON.stringify({ kind: "accounts", accountIds: [poolAccountId] })}::jsonb,
         '{}'::jsonb, 'period_activity',
         'fixed_percent', null, 'period', '{}'::jsonb,
         'explicit', '{}'::jsonb, 'reclass', 'largest_share', 'sequential',
         'manual', 0, 'Allocation {{rule.name}} for {{period.name}}', now(), ${publisherId})`);
    let sequence = 1;
    for (const target of version.targets) {
      await db.execute(sql`
        insert into allocation_rule_targets
          (id, org_id, version_id, sequence, target_account_id, department_id,
           fixed_percent, weight, is_remainder, label, custom)
        values (${randomUUID()}, ${org.orgId}, ${versionId}, ${sequence},
                null, ${target.departmentId}, ${target.percent}, null, false, ${`T${sequence}`}, '{}'::jsonb)`);
      sequence += 1;
    }
    await db.execute(sql`
      update allocation_rule_versions
         set status = 'published', definition_hash = ${`testhash-${versionId}`}, published_at = now()
       where id = ${versionId} and org_id = ${org.orgId}`);
    currentVersionId = versionId;
  }
  await db.execute(sql`
    update allocation_rules set current_version_id = ${currentVersionId}
     where id = ${ruleId} and org_id = ${org.orgId}`);
  return ruleId;
}

/** Balanced source entries on explicit dates (mixed pre/post-change activity). */
async function seedDatedSource(
  org: ScratchOrg,
  actorId: string,
  entries: { date: string; amount: string }[],
): Promise<void> {
  for (const entry of entries) {
    const entryId = await postProjectGlEntry({
      orgId: org.orgId,
      actorId,
      origin: "manual",
      entryNumber: `BOUND-SEED-${randomUUID()}`,
      postingDate: entry.date,
      memo: "Boundary source pool",
      subsidiaryId: org.subsidiaryId,
      currency: "CAD",
      lines: [
        { accountId: org.accounts.adjustment, amount: entry.amount },
        {
          accountId: org.accounts.bank,
          amount: entry.amount.startsWith("-") ? entry.amount.slice(1) : `-${entry.amount}`,
        },
      ],
    });
    assert.ok(entryId, `source entry on ${entry.date} did not post`);
  }
}

async function journalLineCount(orgId: string): Promise<number> {
  const rows = (await db.execute<{ count: string }>(sql`
    select count(*)::text as count from journal_lines where org_id = ${orgId}`)).rows;
  return Number(rows[0]?.count ?? 0);
}

async function runCount(orgId: string): Promise<number> {
  const rows = (await db.execute<{ count: string }>(sql`
    select count(*)::text as count from allocation_runs where org_id = ${orgId}`)).rows;
  return Number(rows[0]?.count ?? 0);
}

test("a January run crossed by two versions refuses, naming both versions and the crossing date", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const actor = await createScratchUser(org.orgId, "Boundary prover", "admin");
  try {
    await enableAllocations(org.orgId);
    const { janId } = await seedJanFeb(org);
    const deptA = await seedDepartment(org.orgId, "Bound A");
    const deptB = await seedDepartment(org.orgId, "Bound B");
    // $100 of January source before Jan 15, $100 after — the exact scenario.
    await seedDatedSource(org, actor, [
      { date: "2026-01-10", amount: "100.0000" },
      { date: "2026-01-20", amount: "100.0000" },
    ]);
    const ruleId = await seedPublishedRule(org, `cross-${janId.slice(0, 4)}`, actor, org.accounts.adjustment, [
      {
        versionNo: 1,
        from: "2026-01-01",
        to: "2026-01-14",
        targets: [
          { departmentId: deptA, percent: "60.0000" },
          { departmentId: deptB, percent: "40.0000" },
        ],
      },
      {
        versionNo: 2,
        from: "2026-01-15",
        to: null,
        targets: [{ departmentId: deptA, percent: "100.0000" }],
      },
    ]);
    const linesBefore = await journalLineCount(org.orgId);
    await assert.rejects(
      previewAllocationRun({
        orgId: org.orgId,
        ruleId,
        periodId: janId,
        bookId: org.bookId,
        actorId: actor,
        trigger: "manual",
      }),
      (e: unknown) => {
        assert.ok(e instanceof Error, `expected an Error, got ${String(e)}`);
        assert.match(e.message, /cannot run for period 2026-01/);
        assert.match(e.message, /version 1 \(2026-01-01\.\.2026-01-14\)/);
        assert.match(e.message, /version 2 \(2026-01-15\.\.open\)/);
        assert.match(e.message, /2026-01-15/);
        return true;
      },
      "a run crossed by two versions must refuse naming both and the crossing date",
    );
    // Zero effect: no run row, no journal, no lineage.
    assert.equal(await runCount(org.orgId), 0);
    assert.equal(await journalLineCount(org.orgId), linesBefore);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a run previewed before a mid-period version appears refuses at post time", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const actor = await createScratchUser(org.orgId, "Boundary prover", "admin");
  try {
    await enableAllocations(org.orgId);
    const { janId } = await seedJanFeb(org);
    const deptA = await seedDepartment(org.orgId, "Post A");
    const deptB = await seedDepartment(org.orgId, "Post B");
    await seedDatedSource(org, actor, [{ date: "2026-01-10", amount: "100.0000" }]);
    // v1 alone governs January cleanly, so preview succeeds and pins v1.
    const ruleId = await seedPublishedRule(org, `legacy-${janId.slice(0, 4)}`, actor, org.accounts.adjustment, [
      {
        versionNo: 1,
        from: "2026-01-01",
        to: null,
        targets: [
          { departmentId: deptA, percent: "60.0000" },
          { departmentId: deptB, percent: "40.0000" },
        ],
      },
    ]);
    const preview = await previewAllocationRun({
      orgId: org.orgId,
      ruleId,
      periodId: janId,
      bookId: org.bookId,
      actorId: actor,
      trigger: "manual",
    });
    assert.equal(preview.status, "previewed");
    // A mid-period v2 lands after preview (hand-published: the publish proof
    // would refuse it today, but legacy data and backdoor writes exist).
    const v2 = randomUUID();
    await db.execute(sql`
      insert into allocation_rule_versions
        (id, org_id, rule_id, version_no, status, effective_from, effective_to,
         book_scope, book_ids, account_scope, dimension_filters, source_measure,
         basis_kind, driver_id, driver_as_of, basis_config,
         target_kind, dynamic_target, impact, residual_policy, solve_method,
         run_policy, run_offset_days, memo_template, published_at, published_by)
      values (${v2}, ${org.orgId}, ${ruleId}, 2, 'draft', '2026-01-15', null,
         'primary', '[]'::jsonb,
         ${JSON.stringify({ kind: "accounts", accountIds: [org.accounts.adjustment] })}::jsonb,
         '{}'::jsonb, 'period_activity',
         'fixed_percent', null, 'period', '{}'::jsonb,
         'explicit', '{}'::jsonb, 'reclass', 'largest_share', 'sequential',
         'manual', 0, 'late', now(), ${actor})`);
    await db.execute(sql`
      insert into allocation_rule_targets
        (id, org_id, version_id, sequence, target_account_id, department_id,
         fixed_percent, weight, is_remainder, label, custom)
      values (${randomUUID()}, ${org.orgId}, ${v2}, 1, null, ${deptA}, '100.0000', null, false, 'Late', '{}'::jsonb)`);
    await db.execute(sql`
      update allocation_rule_versions
         set status = 'published', definition_hash = 'testhash-late', published_at = now()
       where id = ${v2} and org_id = ${org.orgId}`);
    const linesBefore = await journalLineCount(org.orgId);
    await assert.rejects(
      postAllocationRun(preview.id, actor, "Post monthly cost sweep"),
      (e: unknown) => {
        assert.ok(e instanceof Error, `expected an Error, got ${String(e)}`);
        assert.match(e.message, /cannot run for period 2026-01/);
        assert.match(e.message, /version 2 \(2026-01-15\.\.open\)/);
        return true;
      },
      "posting a run whose period has since been crossed must refuse",
    );
    const rows = (await db.execute<{ status: string; journal_entry_id: string | null }>(sql`
      select status, journal_entry_id from allocation_runs where id = ${preview.id}`)).rows;
    assert.equal(rows[0]!.status, "previewed");
    assert.equal(rows[0]!.journal_entry_id, null);
    assert.equal(await journalLineCount(org.orgId), linesBefore);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("publishing a mid-period effective date refuses with the boundary suggestion", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await seedJanFeb(org);
    const created = await createRule(
      { orgId: org.orgId, key: `mid-${org.orgId.slice(0, 4)}`, name: "Mid", mode: "period", sortOrder: 100 },
      AUDIT,
    );
    const draft = await createDraftVersion(
      created.rule.id,
      { orgId: org.orgId, effectiveFrom: "2026-01-15", targets: [{ fixedPercent: "100" }] },
      AUDIT,
    );
    await assert.rejects(
      publishVersion(draft.version.id, { orgId: org.orgId, ...AUDIT }),
      (e: unknown) => {
        assert.ok(e instanceof AllocationRuleError, `expected AllocationRuleError, got ${String(e)}`);
        assert.equal(e.code, "INVALID");
        const flagged = (e.problems ?? []).find((p) => p.code === "effective_boundary");
        assert.ok(flagged, `expected an effective_boundary problem, got ${JSON.stringify(e.problems)}`);
        assert.match(flagged!.message, /must start on a period boundary/);
        assert.match(flagged!.message, /2026-01-15 falls inside 2026-01/);
        assert.match(flagged!.message, /use 2026-01-01 or 2026-02-01/);
        return true;
      },
      "a mid-period effective_from must refuse with the boundary suggestion",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("boundary-aligned versions publish and each run prices under its own version", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const actor = await createScratchUser(org.orgId, "Boundary prover", "admin");
  try {
    await enableAllocations(org.orgId);
    const { janId, febId } = await seedJanFeb(org);
    const deptA = await seedDepartment(org.orgId, "Align A");
    const deptB = await seedDepartment(org.orgId, "Align B");
    await seedDatedSource(org, actor, [
      { date: "2026-01-10", amount: "1000.0000" },
      { date: "2026-02-10", amount: "1000.0000" },
    ]);
    const created = await createRule(
      { orgId: org.orgId, key: `align-${org.orgId.slice(0, 4)}`, name: "Align", mode: "period", sortOrder: 100 },
      AUDIT,
    );
    const v1 = await createDraftVersion(
      created.rule.id,
      {
        orgId: org.orgId,
        effectiveFrom: "2026-01-01",
        effectiveTo: "2026-01-31",
        accountScope: { kind: "accounts", accountIds: [org.accounts.adjustment] },
        targets: [
          { departmentId: deptA, fixedPercent: "60" },
          { departmentId: deptB, fixedPercent: "40" },
        ],
      },
      AUDIT,
    );
    await publishVersion(v1.version.id, { orgId: org.orgId, ...AUDIT });
    const v2 = await createDraftVersion(
      created.rule.id,
      {
        orgId: org.orgId,
        effectiveFrom: "2026-02-01",
        accountScope: { kind: "accounts", accountIds: [org.accounts.adjustment] },
        targets: [{ departmentId: deptA, fixedPercent: "100" }],
      },
      AUDIT,
    );
    await publishVersion(v2.version.id, { orgId: org.orgId, ...AUDIT });
    const january = await previewAllocationRun({
      orgId: org.orgId,
      ruleId: created.rule.id,
      periodId: janId,
      bookId: org.bookId,
      actorId: actor,
      trigger: "manual",
    });
    const postedJan = await postAllocationRun(january.id, actor, "Post January sweep");
    assert.equal(postedJan.status, "posted");
    const february = await previewAllocationRun({
      orgId: org.orgId,
      ruleId: created.rule.id,
      periodId: febId,
      bookId: org.bookId,
      actorId: actor,
      trigger: "manual",
    });
    const postedFeb = await postAllocationRun(february.id, actor, "Post February sweep");
    assert.equal(postedFeb.status, "posted");
    // Each run priced under its own version: 60/40 in January, 100 in February.
    const janAmounts = (await db.execute<{ department_id: string | null; total: string }>(sql`
      select l.department_id, sum(l.amount)::text as total
        from journal_lines l join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
       where l.org_id = ${org.orgId} and e.id = ${postedJan.journalEntryId}
         and l.amount > 0 group by l.department_id`)).rows;
    const janByDept = new Map(janAmounts.map((row) => [row.department_id, row.total]));
    assert.equal(janByDept.get(deptA), "600.0000");
    assert.equal(janByDept.get(deptB), "400.0000");
    const febAmounts = (await db.execute<{ department_id: string | null; total: string }>(sql`
      select l.department_id, sum(l.amount)::text as total
        from journal_lines l join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
       where l.org_id = ${org.orgId} and e.id = ${postedFeb.journalEntryId}
         and l.amount > 0 group by l.department_id`)).rows;
    assert.equal(febAmounts.length, 1);
    assert.equal(febAmounts[0]!.department_id, deptA);
    assert.equal(febAmounts[0]!.total, "1000.0000");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("entry-mode versions keep arbitrary effective dates", { skip: !DB }, async () => {
  // A2(3): entry/post modes resolve one version for one document date — no
  // period pool, no shared flaw — so the boundary proof leaves them alone.
  const org = await createScratchOrg();
  try {
    await seedJanFeb(org);
    const created = await createRule(
      { orgId: org.orgId, key: `entry-${org.orgId.slice(0, 4)}`, name: "Entry", mode: "entry", sortOrder: 100 },
      AUDIT,
    );
    const draft = await createDraftVersion(
      created.rule.id,
      { orgId: org.orgId, effectiveFrom: "2026-01-15", targets: [{ fixedPercent: "100" }] },
      AUDIT,
    );
    const published = await publishVersion(draft.version.id, { orgId: org.orgId, ...AUDIT });
    assert.equal(published.version.status, "published");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
