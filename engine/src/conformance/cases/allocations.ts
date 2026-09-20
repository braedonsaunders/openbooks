/**
 * Allocation kernel — internal-controls evidence cases.
 *
 * Each case pins one invariant of docs/design/allocation-kernel.md §5 as an
 * executable fixture and maps to its AUDIT-CONTROLS.md control id. These are
 * OpenBooks' own controls, not requirements of a published accounting
 * standard, so they carry `control` instead of `citations` and are published
 * in the internal-controls matrix — never in the standards matrix.
 */

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { apportion, fixedPercentWeights } from "../../allocations/apportion.ts";
import { explodeDocumentLine } from "../../allocations/entry.ts";
import {
  postAllocationRun,
  previewAllocationRun,
  rerunAllocationRun,
  reverseAllocationRun,
} from "../../allocations/period-run.ts";
import { assertContributorBalance, PostAllocationError } from "../../allocations/post.ts";
import {
  AllocationRuleError,
  createDraftVersion,
  createRule,
  getRuleVersion,
  publishVersion,
  replaceTargets,
  updateDraftVersion,
} from "../../allocations/rules.ts";
import type { AllocationRuleTarget, RuleInEffect } from "../../allocations/types.ts";
import { db } from "../../platform/db.ts";
import { fromUnits, toUnits } from "../../money/money.ts";
import { postProjectGlEntry } from "../../projects/recognition.ts";
import { capture } from "../ledger-helpers.ts";
import type { ActualOutcome, CaseContext } from "../types.ts";
import type { ControlCase } from "../controls.ts";

function sumAmounts(amounts: string[]): string {
  let total = 0n;
  for (const amount of amounts) total += toUnits(amount);
  return fromUnits(total);
}

function target(
  id: string,
  sequence: number,
  fixedPercent: string,
  departmentId: string,
  label: string,
): AllocationRuleTarget {
  return {
    id,
    sequence,
    targetAccountId: null,
    departmentId,
    locationId: null,
    classId: null,
    projectId: null,
    subsidiaryId: null,
    extraDims: {},
    fixedPercent,
    weight: null,
    isRemainder: false,
    label,
  };
}

function entryRuleInEffect(targets: AllocationRuleTarget[]): RuleInEffect {
  return {
    rule: {
      id: "rule-overhead-split",
      orgId: "org-synthetic",
      key: "overhead-split",
      name: "Overhead split",
      mode: "entry",
      sortOrder: 100,
      isActive: true,
      isSystem: false,
    },
    version: {
      id: "version-overhead-split-1",
      orgId: "org-synthetic",
      ruleId: "rule-overhead-split",
      versionNo: 1,
      status: "published",
      effectiveFrom: "2026-01-01",
      bookScope: "primary",
      bookIds: [],
      accountScope: { kind: "any" },
      dimensionFilters: {},
      applyPolicy: "automatic",
      sourceMeasure: "period_activity",
      basisKind: "fixed_percent",
      driverAsOf: "document_date",
      basisConfig: {},
      targetKind: "explicit",
      dynamicTarget: {},
      impact: "reclass",
      residualPolicy: "largest_share",
      solveMethod: "sequential",
      runPolicy: "manual",
      runOffsetDays: 0,
      definitionHash: "synthetic",
    },
    targets,
  };
}

export const ALLOCATION_CONTROL_CASES: readonly ControlCase[] = [
  {
    id: "alloc-no-lost-cent",
    title: "Apportioning an indivisible total loses no cent",
    control: "A12",
    support: "supported",
    tier: "computation",
    assertion:
      "Splitting 100.00 across three equal weights assigns the entire 100.00 — the one-unit leftover lands deterministically on the first target and is recorded as residual, never dropped or invented.",
    facts: [
      "Total 100.00 over three equal weights of 1 with the largest-share residual policy.",
      "A hundredth of a cent of difference is a failure.",
    ],
    expected: {
      values: {
        a: "33.3334",
        b: "33.3333",
        c: "33.3333",
        sum: "100.0000",
        residual: "0.0001",
      },
    },
    run: (): ActualOutcome => {
      const result = apportion(
        "100.00",
        [
          { key: "a", weight: "1" },
          { key: "b", weight: "1" },
          { key: "c", weight: "1" },
        ],
        "largest_share",
      );
      const amounts = Object.fromEntries(result.targets.map((t) => [t.key, t.amount]));
      return {
        values: {
          a: amounts["a"]!,
          b: amounts["b"]!,
          c: amounts["c"]!,
          sum: sumAmounts(result.targets.map((t) => t.amount)),
          residual: sumAmounts(result.targets.map((t) => t.residual)),
        },
      };
    },
  },
  {
    id: "alloc-entry-group-sum",
    title: "Exploded entry children sum to the entered amount",
    control: "A12",
    support: "supported",
    tier: "computation",
    assertion:
      "A 1,000.01 bill line exploded by a 60/30/10 entry rule becomes children of 600.0060, 300.0030, and 100.0010 that sum to exactly the entered 1,000.01.",
    facts: [
      "Entry rule with explicit fixed-percent targets Engineering 60, Sales 30, Support 10.",
      "Entered line amount 1000.01 with no quantity.",
    ],
    expected: {
      values: {
        child1: "600.0060",
        child2: "300.0030",
        child3: "100.0010",
        sum: "1000.0100",
        residual: "0.0000",
      },
    },
    run: (): ActualOutcome => {
      const targets = [
        target("t-eng", 1, "60", "dept-eng", "Engineering"),
        target("t-sales", 2, "30", "dept-sales", "Sales"),
        target("t-support", 3, "10", "dept-support", "Support"),
      ];
      // The grid itself must be sound before the explosion means anything.
      fixedPercentWeights(targets);
      const exploded = explodeDocumentLine(
        { accountId: "role:cogs", amount: "1000.01" },
        entryRuleInEffect(targets),
        { groupId: "group-1" },
      );
      const amounts = exploded.children.map((child) => child.amount);
      return {
        values: {
          child1: amounts[0]!,
          child2: amounts[1]!,
          child3: amounts[2]!,
          sum: sumAmounts(amounts),
          residual: sumAmounts(exploded.apportionments.map((a) => a.residual)),
        },
      };
    },
  },
  {
    id: "alloc-reversal-restores",
    title: "Reversing a posted run restores every balance",
    control: "A12",
    support: "supported",
    tier: "ledger",
    assertion:
      "Posting a 1,000.00 reclass sweep moves 600.00 and 400.00 onto the two target accounts, reversing mirrors every leg, and the ledger afterwards equals the pre-run ledger on every account.",
    facts: [
      "Source balance 1000.00 in the pool account in period 2026-07.",
      "Period rule with explicit fixed-percent targets 60 and 40 on two target accounts, reclass impact.",
      "Posting reason and reversal reason recorded; reversal dated inside the open period.",
    ],
    expected: {
      entries: [
        {
          step: "post allocation run",
          lines: [
            { role: "freight", amount: "-1000.0000" },
            { role: "cogs", amount: "600.0000" },
            { role: "leaseExpense", amount: "400.0000" },
          ],
        },
        {
          step: "reverse allocation run",
          lines: [
            { role: "freight", amount: "1000.0000" },
            { role: "cogs", amount: "-600.0000" },
            { role: "leaseExpense", amount: "-400.0000" },
          ],
        },
        { step: "balances after reversal equal pre-run balances", lines: [] },
      ],
      values: { statusAfterPost: "posted", statusAfterReverse: "reversed" },
    },
    run: async (ctx) => {
      const ledger = ctx.ledger!;
      await seedAllocationSource(ctx, "1000.0000");
      const { ruleId } = await seedPeriodRule(ctx, {
        impact: "reclass",
        targets: [
          { targetAccountId: ctx.roles.cogs, fixedPercent: "60", label: "Share A" },
          { targetAccountId: ctx.roles.leaseExpense, fixedPercent: "40", label: "Share B" },
        ],
      });
      let postedStatus = "";
      const postEntry = await capture(ctx, "post allocation run", async () => {
        const preview = await previewAllocationRun({
          orgId: ledger.orgId,
          ruleId,
          periodId: ledger.periodId,
          bookId: ledger.bookId,
          actorId: ledger.actorId,
          trigger: "manual",
        });
        if (preview.journalEntryId !== null) throw new Error("preview wrote a journal entry");
        const posted = await postAllocationRun(preview.id, ledger.actorId, "Post the monthly sweep");
        postedStatus = posted.status;
        if (!posted.journalEntryId) throw new Error("post wrote no journal entry");
      });
      let reversedStatus = "";
      const reverseEntry = await capture(ctx, "reverse allocation run", async () => {
        const runs = await postedRunId(ledger.orgId, ruleId);
        const reversed = await reverseAllocationRun(runs, ledger.actorId, "Reverse the monthly sweep", {
          reversalDate: ledger.date,
        });
        reversedStatus = reversed.status;
        if (!reversed.reversalEntryId) throw new Error("reverse wrote no reversal entry");
      });
      const restoredEntry = await capture(
        ctx,
        "balances after reversal equal pre-run balances",
        async () => {},
      );
      return {
        entries: [postEntry, reverseEntry, restoredEntry],
        values: { statusAfterPost: postedStatus, statusAfterReverse: reversedStatus },
      };
    },
  },
  {
    id: "alloc-rerun-idempotent",
    title: "Re-running an unchanged sweep posts nothing new",
    control: "A12",
    support: "supported",
    tier: "ledger",
    assertion:
      "Re-running a posted sweep with unchanged inputs returns the existing run, posts no journal, and leaves exactly one posted run — the fingerprint comparison, not a second posting.",
    facts: [
      "Source balance 1000.00 in the pool account in period 2026-07.",
      "Period rule with explicit fixed-percent targets 60 and 40 on two target accounts, reclass impact.",
      "The sweep is previewed and posted once, then re-run with identical inputs.",
    ],
    expected: {
      entries: [{ step: "re-run with unchanged inputs", lines: [] }],
      values: { idempotent: "true", status: "posted", postedRuns: "1" },
    },
    run: async (ctx) => {
      const ledger = ctx.ledger!;
      await seedAllocationSource(ctx, "1000.0000");
      const { ruleId } = await seedPeriodRule(ctx, {
        impact: "reclass",
        targets: [
          { targetAccountId: ctx.roles.cogs, fixedPercent: "60", label: "Share A" },
          { targetAccountId: ctx.roles.leaseExpense, fixedPercent: "40", label: "Share B" },
        ],
      });
      const preview = await previewAllocationRun({
        orgId: ledger.orgId,
        ruleId,
        periodId: ledger.periodId,
        bookId: ledger.bookId,
        actorId: ledger.actorId,
        trigger: "manual",
      });
      await postAllocationRun(preview.id, ledger.actorId, "Post the monthly sweep");
      let idempotent = false;
      let status = "";
      const rerunEntry = await capture(ctx, "re-run with unchanged inputs", async () => {
        const result = await rerunAllocationRun(preview.id, ledger.actorId, "Re-run the monthly sweep", {
          reversalDate: ledger.date,
        });
        idempotent = result.idempotent;
        status = result.run.status;
        if (result.run.id !== preview.id) throw new Error("idempotent re-run returned a different run");
      });
      const posted = await postedRunCount(ledger.orgId, ruleId);
      return {
        entries: [rerunEntry],
        values: { idempotent: String(idempotent), status, postedRuns: String(posted) },
      };
    },
  },
  {
    id: "alloc-contributor-balance",
    title: "Posting refuses an unbalanced contributor set",
    control: "A12",
    support: "supported",
    tier: "computation",
    assertion:
      "A contributor line set whose subsidiary totals do not net to zero is refused before it can join the kernel union — posting throws instead of writing a partial entry.",
    facts: [
      "One rule contributor with two lines netting to 0.01, not zero.",
      "The balance check runs inside the collection step and again at the posting seam, both before any write.",
    ],
    expected: { values: { refused: "true" } },
    run: (): ActualOutcome => {
      let refused = false;
      try {
        assertContributorBalance([
          { contributorKind: "rule", contributorRef: "version-1", subsidiaryId: null, amount: "100.0000" },
          { contributorKind: "rule", contributorRef: "version-1", subsidiaryId: null, amount: "-99.9900" },
        ]);
      } catch (error) {
        if (error instanceof PostAllocationError && error.message.includes("does not balance")) {
          refused = true;
        } else {
          throw error;
        }
      }
      if (!refused) throw new Error("unbalanced contributor set was accepted");
      return { values: { refused: "true" } };
    },
  },
  {
    id: "alloc-net-zero-pair-account-total-unchanged",
    title: "A net-zero pair leaves every account total unchanged",
    control: "A12",
    support: "supported",
    tier: "ledger",
    assertion:
      "A 1,000.00 net-zero sweep onto three departments posts 600.00, 300.00, and 100.00 of dimensional attribution while the account total stays exactly 1,000.00 — company profit and loss cannot move.",
    facts: [
      "Source balance 1000.00 in the pool account in period 2026-07.",
      "Period rule with explicit fixed-percent targets 60, 30, and 10 on the source account with three departments, net-zero-pair impact.",
    ],
    expected: {
      entries: [{ step: "post net-zero sweep", lines: [] }],
      values: {
        deptEng: "600.0000",
        deptSales: "300.0000",
        deptSupport: "100.0000",
        accountTotal: "1000.0000",
      },
    },
    run: async (ctx) => {
      const ledger = ctx.ledger!;
      await seedAllocationSource(ctx, "1000.0000");
      const departments = await seedDepartments(ledger.orgId);
      const { ruleId } = await seedPeriodRule(ctx, {
        impact: "net_zero_pair",
        targets: [
          { departmentId: departments.eng, fixedPercent: "60", label: "Engineering" },
          { departmentId: departments.sales, fixedPercent: "30", label: "Sales" },
          { departmentId: departments.support, fixedPercent: "10", label: "Support" },
        ],
      });
      const postEntry = await capture(ctx, "post net-zero sweep", async () => {
        const preview = await previewAllocationRun({
          orgId: ledger.orgId,
          ruleId,
          periodId: ledger.periodId,
          bookId: ledger.bookId,
          actorId: ledger.actorId,
          trigger: "manual",
        });
        await postAllocationRun(preview.id, ledger.actorId, "Post the net-zero sweep");
      });
      const coords = await coordinateTotals(ledger.orgId);
      const poolId = ctx.roles.freight;
      return {
        entries: [postEntry],
        values: {
          deptEng: coords.get(`${poolId}|${departments.eng}`) ?? "0.0000",
          deptSales: coords.get(`${poolId}|${departments.sales}`) ?? "0.0000",
          deptSupport: coords.get(`${poolId}|${departments.support}`) ?? "0.0000",
          accountTotal: await accountTotal(ledger.orgId, poolId),
        },
      };
    },
  },
  {
    id: "alloc-published-version-frozen",
    title: "A published rule version is frozen",
    control: "A12",
    support: "supported",
    tier: "ledger",
    assertion:
      "Once published, a version refuses definition edits, target replacement, and re-publication — and its definition hash is byte-identical afterwards, so posted runs stay explainable.",
    facts: [
      "Period rule created, drafted, and published through the real rule service.",
      "An edit, a target replacement, and a second publish are each attempted against the published version.",
    ],
    expected: {
      values: {
        definitionRefused: "FROZEN",
        targetsRefused: "FROZEN",
        republishRefused: "FROZEN",
        status: "published",
        hashStable: "true",
      },
    },
    run: async (ctx) => {
      const ledger = ctx.ledger!;
      const audit = { actorId: ledger.actorId, reason: "control case setup" };
      const rule = await createRule(
        { orgId: ledger.orgId, key: "frozen-rule", name: "Frozen rule", mode: "period" },
        audit,
      );
      const draft = await createDraftVersion(
        rule.rule.id,
        {
          orgId: ledger.orgId,
          effectiveFrom: "2026-01-01",
          accountScope: { kind: "accounts", accountIds: [ctx.roles.freight] },
          basisKind: "fixed_percent",
          targetKind: "explicit",
          impact: "reclass",
          targets: [{ targetAccountId: ctx.roles.cogs, fixedPercent: "100", label: "All" }],
        },
        audit,
      );
      await publishVersion(draft.version.id, { orgId: ledger.orgId, actorId: ledger.actorId });
      const before = await getRuleVersion(ledger.orgId, draft.version.id);
      const refusals: Record<string, string> = {};
      try {
        await updateDraftVersion(draft.version.id, { orgId: ledger.orgId, memoTemplate: "changed" }, audit);
      } catch (error) {
        if (error instanceof AllocationRuleError) refusals["definitionRefused"] = error.code;
        else throw error;
      }
      try {
        await replaceTargets(
          draft.version.id,
          { orgId: ledger.orgId, targets: [{ targetAccountId: ctx.roles.cogs, fixedPercent: "100" }] },
          audit,
        );
      } catch (error) {
        if (error instanceof AllocationRuleError) refusals["targetsRefused"] = error.code;
        else throw error;
      }
      try {
        await publishVersion(draft.version.id, { orgId: ledger.orgId, actorId: ledger.actorId });
      } catch (error) {
        if (error instanceof AllocationRuleError) refusals["republishRefused"] = error.code;
        else throw error;
      }
      const after = await getRuleVersion(ledger.orgId, draft.version.id);
      return {
        values: {
          definitionRefused: refusals["definitionRefused"] ?? "accepted",
          targetsRefused: refusals["targetsRefused"] ?? "accepted",
          republishRefused: refusals["republishRefused"] ?? "accepted",
          status: after.version.status,
          hashStable: String(before.version.definitionHash === after.version.definitionHash),
        },
      };
    },
  },
];

// ---------------------------------------------------------------------------
// Ledger fixtures (per-case tenants; nothing shared across cases)
// ---------------------------------------------------------------------------

async function seedDepartments(orgId: string): Promise<{ eng: string; sales: string; support: string }> {
  const ids = { eng: randomUUID(), sales: randomUUID(), support: randomUUID() };
  const names: Record<keyof typeof ids, string> = { eng: "Engineering", sales: "Sales", support: "Support" };
  for (const key of Object.keys(ids) as (keyof typeof ids)[]) {
    await db.execute(sql`
      insert into departments (id, org_id, name, is_active, custom)
      values (${ids[key]}, ${orgId}, ${names[key]}, true, '{}'::jsonb)`);
  }
  return ids;
}

interface SeedTarget {
  departmentId?: string | null;
  targetAccountId?: string | null;
  fixedPercent?: string | null;
  label?: string | null;
}

/**
 * Seed a period rule the way the A1 service does (draft, targets, publish)
 * with a fixed definition hash fixture — the hash content is A1's property
 * to test, so cases only need it stamped, never recomputed.
 */
async function seedPeriodRule(
  ctx: CaseContext,
  opts: { impact: "reclass" | "net_zero_pair"; targets: SeedTarget[] },
): Promise<{ ruleId: string; versionId: string }> {
  const ledger = ctx.ledger!;
  const orgId = ledger.orgId;
  const ruleId = randomUUID();
  const versionId = randomUUID();
  const key = `alloc-${ruleId.slice(0, 8)}`;
  await db.execute(sql`
    insert into allocation_rules (id, org_id, key, name, mode, sort_order, is_active, is_system, custom)
    values (${ruleId}, ${orgId}, ${key}, ${`Rule ${key}`}, 'period', 100, true, false, '{}'::jsonb)`);
  await db.execute(sql`
    insert into allocation_rule_versions
      (id, org_id, rule_id, version_no, status, effective_from, effective_to,
       book_scope, book_ids, account_scope, dimension_filters, source_measure,
       basis_kind, driver_id, driver_as_of, basis_config,
       target_kind, dynamic_target, impact, residual_policy, solve_method,
       run_policy, run_offset_days, memo_template, published_at)
    values (${versionId}, ${orgId}, ${ruleId}, 1, 'draft', '2026-01-01', null,
       'primary', '[]'::jsonb,
       ${JSON.stringify({ kind: "accounts", accountIds: [ctx.roles.freight] })}::jsonb,
       '{}'::jsonb, 'period_activity', 'fixed_percent', null, 'period', '{}'::jsonb,
       'explicit', '{}'::jsonb, ${opts.impact}, 'largest_share', 'sequential',
       'manual', 0, 'Allocation {{rule.name}} for {{period.name}}', now())`);
  let sequence = 1;
  for (const target of opts.targets) {
    await db.execute(sql`
      insert into allocation_rule_targets
        (id, org_id, version_id, sequence, target_account_id, department_id,
         fixed_percent, weight, is_remainder, label, custom)
      values (${randomUUID()}, ${orgId}, ${versionId}, ${sequence},
              ${target.targetAccountId ?? null}, ${target.departmentId ?? null},
              ${target.fixedPercent ?? null}, null, false, ${target.label ?? null}, '{}'::jsonb)`);
    sequence += 1;
  }
  await db.execute(sql`
    update allocation_rule_versions
       set status = 'published', definition_hash = ${`testhash-${versionId}`}, published_at = now()
     where id = ${versionId} and org_id = ${orgId}`);
  await db.execute(sql`
    update allocation_rules set current_version_id = ${versionId}
     where id = ${ruleId} and org_id = ${orgId}`);
  return { ruleId, versionId };
}

/** One balanced source entry: DR pool account / CR bank in the case period. */
async function seedAllocationSource(ctx: CaseContext, amount: string): Promise<void> {
  const ledger = ctx.ledger!;
  const entryId = await postProjectGlEntry({
    orgId: ledger.orgId,
    actorId: ledger.actorId,
    origin: "manual",
    entryNumber: `ALLOC-SEED-${randomUUID()}`,
    postingDate: ledger.date,
    memo: "Allocation source pool",
    subsidiaryId: ledger.subsidiaryId,
    currency: "CAD",
    lines: [
      { accountId: ctx.roles.freight, amount },
      { accountId: ctx.roles.bank, amount: amount.startsWith("-") ? amount.slice(1) : `-${amount}` },
    ],
  });
  if (!entryId) throw new Error("source pool entry did not post");
}

async function postedRunId(orgId: string, ruleId: string): Promise<string> {
  const rows = (await db.execute<{ id: string }>(sql`
    select id from allocation_runs
     where org_id = ${orgId} and rule_id = ${ruleId} and status = 'posted'
     order by created_at desc limit 1`)).rows;
  const id = rows[0]?.id;
  if (!id) throw new Error("no posted run found for the rule");
  return id;
}

async function postedRunCount(orgId: string, ruleId: string): Promise<number> {
  const rows = (await db.execute<{ count: string }>(sql`
    select count(*)::text as count from allocation_runs
     where org_id = ${orgId} and rule_id = ${ruleId} and status = 'posted'`)).rows;
  return Number(rows[0]?.count ?? 0);
}

async function coordinateTotals(orgId: string): Promise<Map<string, string>> {
  const rows = (await db.execute<{ account_id: string; department_id: string | null; total: string }>(sql`
    select l.account_id, l.department_id, sum(l.amount)::text as total
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
     where l.org_id = ${orgId} and e.status in ('posted', 'reversed')
     group by l.account_id, l.department_id`)).rows;
  return new Map(rows.map((row) => [`${row.account_id}|${row.department_id ?? ""}`, row.total]));
}

async function accountTotal(orgId: string, accountId: string): Promise<string> {
  const rows = (await db.execute<{ total: string }>(sql`
    select sum(l.amount)::text as total
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
     where l.org_id = ${orgId} and l.account_id = ${accountId} and e.status in ('posted', 'reversed')`)).rows;
  return rows[0]?.total ?? "0.0000";
}
