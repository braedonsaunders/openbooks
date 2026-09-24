import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { isZero } from "../money/money.ts";
import { postProjectGlEntry } from "../projects/recognition.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
  type ScratchOrg,
} from "../testing/fixtures.ts";
import {
  AllocationRunError,
  postAllocationRun,
  previewAllocationRun,
  rerunAllocationRun,
  reverseAllocationRun,
} from "./period-run.ts";
import { getRun, listRuns, queryLineage } from "./run-queries.ts";
import type { DriverResolver, RunComputation } from "./types.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

// ---------------------------------------------------------------------------
// A3 period-run slice: preview/post/reverse/rerun + lineage.
// Every test leases its own scratch org (never shared across top-level tests).
// ---------------------------------------------------------------------------

async function seedDepartment(orgId: string, name: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into departments (id, org_id, name, is_active, custom)
    values (${id}, ${orgId}, ${name}, true, '{}'::jsonb)`);
  return id;
}

/**
 * The engine fences posting/reversing/re-running behind the org's
 * `allocations` switch: these tests drive the engine directly (no route
 * gate), so every scratch org opts in, the way the Features page would.
 */
async function enableAllocations(orgId: string): Promise<void> {
  await db.execute(sql`
    update orgs set settings = jsonb_set(
      settings, '{features}',
      coalesce(settings->'features', '{}'::jsonb) || '{"allocations":true}'::jsonb, true)
    where id = ${orgId}
  `);
}

interface SeedTarget {
  departmentId?: string | null;
  subsidiaryId?: string | null;
  targetAccountId?: string | null;
  fixedPercent?: string | null;
  weight?: string | null;
  isRemainder?: boolean;
  label?: string | null;
}

async function seedPeriodRule(opts: {
  orgId: string;
  /** Pool account: the sweep reads only this account (an 'any' scope would net every balanced entry to zero). */
  poolAccountId: string;
  key?: string;
  impact?: "reclass" | "net_zero_pair" | "report_only";
  basisKind?: "fixed_percent" | "driver" | "stepped";
  basisConfig?: unknown;
  sourceMeasure?: "period_activity" | "period_end_balance" | "ytd_activity";
  accountScope?: unknown;
  dimensionFilters?: unknown;
  targetKind?: "explicit" | "dynamic";
  dynamicTarget?: unknown;
  driverId?: string | null;
  targets?: SeedTarget[];
  solveMethod?: "sequential" | "simultaneous";
}): Promise<{ ruleId: string; versionId: string }> {
  const ruleId = randomUUID();
  const versionId = randomUUID();
  const key = opts.key ?? `alloc-${ruleId.slice(0, 8)}`;
  await db.execute(sql`
    insert into allocation_rules (id, org_id, key, name, mode, sort_order, is_active, is_system, custom)
    values (${ruleId}, ${opts.orgId}, ${key}, ${`Rule ${key}`}, 'period', 100, true, false, '{}'::jsonb)`);
  // Targets are immutable once published (DB guard), so seed the version as a
  // draft, insert targets, then publish — the same order the A1 service uses.
  await db.execute(sql`
    insert into allocation_rule_versions
      (id, org_id, rule_id, version_no, status, effective_from, effective_to,
       book_scope, book_ids, account_scope, dimension_filters, source_measure,
       basis_kind, driver_id, driver_as_of, basis_config,
       target_kind, dynamic_target, impact, residual_policy, solve_method,
       run_policy, run_offset_days, memo_template, published_at)
    values (${versionId}, ${opts.orgId}, ${ruleId}, 1, 'draft', '2026-01-01', null,
       'primary', '[]'::jsonb,
       ${JSON.stringify(opts.accountScope ?? { kind: "accounts", accountIds: [opts.poolAccountId] })}::jsonb,
       ${JSON.stringify(opts.dimensionFilters ?? {})}::jsonb,
       ${opts.sourceMeasure ?? "period_activity"},
       ${opts.basisKind ?? "fixed_percent"}, ${opts.driverId ?? null}, 'period', ${JSON.stringify(opts.basisConfig ?? {})}::jsonb,
       ${opts.targetKind ?? "explicit"}, ${JSON.stringify(opts.dynamicTarget ?? {})}::jsonb,
       ${opts.impact ?? "reclass"}, 'largest_share', ${opts.solveMethod ?? "sequential"},
       'manual', 0, 'Allocation {{rule.name}} for {{period.name}}', now())`);
  const targets = opts.targets ?? [];
  let sequence = 1;
  for (const target of targets) {
    await db.execute(sql`
      insert into allocation_rule_targets
        (id, org_id, version_id, sequence, target_account_id, department_id, subsidiary_id,
         fixed_percent, weight, is_remainder, label, custom)
      values (${randomUUID()}, ${opts.orgId}, ${versionId}, ${sequence},
              ${target.targetAccountId ?? null}, ${target.departmentId ?? null}, ${target.subsidiaryId ?? null},
              ${target.fixedPercent ?? null}, ${target.weight ?? null},
              ${target.isRemainder ?? false}, ${target.label ?? null}, '{}'::jsonb)`);
    sequence += 1;
  }
  await db.execute(sql`
    update allocation_rule_versions
       set status = 'published', definition_hash = ${`testhash-${versionId}`}, published_at = now()
     where id = ${versionId} and org_id = ${opts.orgId}`);
  await db.execute(sql`
    update allocation_rules set current_version_id = ${versionId}
     where id = ${ruleId} and org_id = ${opts.orgId}`);
  return { ruleId, versionId };
}

async function seedDriver(opts: {
  orgId: string;
  key?: string;
  dimension?: string;
  sourceKind?: string;
}): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into allocation_drivers (id, org_id, key, name, dimension, source_kind, config, is_active, custom)
    values (${id}, ${opts.orgId}, ${opts.key ?? `drv-${id.slice(0, 8)}`}, 'Test driver',
            ${opts.dimension ?? "department"}, ${opts.sourceKind ?? "manual"}, '{}'::jsonb, true, '{}'::jsonb)`);
  return id;
}

async function seedDriverValue(opts: {
  orgId: string;
  driverId: string;
  dimensionValueId: string;
  value: string;
  effectiveFrom?: string;
}): Promise<void> {
  await db.execute(sql`
    insert into allocation_driver_values
      (id, org_id, driver_id, dimension_value_id, effective_from, effective_to, value)
    values (${randomUUID()}, ${opts.orgId}, ${opts.driverId}, ${opts.dimensionValueId},
            ${opts.effectiveFrom ?? "2026-01-01"}, null, ${opts.value})`);
}

/** One balanced source entry: DR pool account / CR bank, optionally tagged. */
async function seedSourceEntry(
  org: ScratchOrg,
  actorId: string,
  amount: string,
  departmentId?: string | null,
  subsidiaryId?: string | null,
): Promise<string> {
  const entryId = await postProjectGlEntry({
    orgId: org.orgId,
    actorId,
    origin: "manual",
    entryNumber: `SEED-${randomUUID()}`,
    postingDate: org.date,
    memo: "Allocation source pool",
    subsidiaryId: subsidiaryId ?? org.subsidiaryId,
    currency: "CAD",
    lines: [
      { accountId: org.accounts.adjustment, amount, departmentId: departmentId ?? null },
      { accountId: org.accounts.bank, amount: negate(amount) },
    ],
  });
  assert.ok(entryId);
  return entryId;
}

function negate(amount: string): string {
  return amount.startsWith("-") ? amount.slice(1) : `-${amount}`;
}

async function accountTotals(orgId: string): Promise<Map<string, string>> {
  const rows = (await db.execute<{ account_id: string; total: string }>(sql`
    select l.account_id, sum(l.amount)::text as total
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
     where l.org_id = ${orgId} and e.status in ('posted', 'reversed')
     group by l.account_id`)).rows;
  return new Map(rows.map((row) => [row.account_id, row.total]));
}

async function coordinateTotals(orgId: string): Promise<Map<string, string>> {
  const rows = (await db.execute<{ account_id: string; department_id: string | null; total: string }>(sql`
    select l.account_id, l.department_id, sum(l.amount)::text as total
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
     where l.org_id = ${orgId} and e.status in ('posted', 'reversed')
     group by l.account_id, l.department_id`)).rows;
  return new Map(
    rows.map((row) => [`${row.account_id}|${row.department_id ?? ""}`, row.total]),
  );
}

async function journalLineCount(orgId: string): Promise<number> {
  const rows = (await db.execute<{ count: string }>(sql`
    select count(*)::text as count from journal_lines where org_id = ${orgId}`)).rows;
  return Number(rows[0]?.count ?? 0);
}

async function postedRunCount(orgId: string, ruleId: string): Promise<number> {
  const rows = (await db.execute<{ count: string }>(sql`
    select count(*)::text as count from allocation_runs
     where org_id = ${orgId} and rule_id = ${ruleId} and status = 'posted'`)).rows;
  return Number(rows[0]?.count ?? 0);
}

test(
  "balance and ytd pools include adjustment-period entries of the run calendar",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    await enableAllocations(org.orgId);
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      const calendar = (await db.execute<{ fiscal_calendar_id: string }>(sql`
        select fiscal_calendar_id from accounting_periods where id = ${org.periodId}`))
        .rows[0]!.fiscal_calendar_id;
      const adjustmentId = randomUUID(), augustId = randomUUID();
      await db.execute(sql`
        insert into accounting_periods
          (id, org_id, fiscal_calendar_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment)
        values (${adjustmentId}, ${org.orgId}, ${calendar}, 2026, 13, '2026-ADJ', '2026-07-31', '2026-07-31', true),
               (${augustId}, ${org.orgId}, ${calendar}, 2026, 8, '2026-08', '2026-08-01', '2026-08-31', false)`);
      // Year-end audit accrual posted into the adjustment period: DR expense / CR bank.
      const entry = randomUUID();
      await db.transaction(async (tx) => {
        await tx.execute(sql`insert into journal_entries
            (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
          values (${entry}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${entry},
                  '2026-07-31', ${adjustmentId}, 'Audit accrual', 'draft', 'manual')`);
        await tx.execute(sql`insert into journal_lines
            (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
          values (${org.orgId}, ${entry}, 1, ${org.accounts.adjustment}, ${org.subsidiaryId},
                  '500.0000', 'CAD', '500.0000', '1'),
                 (${org.orgId}, ${entry}, 2, ${org.accounts.bank}, ${org.subsidiaryId},
                  '-500.0000', 'CAD', '-500.0000', '1')`);
        await tx.execute(sql`update journal_entries set status = 'posted'
          where org_id = ${org.orgId} and id = ${entry}`);
      });
      for (const sourceMeasure of ["period_end_balance", "ytd_activity"] as const) {
        const dept = await seedDepartment(org.orgId, `Dept ${sourceMeasure}`);
        const { ruleId } = await seedPeriodRule({
          orgId: org.orgId,
          poolAccountId: org.accounts.adjustment,
          sourceMeasure,
          impact: "report_only",
          targets: [{ departmentId: dept, fixedPercent: "100.0000", label: "Dept" }],
        });
        const later = await previewAllocationRun({
          orgId: org.orgId, ruleId, periodId: augustId, bookId: org.bookId, actorId, trigger: "manual",
        });
        // Before the fix the not-is_adjustment pool filter dropped the
        // accrual from every later pool, so the balance was wrong forever.
        assert.equal(later.sourceTotal, "500.0000");
        const sameEnd = await previewAllocationRun({
          orgId: org.orgId, ruleId, periodId: org.periodId, bookId: org.bookId, actorId, trigger: "manual",
        });
        // The adjustment shares the regular period's end date: it belongs to
        // the balance as of that date.
        assert.equal(sameEnd.sourceTotal, "500.0000");
      }
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "preview refuses a simultaneous-solve version instead of silently running it sequentially",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    await enableAllocations(org.orgId);
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      const deptA = await seedDepartment(org.orgId, "Dept A");
      const deptB = await seedDepartment(org.orgId, "Dept B");
      const { ruleId } = await seedPeriodRule({
        orgId: org.orgId,
        poolAccountId: org.accounts.adjustment,
        impact: "reclass",
        solveMethod: "simultaneous",
        targets: [
          { departmentId: deptA, fixedPercent: "60.0000", label: "Dept A" },
          { departmentId: deptB, fixedPercent: "40.0000", label: "Dept B" },
        ],
      });
      await assert.rejects(
        previewAllocationRun({
          orgId: org.orgId,
          ruleId,
          periodId: org.periodId,
          bookId: org.bookId,
          actorId,
          trigger: "manual",
        }),
        /simultaneous/,
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "reclass preview apportions every cent and post leaves the trial balance total unchanged",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    await enableAllocations(org.orgId);
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      const deptA = await seedDepartment(org.orgId, "Dept A");
      const deptB = await seedDepartment(org.orgId, "Dept B");
      await seedSourceEntry(org, actorId, "1000.0000");
      const { ruleId } = await seedPeriodRule({
        orgId: org.orgId,
        poolAccountId: org.accounts.adjustment,
        impact: "reclass",
        targets: [
          { departmentId: deptA, fixedPercent: "60.0000", label: "Dept A" },
          { departmentId: deptB, fixedPercent: "40.0000", label: "Dept B" },
        ],
      });

      const preview = await previewAllocationRun({
        orgId: org.orgId,
        ruleId,
        periodId: org.periodId,
        bookId: org.bookId,
        actorId,
        trigger: "manual",
      });
      assert.equal(preview.status, "previewed");
      assert.equal(preview.sourceTotal, "1000.0000");
      const targetSum = preview.computation.targets
        .map((target) => target.amount)
        .reduce((acc, amount) => acc + BigInt(amount.replace(".", "").replace("-", "")), 0n);
      assert.equal(targetSum, 10000000n);
      assert.ok(preview.fingerprint && preview.fingerprint.length === 64);
      assert.equal(preview.journalEntryId, null);

      const before = await accountTotals(org.orgId);
      const posted = await postAllocationRun(preview.id, actorId, "Post monthly cost sweep");
      assert.equal(posted.status, "posted");
      assert.ok(posted.journalEntryId);

      const after = await accountTotals(org.orgId);
      assert.deepEqual([...after.entries()].sort(), [...before.entries()].sort());

      const coords = await coordinateTotals(org.orgId);
      assert.equal(coords.get(`${org.accounts.adjustment}|${deptA}`), "600.0000");
      assert.equal(coords.get(`${org.accounts.adjustment}|${deptB}`), "400.0000");
      assert.equal(coords.get(`${org.accounts.adjustment}|`) ?? "0.0000", "0.0000");

      const run = await getRun(org.orgId, preview.id);
      assert.equal((run.computation as RunComputation).targets.length, 2);
      assert.equal(run.status, "posted");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a stepped publication previews as a named runnable refusal, not a 500",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    await enableAllocations(org.orgId);
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      const deptA = await seedDepartment(org.orgId, "Stepped A");
      const deptB = await seedDepartment(org.orgId, "Stepped B");
      // Seeded straight to published, the way a pre-refusal publication
      // reads: publish itself would refuse this version today.
      const { ruleId } = await seedPeriodRule({
        orgId: org.orgId,
        poolAccountId: org.accounts.adjustment,
        impact: "reclass",
        basisKind: "stepped",
        basisConfig: { tiers: [{ upTo: "1000" }, { upTo: null }] },
        targets: [
          { departmentId: deptA, targetAccountId: org.accounts.adjustment, label: "Stepped A" },
          { departmentId: deptB, targetAccountId: org.accounts.adjustment, label: "Stepped B" },
        ],
      });
      await seedSourceEntry(org, actorId, "2500.0000");
      // The refusal class is the product: only AllocationRunError reaches
      // the routes as a named 422 instead of the generic 500 fallback.
      await assert.rejects(
        previewAllocationRun({
          orgId: org.orgId,
          ruleId,
          periodId: org.periodId,
          bookId: org.bookId,
          actorId,
          trigger: "manual",
        }),
        (error: unknown) =>
          error instanceof AllocationRunError &&
          /stepped basis, which is not yet runnable/.test(error.message) &&
          /republish/.test(error.message),
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "awkward split loses no cent: 100.00 across three equal weights sums exactly",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    await enableAllocations(org.orgId);
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      const depts = [
        await seedDepartment(org.orgId, "North"),
        await seedDepartment(org.orgId, "South"),
        await seedDepartment(org.orgId, "West"),
      ];
      await seedSourceEntry(org, actorId, "100.0000");
      const { ruleId } = await seedPeriodRule({
        orgId: org.orgId,
        poolAccountId: org.accounts.adjustment,
        impact: "reclass",
        targets: depts.map((departmentId, index) => ({
          departmentId,
          weight: "1.0000",
          label: `T${index + 1}`,
        })),
      });
      const preview = await previewAllocationRun({
        orgId: org.orgId,
        ruleId,
        periodId: org.periodId,
        bookId: org.bookId,
        actorId,
      });
      assert.equal(preview.sourceTotal, "100.0000");
      const total = preview.computation.targets.reduce(
        (acc, target) => acc + BigInt(target.amount.replace(".", "")),
        0n,
      );
      assert.equal(total, 1000000n);
      const residuals = preview.computation.targets.filter((target) => target.residual !== "0.0000");
      assert.equal(residuals.length, 1);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "net_zero_pair never changes any account total",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    await enableAllocations(org.orgId);
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      const deptA = await seedDepartment(org.orgId, "Dept A");
      const deptB = await seedDepartment(org.orgId, "Dept B");
      await seedSourceEntry(org, actorId, "500.0000");
      const { ruleId } = await seedPeriodRule({
        orgId: org.orgId,
        poolAccountId: org.accounts.adjustment,
        impact: "net_zero_pair",
        targets: [
          { departmentId: deptA, fixedPercent: "50.0000", label: "Dept A" },
          { departmentId: deptB, fixedPercent: "50.0000", label: "Dept B" },
        ],
      });
      const before = await accountTotals(org.orgId);
      const preview = await previewAllocationRun({
        orgId: org.orgId,
        ruleId,
        periodId: org.periodId,
        bookId: org.bookId,
        actorId,
      });
      await postAllocationRun(preview.id, actorId, "Post statistical attribution");
      const after = await accountTotals(org.orgId);
      assert.deepEqual([...after.entries()].sort(), [...before.entries()].sort());
      const coords = await coordinateTotals(org.orgId);
      assert.equal(coords.get(`${org.accounts.adjustment}|${deptA}`), "250.0000");
      assert.equal(coords.get(`${org.accounts.adjustment}|${deptB}`), "250.0000");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "report_only writes no journal lines but records lineage",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    await enableAllocations(org.orgId);
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      const deptA = await seedDepartment(org.orgId, "Dept A");
      await seedSourceEntry(org, actorId, "200.0000");
      const { ruleId } = await seedPeriodRule({
        orgId: org.orgId,
        poolAccountId: org.accounts.adjustment,
        impact: "report_only",
        targets: [{ departmentId: deptA, fixedPercent: "100.0000", label: "Dept A" }],
      });
      const linesBefore = await journalLineCount(org.orgId);
      const preview = await previewAllocationRun({
        orgId: org.orgId,
        ruleId,
        periodId: org.periodId,
        bookId: org.bookId,
        actorId,
      });
      assert.equal(preview.computation.lines.length, 0);
      const posted = await postAllocationRun(preview.id, actorId, "Record statistical split");
      assert.equal(posted.status, "posted");
      assert.equal(posted.journalEntryId, null);
      assert.equal(await journalLineCount(org.orgId), linesBefore);
      const lineage = await queryLineage(org.orgId, { runId: preview.id });
      assert.equal(lineage.rows.length, 1);
      assert.equal(lineage.rows[0]?.amount, "200.0000");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "reversal restores every account and dimension balance exactly",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    await enableAllocations(org.orgId);
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      const deptA = await seedDepartment(org.orgId, "Dept A");
      const deptB = await seedDepartment(org.orgId, "Dept B");
      await seedSourceEntry(org, actorId, "1000.0000");
      const { ruleId } = await seedPeriodRule({
        orgId: org.orgId,
        poolAccountId: org.accounts.adjustment,
        impact: "reclass",
        targets: [
          { departmentId: deptA, fixedPercent: "70.0000", label: "Dept A" },
          { departmentId: deptB, fixedPercent: "30.0000", label: "Dept B" },
        ],
      });
      const before = await coordinateTotals(org.orgId);
      const preview = await previewAllocationRun({
        orgId: org.orgId,
        ruleId,
        periodId: org.periodId,
        bookId: org.bookId,
        actorId,
      });
      await postAllocationRun(preview.id, actorId, "Post sweep before reversal check");
      const reversed = await reverseAllocationRun(
        preview.id,
        actorId,
        "Correction approved by controller",
        { reversalDate: org.date },
      );
      assert.equal(reversed.status, "reversed");
      assert.ok(reversed.reversalEntryId);
      // Zero-sum coordinates the sweep created (and exactly unwound) carry no
      // balance; drop them so the comparison is balance-exact, not row-exact.
      const nonzero = (coords: Map<string, string>): Array<[string, string]> =>
        [...coords.entries()].filter(([, total]) => !isZero(total)).sort();
      const after = await coordinateTotals(org.orgId);
      assert.deepEqual(nonzero(after), nonzero(before));
      // Original post lines plus their reversal mirrors.
      const lineage = await queryLineage(org.orgId, { runId: preview.id });
      assert.equal(lineage.rows.length, 6);
      const lineageSum = lineage.rows
        .map((row) => row.amount)
        .reduce((acc, amount) => acc + BigInt(amount.replace(".", "")), 0n);
      assert.equal(lineageSum, 0n);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "rerun with unchanged inputs yields the same fingerprint and posts nothing new",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    await enableAllocations(org.orgId);
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      const deptA = await seedDepartment(org.orgId, "Dept A");
      await seedSourceEntry(org, actorId, "300.0000");
      const { ruleId } = await seedPeriodRule({
        orgId: org.orgId,
        poolAccountId: org.accounts.adjustment,
        impact: "reclass",
        targets: [{ departmentId: deptA, fixedPercent: "100.0000", label: "Dept A" }],
      });
      const preview = await previewAllocationRun({
        orgId: org.orgId,
        ruleId,
        periodId: org.periodId,
        bookId: org.bookId,
        actorId,
      });
      await postAllocationRun(preview.id, actorId, "Initial monthly sweep");
      const rerun = await rerunAllocationRun(preview.id, actorId, "Nightly re-run check", {
        reversalDate: org.date,
      });
      assert.equal(rerun.idempotent, true);
      assert.equal(rerun.run.id, preview.id);
      assert.equal(await postedRunCount(org.orgId, ruleId), 1);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "rerun after new source activity reverses, reposts, and chains supersession",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    await enableAllocations(org.orgId);
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      const deptA = await seedDepartment(org.orgId, "Dept A");
      await seedSourceEntry(org, actorId, "300.0000");
      const { ruleId } = await seedPeriodRule({
        orgId: org.orgId,
        poolAccountId: org.accounts.adjustment,
        impact: "reclass",
        targets: [{ departmentId: deptA, fixedPercent: "100.0000", label: "Dept A" }],
      });
      const preview = await previewAllocationRun({
        orgId: org.orgId,
        ruleId,
        periodId: org.periodId,
        bookId: org.bookId,
        actorId,
      });
      await postAllocationRun(preview.id, actorId, "Initial monthly sweep");
      await seedSourceEntry(org, actorId, "100.0000");
      const rerun = await rerunAllocationRun(preview.id, actorId, "Re-run after late activity", {
        reversalDate: org.date,
      });
      assert.equal(rerun.idempotent, false);
      assert.notEqual(rerun.run.id, preview.id);
      assert.equal(rerun.run.status, "posted");
      assert.equal(rerun.run.sourceTotal, "400.0000");
      const oldRun = await getRun(org.orgId, preview.id);
      assert.equal(oldRun.status, "reversed");
      // Chain links live on the run rows (A8 summaries omit them).
      const chain = (await db.execute<{ id: string; superseded_by_run_id: string | null; reverses_run_id: string | null }>(sql`
        select id, superseded_by_run_id, reverses_run_id from allocation_runs
         where org_id = ${org.orgId} and id in (${preview.id}::uuid, ${rerun.run.id}::uuid)`)).rows;
      const byId = new Map(chain.map((row) => [row.id, row]));
      assert.equal(byId.get(preview.id)?.superseded_by_run_id, rerun.run.id);
      assert.equal(byId.get(rerun.run.id)?.reverses_run_id, preview.id);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a closed period refuses post and reverse",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    await enableAllocations(org.orgId);
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      const deptA = await seedDepartment(org.orgId, "Dept A");
      await seedSourceEntry(org, actorId, "300.0000");
      const { ruleId } = await seedPeriodRule({
        orgId: org.orgId,
        poolAccountId: org.accounts.adjustment,
        targets: [{ departmentId: deptA, fixedPercent: "100.0000", label: "Dept A" }],
      });
      const preview = await previewAllocationRun({
        orgId: org.orgId,
        ruleId,
        periodId: org.periodId,
        bookId: org.bookId,
        actorId,
      });
      await db.execute(sql`
        insert into period_locks
          (org_id, period_id, book_id, subsidiary_id, module, state, reason)
        values (${org.orgId}, ${org.periodId}, ${org.bookId}, null, 'gl', 'closed', 'Month-end close')`);
      await assert.rejects(
        postAllocationRun(preview.id, actorId, "Attempt post into closed period"),
        /closed/,
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "reverse into a closed run period is refused",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    await enableAllocations(org.orgId);
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      const deptA = await seedDepartment(org.orgId, "Dept A");
      await seedSourceEntry(org, actorId, "300.0000");
      const { ruleId } = await seedPeriodRule({
        orgId: org.orgId,
        poolAccountId: org.accounts.adjustment,
        targets: [{ departmentId: deptA, fixedPercent: "100.0000", label: "Dept A" }],
      });
      const preview = await previewAllocationRun({
        orgId: org.orgId,
        ruleId,
        periodId: org.periodId,
        bookId: org.bookId,
        actorId,
      });
      await postAllocationRun(preview.id, actorId, "Post before the close");
      await db.execute(sql`
        insert into period_locks
          (org_id, period_id, book_id, subsidiary_id, module, state, reason)
        values (${org.orgId}, ${org.periodId}, ${org.bookId}, null, 'gl', 'closed', 'Month-end close')`);
      await assert.rejects(
        reverseAllocationRun(preview.id, actorId, "Attempt reverse in closed period", {
          reversalDate: org.date,
        }),
        /closed/,
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "cross-org rule and period references are refused",
  { skip: !DB },
  async () => {
    const orgA = await createScratchOrg();
    await enableAllocations(orgA.orgId);
    const orgB = await createScratchOrg();
    await enableAllocations(orgB.orgId);
    const actorA = (await seedFlowActors(orgA.orgId)).adminId;
    try {
      const { ruleId } = await seedPeriodRule({ orgId: orgB.orgId, poolAccountId: orgB.accounts.adjustment });
      await assert.rejects(
        previewAllocationRun({
          orgId: orgA.orgId,
          ruleId,
          periodId: orgA.periodId,
          bookId: orgA.bookId,
          actorId: actorA,
        }),
        /same organization|does not belong/i,
      );
      const { ruleId: ruleA } = await seedPeriodRule({ orgId: orgA.orgId, poolAccountId: orgA.accounts.adjustment });
      await assert.rejects(
        previewAllocationRun({
          orgId: orgA.orgId,
          ruleId: ruleA,
          periodId: orgB.periodId,
          bookId: orgA.bookId,
          actorId: actorA,
        }),
        /same organization|does not belong/i,
      );
    } finally {
      await dropScratchOrg(orgA.orgId);
      await dropScratchOrg(orgB.orgId);
    }
  },
);

test(
  "a second posted run for the same rule, period, book and subsidiary is refused",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    await enableAllocations(org.orgId);
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      const deptA = await seedDepartment(org.orgId, "Dept A");
      await seedSourceEntry(org, actorId, "300.0000");
      const { ruleId } = await seedPeriodRule({
        orgId: org.orgId,
        poolAccountId: org.accounts.adjustment,
        targets: [{ departmentId: deptA, fixedPercent: "100.0000", label: "Dept A" }],
      });
      const first = await previewAllocationRun({
        orgId: org.orgId,
        ruleId,
        periodId: org.periodId,
        bookId: org.bookId,
        actorId,
      });
      await postAllocationRun(first.id, actorId, "First monthly sweep");
      const second = await previewAllocationRun({
        orgId: org.orgId,
        ruleId,
        periodId: org.periodId,
        bookId: org.bookId,
        actorId,
      });
      await assert.rejects(
        postAllocationRun(second.id, actorId, "Duplicate monthly sweep"),
        /already.*posted|one posted run/i,
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "driver basis with dynamic targets apportions on the injected resolver vector",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    await enableAllocations(org.orgId);
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      const deptA = await seedDepartment(org.orgId, "Dept A");
      const deptB = await seedDepartment(org.orgId, "Dept B");
      await seedSourceEntry(org, actorId, "1000.0000");
      const driverId = await seedDriver({ orgId: org.orgId, dimension: "department" });
      const { ruleId } = await seedPeriodRule({
        orgId: org.orgId,
        poolAccountId: org.accounts.adjustment,
        impact: "reclass",
        basisKind: "driver",
        driverId,
        targetKind: "dynamic",
        dynamicTarget: { dimension: "department", minWeight: "0" },
      });
      const stub: DriverResolver = {
        resolve: async () =>
          new Map([
            [deptA, "3.0000"],
            [deptB, "1.0000"],
          ]),
      };
      const preview = await previewAllocationRun(
        {
          orgId: org.orgId,
          ruleId,
          periodId: org.periodId,
          bookId: org.bookId,
          actorId,
        },
        { driverResolver: stub },
      );
      assert.equal(preview.sourceTotal, "1000.0000");
      const byKey = new Map(preview.computation.targets.map((target) => [target.key, target]));
      assert.equal(byKey.get(deptA)?.amount, "750.0000");
      assert.equal(byKey.get(deptB)?.amount, "250.0000");
      const posted = await postAllocationRun(preview.id, actorId, "Post driver-based sweep");
      assert.equal(posted.status, "posted");
      const coords = await coordinateTotals(org.orgId);
      assert.equal(coords.get(`${org.accounts.adjustment}|${deptA}`), "750.0000");
      assert.equal(coords.get(`${org.accounts.adjustment}|${deptB}`), "250.0000");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "driver basis resolves through A2's dispatcher with no injected double",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    await enableAllocations(org.orgId);
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      const deptA = await seedDepartment(org.orgId, "Dept A");
      const deptB = await seedDepartment(org.orgId, "Dept B");
      await seedSourceEntry(org, actorId, "1000.0000");
      const driverId = await seedDriver({ orgId: org.orgId, dimension: "department", sourceKind: "manual" });
      await seedDriverValue({ orgId: org.orgId, driverId, dimensionValueId: deptA, value: "3.0000" });
      await seedDriverValue({ orgId: org.orgId, driverId, dimensionValueId: deptB, value: "1.0000" });
      const { ruleId } = await seedPeriodRule({
        orgId: org.orgId,
        poolAccountId: org.accounts.adjustment,
        impact: "reclass",
        basisKind: "driver",
        driverId,
        targetKind: "dynamic",
        dynamicTarget: { dimension: "department", minWeight: "0" },
      });
      // No injected resolver: the engine falls back to A2's dispatcher.
      const preview = await previewAllocationRun({
        orgId: org.orgId,
        ruleId,
        periodId: org.periodId,
        bookId: org.bookId,
        actorId,
      });
      assert.equal(preview.sourceTotal, "1000.0000");
      const amounts = new Map(preview.computation.targets.map((target) => [target.key, target.amount]));
      assert.equal(amounts.get(deptA), "750.0000");
      assert.equal(amounts.get(deptB), "250.0000");
      const posted = await postAllocationRun(preview.id, actorId, "A2 dispatcher post check");
      assert.ok(posted.journalEntryId);
      const run = await getRun(org.orgId, preview.id);
      assert.equal(run.status, "posted");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "post refuses a run whose rule was deactivated after preview",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    await enableAllocations(org.orgId);
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      const deptA = await seedDepartment(org.orgId, "Dept A");
      await seedSourceEntry(org, actorId, "300.0000");
      const { ruleId } = await seedPeriodRule({
        orgId: org.orgId,
        poolAccountId: org.accounts.adjustment,
        targets: [{ departmentId: deptA, fixedPercent: "100.0000", label: "Dept A" }],
      });
      const preview = await previewAllocationRun({
        orgId: org.orgId,
        ruleId,
        periodId: org.periodId,
        bookId: org.bookId,
        actorId,
      });
      await db.execute(sql`update allocation_rules set is_active = false where id = ${ruleId}`);
      await assert.rejects(postAllocationRun(preview.id, actorId, "Post after deactivation"), /not active/);
      const run = await getRun(org.orgId, preview.id);
      assert.equal(run.status, "previewed");
      assert.equal(run.journalEntryId, null);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "post refuses a run whose version was retired after preview",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    await enableAllocations(org.orgId);
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      const deptA = await seedDepartment(org.orgId, "Dept A");
      await seedSourceEntry(org, actorId, "300.0000");
      const { ruleId, versionId } = await seedPeriodRule({
        orgId: org.orgId,
        poolAccountId: org.accounts.adjustment,
        targets: [{ departmentId: deptA, fixedPercent: "100.0000", label: "Dept A" }],
      });
      const preview = await previewAllocationRun({
        orgId: org.orgId,
        ruleId,
        periodId: org.periodId,
        bookId: org.bookId,
        actorId,
      });
      await db.execute(sql`update allocation_rule_versions set status = 'retired' where id = ${versionId}`);
      await assert.rejects(postAllocationRun(preview.id, actorId, "Post after retire"), /retired/);
      const run = await getRun(org.orgId, preview.id);
      assert.equal(run.status, "previewed");
      assert.equal(run.journalEntryId, null);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "preview refuses an empty source pool instead of posting a silent zero run",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    await enableAllocations(org.orgId);
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      const deptA = await seedDepartment(org.orgId, "Dept A");
      const { ruleId } = await seedPeriodRule({
        orgId: org.orgId,
        poolAccountId: org.accounts.adjustment,
        targets: [{ departmentId: deptA, fixedPercent: "100.0000", label: "Dept A" }],
      });
      await assert.rejects(
        previewAllocationRun({
          orgId: org.orgId,
          ruleId,
          periodId: org.periodId,
          bookId: org.bookId,
          actorId,
        }),
        /no source lines/,
      );
      const listed = await listRuns(org.orgId, { ruleId });
      assert.equal(listed.total, 0);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "report-only lineage keeps driver evidence for explicit driver-basis targets",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    await enableAllocations(org.orgId);
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      const deptA = await seedDepartment(org.orgId, "Dept A");
      const deptB = await seedDepartment(org.orgId, "Dept B");
      await seedSourceEntry(org, actorId, "200.0000");
      const driverId = await seedDriver({ orgId: org.orgId, dimension: "department", sourceKind: "manual" });
      await seedDriverValue({ orgId: org.orgId, driverId, dimensionValueId: deptA, value: "3.0000" });
      await seedDriverValue({ orgId: org.orgId, driverId, dimensionValueId: deptB, value: "1.0000" });
      const { ruleId } = await seedPeriodRule({
        orgId: org.orgId,
        poolAccountId: org.accounts.adjustment,
        impact: "report_only",
        basisKind: "driver",
        driverId,
        targets: [
          { departmentId: deptA, fixedPercent: null, label: "Dept A" },
          { departmentId: deptB, fixedPercent: null, label: "Dept B" },
        ],
      });
      const preview = await previewAllocationRun({
        orgId: org.orgId,
        ruleId,
        periodId: org.periodId,
        bookId: org.bookId,
        actorId,
      });
      const posted = await postAllocationRun(preview.id, actorId, "Post statistical attribution");
      assert.equal(posted.status, "posted");
      assert.equal(posted.journalEntryId, null);
      const lineage = (await db.execute<{ driver_value: string | null; amount: string }>(sql`
        select driver_value::text as driver_value, amount::text as amount from allocation_lineage
         where org_id = ${org.orgId} and run_id = ${preview.id}`)).rows;
      assert.equal(lineage.length, 2);
      assert.deepEqual(
        lineage.map((row) => row.driver_value).sort(),
        ["1.0000", "3.0000"],
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "listRuns and getRun expose the stored computation",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    await enableAllocations(org.orgId);
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      const deptA = await seedDepartment(org.orgId, "Dept A");
      await seedSourceEntry(org, actorId, "300.0000");
      const { ruleId } = await seedPeriodRule({
        orgId: org.orgId,
        poolAccountId: org.accounts.adjustment,
        targets: [{ departmentId: deptA, fixedPercent: "100.0000", label: "Dept A" }],
      });
      const preview = await previewAllocationRun({
        orgId: org.orgId,
        ruleId,
        periodId: org.periodId,
        bookId: org.bookId,
        actorId,
      });
      const listed = await listRuns(org.orgId, { ruleId });
      assert.equal(listed.total, 1);
      assert.equal(listed.runs.length, 1);
      assert.equal(listed.runs[0]?.id, preview.id);
      assert.equal(listed.runs[0]?.sourceTotal, "300.0000");
      const run = await getRun(org.orgId, preview.id);
      assert.equal(run.fingerprint, preview.fingerprint);
      assert.equal((run.computation as RunComputation).sourceTotal, "300.0000");
      assert.equal((run.computation as RunComputation).targets.length, 1);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "S4: a pinned run whose targets cross the pin is refused at preview and post",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    await enableAllocations(org.orgId);
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      const subB = randomUUID();
      await db.execute(sql`
        insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
        values (${subB}, ${org.orgId}, ${org.subsidiaryId}, 'Branch Co', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`);
      await seedSourceEntry(org, actorId, "100.0000");
      const dept = await seedDepartment(org.orgId, "Branch Dept");
      const { ruleId, versionId } = await seedPeriodRule({
        orgId: org.orgId,
        poolAccountId: org.accounts.adjustment,
        targets: [{ departmentId: dept, subsidiaryId: subB, fixedPercent: "100.0000", label: "Branch" }],
      });
      const runCount = async (): Promise<number> => Number((await db.execute<{ count: string }>(sql`
        select count(*)::text as count from allocation_runs where org_id = ${org.orgId}`)).rows[0]?.count ?? 0);
      const before = await runCount();
      // Pinned to A with a B target: refused by name, nothing persisted.
      await assert.rejects(
        () => previewAllocationRun({
          orgId: org.orgId, ruleId, periodId: org.periodId, bookId: org.bookId,
          subsidiaryId: org.subsidiaryId, actorId, trigger: "manual",
        }),
        (error: unknown) =>
          error instanceof AllocationRunError &&
          error.message.includes(subB) &&
          /outside the pinned subsidiary/.test(error.message),
      );
      assert.equal(await runCount(), before);
      // Unpinned org-wide sweeps keep their existing behaviour.
      const open = await previewAllocationRun({
        orgId: org.orgId, ruleId, periodId: org.periodId, bookId: org.bookId, actorId, trigger: "manual",
      });
      assert.equal(open.subsidiaryId, null);
      assert.equal(open.computation.targets[0]?.coordinate.subsidiaryId, subB);
      // A stored crossed run is refused at post by the same name.
      const crossedId = randomUUID();
      const crossedComputation = {
        ruleId, versionId, definitionHash: "testhash", periodId: org.periodId, bookId: org.bookId,
        subsidiaryId: org.subsidiaryId, sourceMeasure: "period_activity",
        sources: [{ accountId: org.accounts.adjustment, subsidiaryId: org.subsidiaryId, amount: "100.0000", lineCount: 1 }],
        sourceTotal: "100.0000",
        targets: [{ key: "t1", coordinate: { subsidiaryId: subB }, amount: "100.0000" }],
        lines: [], residualPolicy: "largest_share", impact: "report_only",
      };
      await db.execute(sql`
        insert into allocation_runs
          (id, org_id, rule_id, version_id, definition_hash, period_id, book_id, subsidiary_id,
           status, trigger_kind, source_total, allocated_total, residual,
           computation, fingerprint, requested_by, created_by, updated_by)
        values (${crossedId}, ${org.orgId}, ${ruleId}, ${versionId}, 'testhash', ${org.periodId}, ${org.bookId},
          ${org.subsidiaryId}, 'previewed', 'manual', '100.0000', '100.0000', '0.00',
          ${JSON.stringify(crossedComputation)}::jsonb, 'fp-crossed', ${actorId}, ${actorId}, ${actorId})`);
      await assert.rejects(() => postAllocationRun(crossedId, actorId, "posting a crossed run"),
        (error: unknown) =>
          error instanceof AllocationRunError && /outside the pinned subsidiary/.test(error.message));
      const kept = (await db.execute<{ status: string }>(sql`
        select status from allocation_runs where org_id = ${org.orgId} and id = ${crossedId}`)).rows[0];
      assert.equal(kept?.status, "previewed");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
test(
  "S5: a B-only rule pinned to A is refused; pinned to B it sweeps B",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    await enableAllocations(org.orgId);
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      const subB = randomUUID();
      await db.execute(sql`
        insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
        values (${subB}, ${org.orgId}, ${org.subsidiaryId}, 'Branch Co', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`);
      await seedSourceEntry(org, actorId, "100.0000", null, org.subsidiaryId);
      await seedSourceEntry(org, actorId, "250.0000", null, subB);
      const dept = await seedDepartment(org.orgId, "Shared Dept");
      const { ruleId } = await seedPeriodRule({
        orgId: org.orgId,
        poolAccountId: org.accounts.adjustment,
        dimensionFilters: { subsidiaryIds: [subB] },
        targets: [{ departmentId: dept, fixedPercent: "100.0000", label: "Dept" }],
      });
      const runCount = async (): Promise<number> => Number((await db.execute<{ count: string }>(sql`
        select count(*)::text as count from allocation_runs where org_id = ${org.orgId}`)).rows[0]?.count ?? 0);
      const before = await runCount();
      // Pinned to A under a B-only rule: the pin/filter intersection is
      // empty, so refuse by name instead of allocating A's books.
      await assert.rejects(
        () => previewAllocationRun({
          orgId: org.orgId, ruleId, periodId: org.periodId, bookId: org.bookId,
          subsidiaryId: org.subsidiaryId, actorId, trigger: "manual",
        }),
        (error: unknown) =>
          error instanceof AllocationRunError &&
          /does not cover subsidiary/.test(error.message) &&
          error.message.includes(org.subsidiaryId),
      );
      assert.equal(await runCount(), before);
      // Pinned to B the same rule sweeps exactly B's pool.
      const pinned = await previewAllocationRun({
        orgId: org.orgId, ruleId, periodId: org.periodId, bookId: org.bookId,
        subsidiaryId: subB, actorId, trigger: "manual",
      });
      assert.equal(pinned.sourceTotal, "250.0000");
      assert.ok(pinned.computation.sources.every((source) => source.subsidiaryId === subB));
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
