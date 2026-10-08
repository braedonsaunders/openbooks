import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { isIsoCalendarDate } from "../platform/business-date.ts";
import { add, isZero, neg, normalizeMoney, sum } from "../money/money.ts";
import { roundCurrencyMoney } from "../fx/currencies.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { featureEnabled, type FeatureState } from "../organization/feature-registry.ts";
import { lockLedgerSetupFence } from "../organization/ledger-setup-fence.ts";
import { loadSubsidiaryContext, SubsidiaryError, validateSubsidiaryRestrictions, type SubsidiaryContext } from "../organization/subsidiaries.ts";
import { assertPeriodModulesOpen, CloseError } from "../periods/period-policy.ts";
import { loadControlAccounts, ControlAccountsIncompleteError } from "../records/control-accounts.ts";
import { postEntry } from "../journal/post-entry.ts";
import { eligibleWipSourcesSql } from "./wip-sources.ts";

/**
 * Period-end accrual of unbilled time-and-materials revenue.
 *
 * Work performed by a period end but invoiced later is revenue of the period
 * it was performed in. For projects that recognize revenue as invoiced and
 * bill source lines (time and materials, cost plus), the accrual debits the
 * Unbilled receivable control account and credits the revenue account the
 * eventual invoice will credit, project-tagged, dated the period end. Its
 * mirror reversal is dated the first day of the following period, so the
 * invoice's own revenue lands without double counting.
 *
 * Valuation is the shared WIP source valuation (wip-sources.ts) as of the
 * period end. Each run measures the required accrual per (project, legal
 * entity, revenue account, currency), subtracts everything already accrued
 * for that key and period, and posts only the difference as a new immutable
 * accrual/reversal pair. An unchanged rerun posts nothing; a correction is
 * an additional pair, never an edit. Both legs, the accrual evidence rows and
 * the run audit commit in one transaction under a per-period advisory lock.
 */

export class UnbilledAccrualError extends Error {
  readonly name = "UnbilledAccrualError";
  constructor(message: string, readonly code: UnbilledAccrualProblemCode, readonly status = 422) {
    super(message);
  }
}

export type UnbilledAccrualProblemCode =
  | "feature_disabled"
  | "period_not_found"
  | "adjustment_period"
  | "next_period_missing"
  | "period_closed"
  | "unbilled_account_unmapped"
  | "revenue_account_unmapped"
  | "control_accounts_invalid"
  | "foreign_currency"
  | "currency_missing"
  | "subsidiary_invalid"
  | "no_primary_book"
  | "actor_required"
  | "posting_incomplete";

export interface UnbilledAccrualProblem {
  code: UnbilledAccrualProblemCode;
  message: string;
  projectId?: string;
}

export interface UnbilledAccrualPeriodRef {
  periodId?: string | null;
  periodEnd?: string | null;
}

export interface UnbilledAccrualLine {
  projectId: string;
  projectCode: string | null;
  projectName: string;
  subsidiaryId: string;
  currency: string;
  revenueAccountId: string;
  /** Unbilled value at the period end, after the not-to-exceed ceiling. */
  unbilled: string;
  /** Already accrued for this key and period by earlier runs. */
  accrued: string;
  /** What a run would post now: unbilled − accrued. */
  delta: string;
  sourceCount: number;
}

export interface UnbilledAccrualPreview {
  period: { id: string; name: string; startsOn: string; endsOn: string };
  reversal: { periodId: string | null; periodName: string | null; date: string | null };
  /** Per currency: unbilled at period end, accrued so far, still to post. */
  totals: { currency: string; unbilled: string; accrued: string; delta: string }[];
  /** Projects with unbilled work or an accrual to correct. */
  projectCount: number;
  lines: UnbilledAccrualLine[];
  /** True when every key's delta is zero and nothing blocks a run. */
  upToDate: boolean;
  problems: UnbilledAccrualProblem[];
}

export interface UnbilledAccrualRunResult {
  runId: string | null;
  periodId: string;
  posted: { subsidiaryId: string; currency: string; accrualEntryId: string; reversalEntryId: string; amount: string }[];
  lines: UnbilledAccrualLine[];
}

type AccrualPeriod = {
  id: string;
  name: string;
  starts_on: string;
  ends_on: string;
  is_adjustment: boolean;
  next_period_id: string | null;
  next_starts_on: string | null;
  next_name: string | null;
};

/** One valued group of unbilled sources before account resolution. */
export interface UnbilledSourceGroup {
  projectId: string;
  projectCode: string | null;
  projectName: string;
  projectSubsidiaryId: string | null;
  sourceCurrency: string | null;
  itemName: string | null;
  /** Item income account; null when the item has none or the profile credits a fixed account. */
  incomeAccountId: string | null;
  usesProjectRevenue: boolean;
  amount: string;
  sourceCount: number;
}

/** One previously accrued key and its running total. */
export interface AccruedKey {
  projectId: string;
  subsidiaryId: string;
  revenueAccountId: string;
  currency: string;
  amount: string;
}

export function accrualKey(k: { projectId: string; subsidiaryId: string; revenueAccountId: string; currency: string }): string {
  return `${k.projectId}|${k.subsidiaryId}|${k.revenueAccountId}|${k.currency}`;
}

/**
 * Pure planning step: resolve each source group's legal entity, currency and
 * revenue account, round each key's unbilled total to the currency's minor
 * units, and net it against what is already accrued. Keys that were accrued
 * before but carry no unbilled work now yield a negative delta that clears
 * them. Problems (unmapped accounts, foreign-currency work) are returned, not
 * thrown, so a preview can show every remedy at once.
 */
export function planUnbilledAccrual(input: {
  groups: UnbilledSourceGroup[];
  accrued: AccruedKey[];
  rootSubsidiaryId: string;
  functionalCurrencyOf: (subsidiaryId: string) => string | null;
  minorUnitsOf: (currency: string) => number | null;
  projectRevenueAccountId: string | null;
  projectNames?: Map<string, { code: string | null; name: string }>;
}): { lines: UnbilledAccrualLine[]; problems: UnbilledAccrualProblem[] } {
  const problems: UnbilledAccrualProblem[] = [];
  const reported = new Set<string>();
  const report = (problem: UnbilledAccrualProblem) => {
    const id = `${problem.code}|${problem.projectId ?? ""}|${problem.message}`;
    if (reported.has(id)) return;
    reported.add(id);
    problems.push(problem);
  };
  const exact = new Map<string, { line: Omit<UnbilledAccrualLine, "unbilled" | "accrued" | "delta">; amount: string }>();
  const names = new Map(input.projectNames ?? []);
  for (const group of input.groups) {
    names.set(group.projectId, { code: group.projectCode, name: group.projectName });
    const subsidiaryId = group.projectSubsidiaryId ?? input.rootSubsidiaryId;
    const currency = input.functionalCurrencyOf(subsidiaryId);
    if (!currency) {
      report({
        code: "currency_missing",
        projectId: group.projectId,
        message: `Project ${group.projectName} belongs to a subsidiary with no functional currency. Set the subsidiary's base currency under Setup → Company & Accounting → Subsidiaries before accruing.`,
      });
      continue;
    }
    if (group.sourceCurrency && group.sourceCurrency !== currency) {
      report({
        code: "foreign_currency",
        projectId: group.projectId,
        message: `Project ${group.projectName} has unbilled work priced in ${group.sourceCurrency}, but its functional currency is ${currency}. Unbilled revenue accrues in the functional currency only — invoice that work or reprice it in ${currency} before accruing.`,
      });
      continue;
    }
    const revenueAccountId = group.usesProjectRevenue
      ? input.projectRevenueAccountId
      : group.incomeAccountId ?? input.projectRevenueAccountId;
    if (!revenueAccountId) {
      report({
        code: "revenue_account_unmapped",
        projectId: group.projectId,
        message: group.usesProjectRevenue || !group.itemName
          ? `Project ${group.projectName} has unbilled work with no revenue account. Map Project revenue under Setup → Company & Accounting → Control accounts.`
          : `Item ${group.itemName} on project ${group.projectName} has no income account. Set the item's income account, or map Project revenue under Setup → Company & Accounting → Control accounts.`,
      });
      continue;
    }
    const key = accrualKey({ projectId: group.projectId, subsidiaryId, revenueAccountId, currency });
    const prior = exact.get(key);
    if (prior) {
      prior.amount = add(prior.amount, group.amount);
      prior.line.sourceCount += group.sourceCount;
    } else {
      exact.set(key, {
        amount: normalizeMoney(group.amount),
        line: {
          projectId: group.projectId,
          projectCode: group.projectCode,
          projectName: group.projectName,
          subsidiaryId,
          currency,
          revenueAccountId,
          sourceCount: group.sourceCount,
        },
      });
    }
  }

  const accruedByKey = new Map<string, AccruedKey>();
  for (const row of input.accrued) {
    const key = accrualKey(row);
    const prior = accruedByKey.get(key);
    accruedByKey.set(key, prior ? { ...prior, amount: add(prior.amount, row.amount) } : { ...row, amount: normalizeMoney(row.amount) });
  }

  const lines: UnbilledAccrualLine[] = [];
  for (const [key, { line, amount }] of exact) {
    const minor = input.minorUnitsOf(line.currency);
    if (minor === null) {
      report({
        code: "currency_missing",
        projectId: line.projectId,
        message: `Currency ${line.currency} is not registered. Add it under Setup → Company & Accounting → Currencies before accruing.`,
      });
      continue;
    }
    const unbilled = roundCurrencyMoney(amount, minor);
    const accrued = accruedByKey.get(key)?.amount ?? "0.0000";
    accruedByKey.delete(key);
    lines.push({ ...line, unbilled, accrued, delta: add(unbilled, neg(accrued)) });
  }
  // Keys accrued earlier with no unbilled work now: clear them.
  for (const row of accruedByKey.values()) {
    if (isZero(row.amount)) continue;
    const name = names.get(row.projectId);
    lines.push({
      projectId: row.projectId,
      projectCode: name?.code ?? null,
      projectName: name?.name ?? row.projectId,
      subsidiaryId: row.subsidiaryId,
      currency: row.currency,
      revenueAccountId: row.revenueAccountId,
      sourceCount: 0,
      unbilled: "0.0000",
      accrued: row.amount,
      delta: neg(row.amount),
    });
  }
  lines.sort((a, b) =>
    a.projectName.localeCompare(b.projectName) || a.projectId.localeCompare(b.projectId)
    || a.revenueAccountId.localeCompare(b.revenueAccountId) || a.currency.localeCompare(b.currency));
  return { lines: lines.filter((line) => !(isZero(line.unbilled) && isZero(line.accrued))), problems };
}

function periodRefIsValid(ref: UnbilledAccrualPeriodRef): void {
  if (!ref.periodId && !ref.periodEnd) {
    throw new UnbilledAccrualError("Choose the accounting period to accrue.", "period_not_found", 400);
  }
  if (ref.periodEnd && !isIsoCalendarDate(ref.periodEnd)) {
    throw new UnbilledAccrualError("The period end must be a YYYY-MM-DD date.", "period_not_found", 400);
  }
}

/** The regular period (by id, or the posting calendar's period ending on the
 *  date) plus the following regular period its reversal lands in. */
async function loadAccrualPeriod(executor: SqlExecutor, orgId: string, ref: UnbilledAccrualPeriodRef): Promise<AccrualPeriod> {
  periodRefIsValid(ref);
  const match = ref.periodId
    ? sql`p.id = ${ref.periodId}`
    : sql`p.ends_on = ${ref.periodEnd}::date and not p.is_adjustment
          and exists (select 1 from fiscal_calendars fc where fc.org_id = p.org_id and fc.id = p.fiscal_calendar_id
                       and fc.is_default and fc.is_active)`;
  const period = (await executor.execute<AccrualPeriod>(sql`
    select p.id, p.name, p.starts_on::text as starts_on, p.ends_on::text as ends_on, p.is_adjustment,
           next.id as next_period_id, next.starts_on::text as next_starts_on, next.name as next_name
      from accounting_periods p
      left join lateral (
        select n.id, n.starts_on, n.name from accounting_periods n
         where n.org_id = p.org_id and n.starts_on > p.ends_on and not n.is_adjustment
           and n.fiscal_calendar_id = p.fiscal_calendar_id
         order by n.starts_on, n.id limit 1
      ) next on true
     where p.org_id = ${orgId} and ${match}
     order by p.starts_on, p.id
     limit 1`)).rows[0];
  if (!period) {
    throw new UnbilledAccrualError(
      ref.periodId
        ? "That accounting period does not exist in this organization."
        : `No accounting period ends on ${ref.periodEnd}. Choose a period end from the posting calendar.`,
      "period_not_found",
      404,
    );
  }
  if (period.is_adjustment) {
    throw new UnbilledAccrualError(
      `${period.name} is an adjustment period. Unbilled revenue is accrued at the end of a regular period.`,
      "adjustment_period",
    );
  }
  return period;
}

async function primaryBookId(executor: SqlExecutor, orgId: string): Promise<string | null> {
  const row = (await executor.execute<{ id: string }>(sql`
    select id from accounting_books where org_id = ${orgId} and is_primary and is_active and posts_gl
     limit 1`)).rows[0];
  return row?.id ?? null;
}

async function loadSourceGroups(executor: SqlExecutor, orgId: string, periodEnd: string): Promise<UnbilledSourceGroup[]> {
  const rows = (await executor.execute<{
    project_id: string; project_code: string | null; project_name: string; project_subsidiary_id: string | null;
    source_currency: string | null; item_name: string | null; income_account_id: string | null;
    uses_project_revenue: boolean; amount: string; source_count: number;
  }>(sql`
    ${eligibleWipSourcesSql(orgId, null, { kind: "as_of", periodEnd })}
    select source.project_id, project.code as project_code, project.name as project_name,
           source.project_subsidiary_id, source.source_currency, source.item_name,
           case when source.invoicing_revenue_account = 'fixed' then null else source.income_account_id end as income_account_id,
           source.invoicing_revenue_account = 'fixed' as uses_project_revenue,
           sum(source.capped_available_value)::text as amount, count(*)::int as source_count
      from eligible_sources source
      join projects project on project.org_id = ${orgId} and project.id = source.project_id
     where source.capped_available_value <> 0
     group by source.project_id, project.code, project.name, source.project_subsidiary_id, source.source_currency,
              source.item_name, source.income_account_id, source.invoicing_revenue_account
     order by project.name, source.project_id`)).rows;
  return rows.map((row) => ({
    projectId: row.project_id,
    projectCode: row.project_code,
    projectName: row.project_name,
    projectSubsidiaryId: row.project_subsidiary_id,
    sourceCurrency: row.source_currency,
    itemName: row.item_name,
    incomeAccountId: row.income_account_id,
    usesProjectRevenue: row.uses_project_revenue,
    amount: row.amount,
    sourceCount: Number(row.source_count),
  }));
}

async function loadAccrued(executor: SqlExecutor, orgId: string, periodId: string): Promise<{ accrued: AccruedKey[]; names: Map<string, { code: string | null; name: string }> }> {
  const rows = (await executor.execute<{
    project_id: string; subsidiary_id: string; revenue_account_id: string; currency_code: string; amount: string;
    project_code: string | null; project_name: string;
  }>(sql`
    select accrual.project_id, accrual.subsidiary_id, accrual.revenue_account_id, accrual.currency_code,
           sum(accrual.amount)::text as amount, project.code as project_code, project.name as project_name
      from project_revenue_accruals accrual
      join projects project on project.org_id = accrual.org_id and project.id = accrual.project_id
     where accrual.org_id = ${orgId} and accrual.period_id = ${periodId}
     group by accrual.project_id, accrual.subsidiary_id, accrual.revenue_account_id, accrual.currency_code,
              project.code, project.name`)).rows;
  return {
    accrued: rows.map((row) => ({
      projectId: row.project_id,
      subsidiaryId: row.subsidiary_id,
      revenueAccountId: row.revenue_account_id,
      currency: row.currency_code,
      amount: row.amount,
    })),
    names: new Map(rows.map((row) => [row.project_id, { code: row.project_code, name: row.project_name }])),
  };
}

async function loadMinorUnits(executor: SqlExecutor): Promise<Map<string, number>> {
  const rows = (await executor.execute<{ code: string; minor_units: number }>(sql`
    select code, minor_units from currencies`)).rows;
  return new Map(rows.map((row) => [row.code, Number(row.minor_units)]));
}

interface AccrualComputation {
  period: AccrualPeriod;
  ctx: SubsidiaryContext;
  unbilledAccountId: string | null;
  lines: UnbilledAccrualLine[];
  problems: UnbilledAccrualProblem[];
}

async function computeAccrual(executor: SqlExecutor, orgId: string, ref: UnbilledAccrualPeriodRef): Promise<AccrualComputation> {
  const period = await loadAccrualPeriod(executor, orgId, ref);
  const ctx = await loadSubsidiaryContext(executor, orgId);
  const problems: UnbilledAccrualProblem[] = [];
  let unbilledAccountId: string | null = null;
  let projectRevenueAccountId: string | null = null;
  try {
    const controls = await loadControlAccounts(orgId);
    unbilledAccountId = controls.unbilledReceivable ?? null;
    projectRevenueAccountId = controls.projectRevenue ?? null;
  } catch (error) {
    if (!(error instanceof ControlAccountsIncompleteError)) throw error;
    problems.push({
      code: "control_accounts_invalid",
      message: `${error.message}. Correct the mapping under Setup → Company & Accounting → Control accounts.`,
    });
  }
  // Sequential reads: inside a pinned transaction every query shares one client.
  const groups = await loadSourceGroups(executor, orgId, period.ends_on);
  const { accrued, names } = await loadAccrued(executor, orgId, period.id);
  const minorUnits = await loadMinorUnits(executor);
  const plan = planUnbilledAccrual({
    groups,
    accrued,
    rootSubsidiaryId: ctx.rootId,
    functionalCurrencyOf: (subsidiaryId) => ctx.byId.get(subsidiaryId)?.baseCurrency ?? null,
    minorUnitsOf: (currency) => minorUnits.get(currency) ?? null,
    projectRevenueAccountId,
    projectNames: names,
  });
  problems.push(...plan.problems);
  const needsPosting = plan.lines.some((line) => !isZero(line.delta));
  if (needsPosting && !unbilledAccountId && !problems.some((p) => p.code === "control_accounts_invalid")) {
    problems.push({
      code: "unbilled_account_unmapped",
      message: "Map Unbilled receivable under Setup → Company & Accounting → Control accounts.",
    });
  }
  if (needsPosting && (!period.next_period_id || !period.next_starts_on)) {
    problems.push({
      code: "next_period_missing",
      message: `No accounting period follows ${period.name}, so the accrual has nowhere to reverse. Generate the following periods under Setup → Periods & Close → Periods, then accrue.`,
    });
  }
  return { period, ctx, unbilledAccountId, lines: plan.lines, problems };
}

function summarize(computation: AccrualComputation): UnbilledAccrualPreview {
  const { period, lines, problems } = computation;
  const byCurrency = new Map<string, { unbilled: string[]; accrued: string[]; delta: string[] }>();
  for (const line of lines) {
    const bucket = byCurrency.get(line.currency) ?? { unbilled: [], accrued: [], delta: [] };
    bucket.unbilled.push(line.unbilled);
    bucket.accrued.push(line.accrued);
    bucket.delta.push(line.delta);
    byCurrency.set(line.currency, bucket);
  }
  return {
    period: { id: period.id, name: period.name, startsOn: period.starts_on, endsOn: period.ends_on },
    reversal: { periodId: period.next_period_id, periodName: period.next_name, date: period.next_starts_on },
    totals: [...byCurrency].sort(([a], [b]) => a.localeCompare(b)).map(([currency, bucket]) => ({
      currency,
      unbilled: sum(bucket.unbilled),
      accrued: sum(bucket.accrued),
      delta: sum(bucket.delta),
    })),
    projectCount: new Set(lines.map((line) => line.projectId)).size,
    lines,
    upToDate: problems.length === 0 && lines.every((line) => isZero(line.delta)),
    problems,
  };
}

/** Projects and the accrual feature, both required. Writers take the row
 *  lock that orders them with a concurrent disable; readers read plainly. */
async function featureEnabledFor(executor: SqlExecutor, orgId: string, lock: boolean): Promise<boolean> {
  if (lock) {
    return (await lockAndCheckOrgFeature(executor, orgId, "projects"))
      && (await lockAndCheckOrgFeature(executor, orgId, "unbilledRevenueAccrual"));
  }
  const row = (await executor.execute<{ features: FeatureState | null }>(sql`
    select settings->'features' as features from orgs where id = ${orgId}`)).rows[0];
  return !!row && featureEnabled(row.features ?? {}, "unbilledRevenueAccrual");
}

function featureDisabled(): UnbilledAccrualError {
  return new UnbilledAccrualError(
    "Unbilled revenue accrual is turned off. Enable it under Company Settings → Features → Projects.",
    "feature_disabled",
    404,
  );
}

/**
 * What a run would post for a period, without posting. Configuration gaps
 * are reported as problems with their remedy rather than thrown, so the close
 * workspace can show every blocker at once.
 */
export async function previewUnbilledRevenueAccrual(
  orgId: string,
  ref: UnbilledAccrualPeriodRef,
): Promise<UnbilledAccrualPreview> {
  if (!(await featureEnabledFor(db, orgId, false))) throw featureDisabled();
  return summarize(await computeAccrual(db, orgId, ref));
}

/** The advisory lock serializing one organization's accrual runs per book and period. */
export function unbilledAccrualLockKey(orgId: string, bookId: string, periodId: string): string {
  return `unbilled-accrual:${orgId}:${bookId}:${periodId}`;
}

/**
 * Post the outstanding accrual for a period: per legal entity one accrual
 * entry dated the period end and its mirror reversal dated the first day of
 * the next period, with one evidence row per changed key. Everything commits
 * together; any refusal leaves nothing behind.
 */
export async function runUnbilledRevenueAccrual(
  orgId: string,
  actorId: string,
  ref: UnbilledAccrualPeriodRef,
): Promise<UnbilledAccrualRunResult> {
  if (!actorId) throw new UnbilledAccrualError("An attributable actor is required to post an accrual.", "actor_required", 400);
  return withOrgTransaction(orgId, async () => {
    await lockLedgerSetupFence(db, orgId, "shared");
    if (!(await featureEnabledFor(db, orgId, true))) throw featureDisabled();
    const bookId = await primaryBookId(db, orgId);
    if (!bookId) {
      throw new UnbilledAccrualError(
        "No active primary accounting book posts to the general ledger. Activate the primary book under Setup → Company & Accounting → Accounting books.",
        "no_primary_book",
      );
    }
    const target = await loadAccrualPeriod(db, orgId, ref);
    await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${unbilledAccrualLockKey(orgId, bookId, target.id)}, 0))`);
    // Freeze account policy and legal entities for the computation and post.
    await db.execute(sql`select id from subsidiaries where org_id = ${orgId} order by id for share`);
    await db.execute(sql`select id from accounts where org_id = ${orgId} order by id for share`);
    const computation = await computeAccrual(db, orgId, { periodId: target.id });
    const { period, ctx, unbilledAccountId } = computation;
    const changed = computation.lines.filter((line) => !isZero(line.delta));
    if (changed.length === 0 && computation.problems.length === 0) {
      return { runId: null, periodId: period.id, posted: [], lines: computation.lines };
    }
    const blocking = computation.problems[0];
    if (blocking) throw new UnbilledAccrualError(blocking.message, blocking.code);
    if (!unbilledAccountId || !period.next_period_id || !period.next_starts_on) {
      throw new UnbilledAccrualError("Map Unbilled receivable under Setup → Company & Accounting → Control accounts.", "unbilled_account_unmapped");
    }
    const nextPeriodId = period.next_period_id;
    const reversalDate = period.next_starts_on;

    const bySubsidiary = new Map<string, UnbilledAccrualLine[]>();
    for (const line of changed) {
      const list = bySubsidiary.get(line.subsidiaryId) ?? [];
      list.push(line);
      bySubsidiary.set(line.subsidiaryId, list);
    }

    for (const subsidiaryId of bySubsidiary.keys()) {
      for (const [periodId, label, phase] of [
        [period.id, period.name, "accrual"],
        [nextPeriodId, period.next_name ?? reversalDate, "reversal"],
      ] as const) {
        try {
          await assertPeriodModulesOpen(db, { orgId, periodId, bookId, subsidiaryIds: [subsidiaryId], modules: ["gl"] });
        } catch (error) {
          if (error instanceof CloseError) {
            throw new UnbilledAccrualError(
              phase === "accrual"
                ? `The general ledger is closed for ${label}. Reopen ${label} under Setup → Periods & Close before accruing unbilled revenue.`
                : `The accrual reverses on ${reversalDate}, but the general ledger is closed for ${label}. Reopen ${label} under Setup → Periods & Close before accruing unbilled revenue.`,
              "period_closed",
            );
          }
          throw error;
        }
      }
    }

    const runId = randomUUID();
    const posted: UnbilledAccrualRunResult["posted"] = [];
    for (const [subsidiaryId, lines] of [...bySubsidiary].sort(([a], [b]) => a.localeCompare(b))) {
      const subsidiary = ctx.byId.get(subsidiaryId);
      if (!subsidiary) throw new UnbilledAccrualError(`Subsidiary ${subsidiaryId} does not exist.`, "subsidiary_invalid");
      const currency = subsidiary.baseCurrency;
      const entryLines = lines.flatMap((line) => [
        { accountId: unbilledAccountId, amount: line.delta, projectId: line.projectId, subsidiaryId },
        { accountId: line.revenueAccountId, amount: neg(line.delta), projectId: line.projectId, subsidiaryId },
      ]);
      try {
        await validateSubsidiaryRestrictions(db, { orgId, ctx, docSubsidiaryId: subsidiaryId, lines: entryLines });
      } catch (error) {
        if (error instanceof SubsidiaryError) throw new UnbilledAccrualError(error.message, "subsidiary_invalid");
        throw error;
      }
      const amount = sum(lines.map((line) => line.delta));
      const entryNumber = `UNBILLED-${period.name}-${randomUUID().slice(0, 8)}`;
      const reversalEntryId = randomUUID();
      const memo = `Unbilled revenue accrual — ${period.name}`;
      const accrual = await postEntry(db, {
        orgId,
        bookId,
        subsidiaryId,
        entryNumber,
        postingDate: period.ends_on,
        periodId: period.id,
        memo,
        origin: "revenue_accrual",
        actorId,
        currency,
        closeModules: ["gl"],
        auditAction: "insert",
        requestId: "unbilled_revenue_accrual",
        auditChanges: { mode: "unbilled_revenue_accrual", runId, periodId: period.id, reversalEntryId, amount },
        lines: entryLines.map((line) => ({ ...line, memo })),
      });
      const reversalMemo = `Unbilled revenue accrual reversal — ${period.name}`;
      const reversal = await postEntry(db, {
        orgId,
        bookId,
        subsidiaryId,
        id: reversalEntryId,
        entryNumber: `${entryNumber}-R`,
        postingDate: reversalDate,
        periodId: nextPeriodId,
        memo: reversalMemo,
        origin: "revenue_accrual",
        reversesEntryId: accrual.entryId,
        actorId,
        currency,
        closeModules: ["gl"],
        auditAction: "insert",
        requestId: "unbilled_revenue_accrual",
        auditChanges: { mode: "unbilled_revenue_accrual_reversal", runId, periodId: nextPeriodId, reversedEntryId: accrual.entryId },
        lines: entryLines.map((line) => ({ ...line, amount: neg(line.amount), memo: reversalMemo })),
      });
      if (reversal.entryId !== reversalEntryId) {
        throw new UnbilledAccrualError("The accrual reversal was not posted under its evidenced id.", "posting_incomplete");
      }
      for (const line of lines) {
        const inserted = (await db.execute<{ id: string }>(sql`
          insert into project_revenue_accruals (
            org_id, run_id, project_id, subsidiary_id, period_id, accrual_date, reversal_date, amount,
            currency_code, unbilled_account_id, revenue_account_id, accrual_entry_id, reversal_entry_id,
            basis, created_by
          ) values (
            ${orgId}, ${runId}, ${line.projectId}, ${subsidiaryId}, ${period.id}, ${period.ends_on}, ${reversalDate},
            ${line.delta}, ${line.currency}, ${unbilledAccountId}, ${line.revenueAccountId},
            ${accrual.entryId}, ${reversalEntryId},
            ${JSON.stringify({
              valuation: "wip_sources_as_of_period_end",
              unbilled: line.unbilled,
              previouslyAccrued: line.accrued,
              sourceCount: line.sourceCount,
            })}::jsonb,
            ${actorId}
          ) returning id`)).rows[0];
        if (!inserted) throw new UnbilledAccrualError("The accrual evidence was not recorded.", "posting_incomplete");
      }
      posted.push({ subsidiaryId, currency, accrualEntryId: accrual.entryId, reversalEntryId, amount });
    }

    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
      values (${orgId}, 'project_revenue_accruals', ${runId}, 'insert', ${JSON.stringify({
        mode: "unbilled_revenue_accrual_run",
        periodId: period.id,
        periodName: period.name,
        accrualDate: period.ends_on,
        reversalDate,
        before: { accrued: summarize({ ...computation, lines: changed }).totals.map((t) => ({ currency: t.currency, amount: t.accrued })) },
        after: { accrued: summarize({ ...computation, lines: changed }).totals.map((t) => ({ currency: t.currency, amount: t.unbilled })) },
        keys: changed.length,
        entries: posted,
      })}::jsonb, ${actorId}, 'unbilled_revenue_accrual')`);

    return { runId, periodId: period.id, posted, lines: computation.lines };
  });
}

/**
 * Close-readiness probe: how many keys still need posting for the period,
 * optionally limited to the close run's legal entities. The step does not
 * apply when the feature is off or the period is an adjustment period. A
 * configuration gap counts as outstanding and reports its remedy.
 */
export async function unbilledAccrualReadiness(
  orgId: string,
  periodId: string,
  subsidiaryIds?: readonly string[],
): Promise<{ applies: boolean; pendingKeys: number; problem: string | null }> {
  if (!(await featureEnabledFor(db, orgId, false))) return { applies: false, pendingKeys: 0, problem: null };
  let computation: AccrualComputation;
  try {
    computation = await computeAccrual(db, orgId, { periodId });
  } catch (error) {
    if (error instanceof UnbilledAccrualError) {
      if (error.code === "adjustment_period") return { applies: false, pendingKeys: 0, problem: null };
      return { applies: true, pendingKeys: 1, problem: error.message };
    }
    throw error;
  }
  const inScope = (subsidiaryId: string) => !subsidiaryIds?.length || subsidiaryIds.includes(subsidiaryId);
  const pendingKeys = computation.lines.filter((line) => inScope(line.subsidiaryId) && !isZero(line.delta)).length;
  const problem = computation.problems[0]?.message ?? null;
  return { applies: true, pendingKeys: pendingKeys + (problem && pendingKeys === 0 ? 1 : 0), problem };
}
