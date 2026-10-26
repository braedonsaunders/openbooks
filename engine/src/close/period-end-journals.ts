import { resolveBookBases } from "../journal/book-basis.ts";
import { BookTranslationError } from "../journal/book-translation.ts";
import { randomUUID } from "node:crypto";
import { isUuid } from "../platform/uuid.ts";
import { isIsoCalendarDate } from "../platform/civil-date.ts";
import { sql } from "drizzle-orm";
import {
  db,
  withOrgTransaction,
  withTransactionSavepoint,
  type SqlExecutor,
} from "../platform/db.ts";
import { neg, normalizeMoney, sum } from "../money/money.ts";
import {
  canonicalPeriodLabel,
  canonicalPeriodLabelSql,
  CLOSE_MODULES,
  CloseError,
  NON_POSTING_DOCUMENT_KINDS,
  periodLockRequiresApprovedReopen,
  type PeriodDisplayInput,
} from "../periods/period-policy.ts";
import { periodScopeAdvisoryLock } from "../periods/period-locks.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { lockLedgerSetupFence } from "../organization/ledger-setup-fence.ts";
import { featureEnabled, type FeatureState } from "../organization/feature-registry.ts";
import { dataDependentFeatureDefault } from "../organization/feature-defaults.ts";
import { actorHasPermission } from "../organization/actor-permissions.ts";
import { actorAllowedSubsidiaryIds } from "../organization/actor-subsidiaries.ts";
import {
  loadSubsidiaryContext,
  SubsidiaryError,
  validateSubsidiaryRestrictions,
  type SubsidiaryContext,
} from "../organization/subsidiaries.ts";
import { markEntryReversed, postEntry } from "../journal/post-entry.ts";
import { reversalPostEntryLine } from "../journal/reversal-posting-lines.ts";
import { PostingError } from "../journal/posting-contracts.ts";
import { reversalJournalLines } from "../records/reversal-journal-lines.ts";
import { PNL_TYPES } from "../records/account-types.ts";
import { PERIOD_END_JOURNAL_ORIGIN_LITERALS } from "../records/period-end-origins.ts";
import { revaluationReadiness } from "./fx-revaluation.ts";
import {
  computePeriodEndJournals,
  periodEndPlanHash,
  PeriodEndComputationError,
  type PeriodEndBalance,
  type PeriodEndDimensions,
  type PeriodEndJournalKind,
  type PeriodEndPlan,
} from "./period-end-journals-compute.ts";

/**
 * Period-end journals: explicit year-end closing (and optional opening)
 * entries for organizations whose jurisdiction requires them.
 *
 * A generation closes one fiscal year for one accounting book and legal
 * entity. It is posted as a governed close step once the year's other
 * periods are hard-closed, no drafts remain and FX revaluation is current.
 * Each journal posts through the posting kernel (origin `closing`, and
 * `opening` for the next year's opening entry) with an exactly-once key,
 * and the generation, its policy snapshot, its content hash and the closed
 * earnings are recorded with the actor and reason.
 *
 * While a generation is live, the book and entity are sealed through the
 * closed year end (period_end_journal_seal): any later posting into that
 * year is refused by name. A late adjustment therefore goes through the
 * governed reopen of the closing period, whose approval reverses the
 * journals — never deletes them — and the re-close generates them again
 * from the corrected ledger. Generating again with an unchanged ledger and
 * policy posts nothing; a changed result reverses the live generation and
 * posts the new one in the same transaction. Delta closing entries are
 * deliberately not used: they would let postings land in a closed year
 * without the reopen governance and leave the year's statutory record with
 * journals it was never closed with.
 *
 * Statements are unaffected: they compute retained earnings from the
 * ledger and exclude period-end origins, so a balance sheet with the
 * closing entries is identical to one computed without them.
 */

export type PeriodEndProblemCode =
  | "feature_disabled"
  | "book_unavailable"
  | "policy_missing"
  | "policy_account_invalid"
  | "closing_period_missing"
  | "closing_period_closed"
  | "opening_period_missing"
  | "opening_period_closed"
  | "periods_open"
  | "drafts_open"
  | "fx_unrevalued"
  | "later_year_closed"
  | "subsidiary_unavailable"
  | "computation_failed";

export interface PeriodEndProblem {
  code: PeriodEndProblemCode;
  message: string;
  remedy: string;
  /** Period names, counts or other plain evidence for the operator. */
  details?: Record<string, unknown>;
}

/** A refusal of a period-end journal command, with the stable code and the remedy that resolves it. */
export class PeriodEndJournalError extends Error {
  readonly name = "PeriodEndJournalError";
  constructor(
    message: string,
    readonly code:
      PeriodEndProblemCode | "reason_required" | "not_found" | "not_generated" | "forbidden",
    readonly remedy?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

const REASON_MIN = 10;
const REASON_MAX = 500;

function requireReason(reason: string | undefined, action: string): string {
  const trimmed = (reason ?? "").trim();
  if (trimmed.length < REASON_MIN || trimmed.length > REASON_MAX) {
    throw new PeriodEndJournalError(
      `${action} requires a reason of ${REASON_MIN}-${REASON_MAX} characters`,
      "reason_required",
      "State why the journals are being changed; the reason is kept in the audit trail.",
    );
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// Fiscal year, book and policy resolution
// ---------------------------------------------------------------------------

type PeriodRow = {
  id: string;
  fiscal_year: number;
  starts_on: string;
  ends_on: string;
  is_adjustment: boolean;
  period_number: number;
};

/**
 * A period of the fiscal year: `name` is its locale-free label
 * (`P12 FY2026`) for refusal and remedy text; `periodRef` lets presenters
 * label it in the viewer's locale.
 */
interface PeriodEndPeriod {
  id: string;
  name: string;
  startsOn: string;
  endsOn: string;
  periodRef: PeriodDisplayInput;
}

export interface PeriodEndFiscalYear {
  calendarId: string;
  fiscalYear: number;
  startsOn: string;
  endsOn: string;
  periods: (PeriodEndPeriod & { isAdjustment: boolean })[];
  lastRegularPeriod: PeriodEndPeriod;
  adjustmentPeriod: PeriodEndPeriod | null;
  nextYearFirstPeriod: PeriodEndPeriod | null;
}

/** A period by id with its locale-free label and display reference. */
export interface PeriodEndPeriodLabel {
  id: string;
  name: string;
  periodRef: PeriodDisplayInput;
}

/** The fiscal year that contains a period, by calendar and fiscal-year number. */
export async function loadPeriodEndFiscalYear(
  executor: SqlExecutor,
  orgId: string,
  periodId: string,
): Promise<PeriodEndFiscalYear> {
  const anchor = (
    await executor.execute<{ fiscal_calendar_id: string; fiscal_year: number }>(
      sql`
    select fiscal_calendar_id, fiscal_year from accounting_periods
     where org_id = ${orgId} and id = ${periodId}`,
      "objects",
    )
  )[0];
  if (!anchor) {
    throw new PeriodEndJournalError(
      "accounting period not found",
      "not_found",
      "Choose a period of the fiscal year to close.",
    );
  }
  const periods = await executor.execute<PeriodRow>(
    sql`
    select id, fiscal_year, starts_on::text as starts_on, ends_on::text as ends_on, is_adjustment, period_number
      from accounting_periods
     where org_id = ${orgId} and fiscal_calendar_id = ${anchor.fiscal_calendar_id}
       and fiscal_year = ${anchor.fiscal_year}
     order by is_adjustment, period_number`,
    "objects",
  );
  const regular = periods.filter((period) => !period.is_adjustment);
  const last = regular[regular.length - 1];
  if (!last || !regular[0]) {
    throw new PeriodEndJournalError(
      `fiscal year ${anchor.fiscal_year} has no regular accounting periods`,
      "closing_period_missing",
      "Generate the fiscal year's periods in Setup → Periods & Close → Periods.",
    );
  }
  const adjustment = periods.find((period) => period.is_adjustment) ?? null;
  const next =
    (
      await executor.execute<PeriodRow>(
        sql`
    select id, fiscal_year, starts_on::text as starts_on, ends_on::text as ends_on, is_adjustment, period_number
      from accounting_periods
     where org_id = ${orgId} and fiscal_calendar_id = ${anchor.fiscal_calendar_id}
       and not is_adjustment and starts_on > ${last.ends_on}::date
     order by starts_on limit 1`,
        "objects",
      )
    )[0] ?? null;
  return {
    calendarId: anchor.fiscal_calendar_id,
    fiscalYear: Number(anchor.fiscal_year),
    startsOn: regular[0].starts_on,
    endsOn: last.ends_on,
    periods: periods.map((period) => ({
      ...periodEndPeriod(period),
      isAdjustment: period.is_adjustment,
    })),
    lastRegularPeriod: periodEndPeriod(last),
    adjustmentPeriod: adjustment ? periodEndPeriod(adjustment) : null,
    nextYearFirstPeriod: next ? periodEndPeriod(next) : null,
  };
}

function periodEndPeriod(row: PeriodRow): PeriodEndPeriod {
  const periodRef: PeriodDisplayInput = {
    fiscalYear: Number(row.fiscal_year),
    periodNumber: Number(row.period_number),
    adjustment: row.is_adjustment,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
  };
  return {
    id: row.id,
    name: canonicalPeriodLabel(periodRef),
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    periodRef,
  };
}

type BookRow = {
  isPrimary: boolean;
  id: string;
  code: string;
  name: string;
};

async function resolveBook(
  executor: SqlExecutor,
  orgId: string,
  bookId?: string | null,
): Promise<BookRow> {
  const row = (
    await executor.execute<BookRow>(
      sql`
    select id, code, name, is_primary as "isPrimary" from accounting_books
     where org_id = ${orgId} and is_active and posts_gl
       and ${bookId ? sql`id = ${bookId}` : sql`is_primary`}
     order by created_at limit 1`,
      "objects",
    )
  )[0];
  if (!row) {
    throw new PeriodEndJournalError(
      bookId
        ? "the accounting book is not an active posting book of this organization"
        : "the organization has no active primary posting book",
      "book_unavailable",
      "Choose an active posting book in Setup → Accounting → Accounting Books.",
    );
  }
  return row;
}

export interface PeriodEndPolicy {
  id: string;
  effectiveFrom: string;
  closingMethod: "retained_earnings" | "income_summary";
  retainedEarningsAccountId: string;
  incomeSummaryAccountId: string | null;
  balanceSheetJournals: boolean;
  postingPeriod: "last_period" | "adjustment_period";
  preserveDepartments: boolean;
  preserveClasses: boolean;
  preserveLocations: boolean;
  preserveProjects: boolean;
  preserveSegments: boolean;
}

/** The policy version in force for a fiscal year: the latest effective on or before its end. */
export async function periodEndPolicyInEffect(
  executor: SqlExecutor,
  orgId: string,
  yearEndsOn: string,
): Promise<PeriodEndPolicy | null> {
  const row = (
    await executor.execute<{
      id: string;
      effective_from: string;
      closing_method: PeriodEndPolicy["closingMethod"];
      retained_earnings_account_id: string;
      income_summary_account_id: string | null;
      balance_sheet_journals: boolean;
      posting_period: PeriodEndPolicy["postingPeriod"];
      preserve_departments: boolean;
      preserve_classes: boolean;
      preserve_locations: boolean;
      preserve_projects: boolean;
      preserve_segments: boolean;
    }>(
      sql`
    select id, effective_from::text as effective_from, closing_method, retained_earnings_account_id,
           income_summary_account_id, balance_sheet_journals, posting_period, preserve_departments,
           preserve_classes, preserve_locations, preserve_projects, preserve_segments
      from period_end_journal_policies
     where org_id = ${orgId} and effective_from <= ${yearEndsOn}::date
     order by effective_from desc limit 1`,
      "objects",
    )
  )[0];
  if (!row) return null;
  return {
    id: row.id,
    effectiveFrom: row.effective_from,
    closingMethod: row.closing_method,
    retainedEarningsAccountId: row.retained_earnings_account_id,
    incomeSummaryAccountId: row.income_summary_account_id,
    balanceSheetJournals: row.balance_sheet_journals,
    postingPeriod: row.posting_period,
    preserveDepartments: row.preserve_departments,
    preserveClasses: row.preserve_classes,
    preserveLocations: row.preserve_locations,
    preserveProjects: row.preserve_projects,
    preserveSegments: row.preserve_segments,
  };
}

function closingPeriodFor(
  year: PeriodEndFiscalYear,
  policy: PeriodEndPolicy,
): PeriodEndPeriod | null {
  return policy.postingPeriod === "adjustment_period"
    ? year.adjustmentPeriod
    : year.lastRegularPeriod;
}

/** Equity accounts the policy names must still be active, postable equity accounts. */
async function policyAccountProblems(
  executor: SqlExecutor,
  orgId: string,
  policy: PeriodEndPolicy,
): Promise<PeriodEndProblem[]> {
  const ids = [
    policy.retainedEarningsAccountId,
    ...(policy.incomeSummaryAccountId ? [policy.incomeSummaryAccountId] : []),
  ];
  const rows = await executor.execute<{
    id: string;
    name: string;
    type: string;
    is_summary: boolean;
    is_active: boolean;
  }>(
    sql`
    select id, name, type, is_summary, is_active from accounts
     where org_id = ${orgId} and id = any(${`{${ids.join(",")}}`}::uuid[])`,
    "objects",
  );
  const problems: PeriodEndProblem[] = [];
  for (const id of ids) {
    const account = rows.find((row) => row.id === id);
    if (!account || account.type !== "equity" || account.is_summary || !account.is_active) {
      problems.push({
        code: "policy_account_invalid",
        message: `the ${id === policy.retainedEarningsAccountId ? "retained earnings" : "income summary"} account of the period-end journal policy is not an active, postable equity account`,
        remedy:
          "Record a new period-end journal policy in Setup → Accounting → Period-End Journals naming an active equity account.",
        details: { accountId: id, accountName: account?.name ?? null },
      });
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

function modulesLiteral(): string {
  return `{${CLOSE_MODULES.join(",")}}`;
}

/** Periods of the fiscal year, other than the closing period, that are not hard-closed in every module for the entity. */
async function openPeriodsOfYear(
  executor: SqlExecutor,
  orgId: string,
  bookId: string,
  subsidiaryId: string,
  year: PeriodEndFiscalYear,
  closingPeriodId: string,
): Promise<string[]> {
  const rows = await executor.execute<{
    name: string;
    state: string | null;
    reopen_expires_at: Date | null;
  }>(
    sql`
    select ${canonicalPeriodLabelSql()} as name, governing.state, governing.reopen_expires_at
      from accounting_periods p
     cross join unnest(${modulesLiteral()}::text[]) as m(module)
      left join lateral (
        select l.state, l.reopen_expires_at from period_locks l
         where l.org_id = p.org_id and l.period_id = p.id and l.book_id = ${bookId} and l.module = m.module
           and (l.subsidiary_id = ${subsidiaryId}::uuid or l.subsidiary_id is null)
         order by (l.subsidiary_id is not null) desc limit 1
      ) governing on true
     where p.org_id = ${orgId} and p.fiscal_calendar_id = ${year.calendarId}
       and p.fiscal_year = ${year.fiscalYear} and p.id <> ${closingPeriodId}
     order by p.starts_on, p.period_number`,
    "objects",
  );
  const open = new Set<string>();
  for (const row of rows) {
    const lock = row.state
      ? { state: row.state, reopenExpiresAt: row.reopen_expires_at, reason: null }
      : undefined;
    if (!periodLockRequiresApprovedReopen(lock)) open.add(row.name);
  }
  return [...open];
}

/** True when GL (with its lock rows only, ignoring the year-end seal) accepts postings into the period for the entity. */
async function glAcceptsPostings(
  executor: SqlExecutor,
  orgId: string,
  bookId: string,
  subsidiaryId: string,
  periodId: string,
): Promise<boolean> {
  const lock = (
    await executor.execute<{ state: string; reopen_expires_at: Date | null }>(
      sql`
    select state, reopen_expires_at from period_locks
     where org_id = ${orgId} and period_id = ${periodId} and book_id = ${bookId} and module = 'gl'
       and (subsidiary_id = ${subsidiaryId}::uuid or subsidiary_id is null)
     order by (subsidiary_id is not null) desc limit 1`,
      "objects",
    )
  )[0];
  if (!lock) return true;
  if (lock.state === "soft_closed") return false;
  return !periodLockRequiresApprovedReopen({
    state: lock.state,
    reopenExpiresAt: lock.reopen_expires_at,
    reason: null,
  });
}

async function draftsInYear(
  executor: SqlExecutor,
  orgId: string,
  bookId: string,
  subsidiaryId: string,
  year: PeriodEndFiscalYear,
): Promise<number> {
  const nonPosting = sql.join(
    NON_POSTING_DOCUMENT_KINDS.map((kind) => sql`${kind}`),
    sql`, `,
  );
  const row = (
    await executor.execute<{ count: string }>(
      sql`
    select (
      (select count(*) from journal_entries e
         join accounting_periods p on p.id = e.period_id and p.org_id = e.org_id
        where e.org_id = ${orgId} and e.book_id = ${bookId} and e.status = 'draft'
          and p.fiscal_calendar_id = ${year.calendarId} and p.fiscal_year = ${year.fiscalYear}
          and (exists (select 1 from journal_lines l where l.org_id = e.org_id and l.entry_id = e.id and l.subsidiary_id = ${subsidiaryId})
            or (not exists (select 1 from journal_lines l where l.org_id = e.org_id and l.entry_id = e.id)
                and e.subsidiary_id = ${subsidiaryId})))
      +
      (select count(*) from documents d
         left join accounting_periods p on p.id = d.posting_period_id and p.org_id = d.org_id
        where d.org_id = ${orgId} and d.status in ('draft', 'pending_approval', 'approved')
          and d.kind not in (${nonPosting})
          and (d.subsidiary_id is null or d.subsidiary_id = ${subsidiaryId})
          and ((p.fiscal_calendar_id = ${year.calendarId} and p.fiscal_year = ${year.fiscalYear})
            or (d.posting_period_id is null and coalesce(d.posting_date, d.document_date) between ${year.startsOn}::date and ${year.endsOn}::date)))
    )::text as count`,
      "objects",
    )
  )[0];
  return Number(row?.count ?? 0);
}

type LiveSetRow = {
  id: string;
  generation: number;
  content_hash: string;
  fiscal_year: number;
  year_ends_on: string;
  closing_period_id: string;
  opening_period_id: string | null;
  generated_at: Date;
  generated_by: string | null;
  subsidiary_id: string;
};

async function liveSet(
  executor: SqlExecutor,
  orgId: string,
  bookId: string,
  subsidiaryId: string,
  year: PeriodEndFiscalYear,
): Promise<LiveSetRow | null> {
  return (
    (
      await executor.execute<LiveSetRow>(
        sql`
    select id, generation, content_hash, fiscal_year, year_ends_on::text as year_ends_on, closing_period_id,
           opening_period_id, generated_at, generated_by, subsidiary_id
      from period_end_journal_sets
     where org_id = ${orgId} and book_id = ${bookId} and subsidiary_id = ${subsidiaryId}
       and fiscal_calendar_id = ${year.calendarId} and fiscal_year = ${year.fiscalYear} and status = 'posted'`,
        "objects",
      )
    )[0] ?? null
  );
}

async function laterLiveYear(
  executor: SqlExecutor,
  orgId: string,
  bookId: string,
  subsidiaryId: string,
  yearEndsOn: string,
): Promise<{ fiscal_year: number; period_name: string } | null> {
  return (
    (
      await executor.execute<{ fiscal_year: number; period_name: string }>(
        sql`
    select s.fiscal_year, ${canonicalPeriodLabelSql()} as period_name
      from period_end_journal_sets s
      join accounting_periods p on p.org_id = s.org_id and p.id = s.closing_period_id
     where s.org_id = ${orgId} and s.book_id = ${bookId} and s.subsidiary_id = ${subsidiaryId}
       and s.status = 'posted' and s.year_ends_on > ${yearEndsOn}::date
     order by s.year_ends_on desc limit 1`,
        "objects",
      )
    )[0] ?? null
  );
}

// ---------------------------------------------------------------------------
// Balances and the plan
// ---------------------------------------------------------------------------

interface DimensionPolicy {
  departments: boolean;
  classes: boolean;
  locations: boolean;
  projects: boolean;
  allSegments: boolean;
  segmentKeys: string[];
}

/** Preserved dimensions: the policy's choices plus every balancing segment, which must stay balanced on its own. */
async function dimensionPolicy(
  executor: SqlExecutor,
  orgId: string,
  policy: PeriodEndPolicy,
): Promise<DimensionPolicy> {
  const balancing = await executor.execute<{
    key: string;
    source_kind: string;
    storage_column: string | null;
  }>(
    sql`
    select key, source_kind, storage_column from segment_definitions
     where org_id = ${orgId} and is_balancing`,
    "objects",
  );
  const builtin = new Set(
    balancing.filter((row) => row.source_kind === "builtin").map((row) => row.storage_column),
  );
  return {
    departments: policy.preserveDepartments || builtin.has("department_id"),
    classes: policy.preserveClasses || builtin.has("class_id"),
    locations: policy.preserveLocations || builtin.has("location_id"),
    projects: policy.preserveProjects || builtin.has("project_id"),
    allSegments: policy.preserveSegments,
    segmentKeys: balancing
      .filter((row) => row.source_kind === "custom")
      .map((row) => row.key)
      .sort(),
  };
}

interface LedgerBalances {
  incomeStatement: PeriodEndBalance[];
  balanceSheet: PeriodEndBalance[];
  /** Income-statement activity of the fiscal year itself, excluding period-end journals (debit-positive). */
  yearActivity: string;
}

/**
 * Cumulative balances through the year end for one book and legal entity on
 * the period-end basis: every posted and reversed entry assigned to a period
 * ending on or before the year end (the close doctrine — a journal belongs to
 * the period it is assigned to). Earlier generations are included, so a
 * closed year contributes nothing; `excludeSetId` leaves out the live
 * generation being measured against.
 */
async function ledgerBalances(
  executor: SqlExecutor,
  orgId: string,
  bookId: string,
  subsidiaryId: string,
  year: PeriodEndFiscalYear,
  dimensions: DimensionPolicy,
  excludeSetId: string | null,
): Promise<LedgerBalances> {
  const segmentsExpr = dimensions.allSegments
    ? sql`jsonb_strip_nulls(coalesce(l.extra_dims, '{}'::jsonb))`
    : dimensions.segmentKeys.length
      ? sql`coalesce((select jsonb_object_agg(d.key, d.value) from jsonb_each(coalesce(l.extra_dims, '{}'::jsonb)) d
                       where d.key = any(${`{${dimensions.segmentKeys.join(",")}}`}::text[]) and d.value <> 'null'::jsonb), '{}'::jsonb)`
      : sql`'{}'::jsonb`;
  const rows = await executor.execute<{
    account_id: string;
    type: string;
    department_id: string | null;
    class_id: string | null;
    location_id: string | null;
    project_id: string | null;
    extra_dims: Record<string, string> | null;
    amount: string;
    year_amount: string;
  }>(
    sql`
    with scoped as materialized (
      select e.id, e.origin, p.ends_on
        from journal_entries e
        join accounting_periods p on p.id = e.period_id and p.org_id = e.org_id
       where e.org_id = ${orgId} and e.book_id = ${bookId} and e.status in ('posted', 'reversed')
         and p.ends_on <= ${year.endsOn}::date
         ${
           excludeSetId
             ? sql`and not exists (
           select 1 from period_end_journal_entries pe
            where pe.org_id = e.org_id and pe.set_id = ${excludeSetId} and pe.entry_id = e.id)`
             : sql``
         }
    )
    select l.account_id, a.type,
           ${dimensions.departments ? sql`l.department_id` : sql`null::uuid`} as department_id,
           ${dimensions.classes ? sql`l.class_id` : sql`null::uuid`} as class_id,
           ${dimensions.locations ? sql`l.location_id` : sql`null::uuid`} as location_id,
           ${dimensions.projects ? sql`l.project_id` : sql`null::uuid`} as project_id,
           ${segmentsExpr} as extra_dims,
           sum(l.amount)::text as amount,
           coalesce(sum(l.amount) filter (
             where s.ends_on >= ${year.startsOn}::date and s.origin not in (${sql.raw(PERIOD_END_JOURNAL_ORIGIN_LITERALS)})
           ), 0)::text as year_amount
      from journal_lines l
      join scoped s on s.id = l.entry_id
      join accounts a on a.id = l.account_id and a.org_id = l.org_id
     where l.org_id = ${orgId} and l.subsidiary_id = ${subsidiaryId}
     group by 1, 2, 3, 4, 5, 6, 7
    having sum(l.amount) <> 0
        or coalesce(sum(l.amount) filter (
             where s.ends_on >= ${year.startsOn}::date and s.origin not in (${sql.raw(PERIOD_END_JOURNAL_ORIGIN_LITERALS)})
           ), 0) <> 0`,
    "objects",
  );
  const incomeStatement: PeriodEndBalance[] = [];
  const balanceSheet: PeriodEndBalance[] = [];
  const yearAmounts: string[] = [];
  for (const row of rows) {
    const balance: PeriodEndBalance = {
      accountId: row.account_id,
      accountType: row.type,
      dimensions: {
        departmentId: row.department_id,
        classId: row.class_id,
        locationId: row.location_id,
        projectId: row.project_id,
        extraDims: row.extra_dims ?? {},
      },
      amount: normalizeMoney(row.amount),
    };
    if (PNL_TYPES.includes(row.type)) {
      incomeStatement.push(balance);
      yearAmounts.push(row.year_amount);
    } else {
      balanceSheet.push(balance);
    }
  }
  return { incomeStatement, balanceSheet, yearActivity: sum(yearAmounts) };
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

export interface PeriodEndDimensionLabel {
  kind: "department" | "class" | "location" | "project" | "segment";
  /** The segment's own name for custom segments; absent for built-in dimensions. */
  segment?: string;
  label: string;
}

export interface PeriodEndPreviewLine {
  accountId: string;
  accountNumber: string | null;
  accountName: string;
  dimensions: PeriodEndDimensions;
  dimensionLabels: PeriodEndDimensionLabel[];
  amount: string;
}

export interface PeriodEndPreviewJournal {
  kind: PeriodEndJournalKind;
  periodId: string;
  /** Locale-free label of the period the journal posts into. */
  periodName: string;
  periodRef: PeriodDisplayInput;
  postingDate: string;
  debits: string;
  lines: PeriodEndPreviewLine[];
}

export type PeriodEndEntityStatus =
  "not_generated" | "current" | "stale" | "nothing_to_close" | "blocked";

export interface PeriodEndEntityPreview {
  subsidiaryId: string;
  subsidiaryName: string;
  currency: string;
  status: PeriodEndEntityStatus;
  liveSet: {
    id: string;
    generation: number;
    generatedAt: string;
    generatedBy: string | null;
  } | null;
  /** Credit-positive: the fiscal year's own net income. */
  fiscalYearEarnings: string;
  /** Credit-positive: earlier earnings never closed by journal, swept into this closing. */
  priorUnclosedEarnings: string;
  journals: PeriodEndPreviewJournal[];
  problems: PeriodEndProblem[];
}

export interface PeriodEndPreview {
  fiscalYear: {
    calendarId: string;
    fiscalYear: number;
    startsOn: string;
    endsOn: string;
    closingPeriod: PeriodEndPeriodLabel | null;
    openingPeriod: PeriodEndPeriodLabel | null;
  };
  book: { id: string; name: string };
  featureEnabled: boolean;
  policy:
    | (PeriodEndPolicy & {
        retainedEarningsAccountName: string | null;
        incomeSummaryAccountName: string | null;
      })
    | null;
  problems: PeriodEndProblem[];
  entities: PeriodEndEntityPreview[];
}

interface EntityEvaluation {
  preview: PeriodEndEntityPreview;
  plan: PeriodEndPlan | null;
  contentHash: string | null;
  live: LiveSetRow | null;
}

interface YearScope {
  book: BookRow;
  year: PeriodEndFiscalYear;
  policy: PeriodEndPolicy | null;
  closingPeriod: PeriodEndPeriod | null;
  globalProblems: PeriodEndProblem[];
  featureOn: boolean;
  multiCurrency: boolean;
}

async function orgFeatures(executor: SqlExecutor, orgId: string): Promise<FeatureState> {
  const row = (
    await executor.execute<{ features: FeatureState | null }>(
      sql`
    select coalesce(settings->'features', '{}'::jsonb) as features from orgs where id = ${orgId}`,
      "objects",
    )
  )[0];
  return row?.features ?? {};
}

async function resolveYearScope(
  executor: SqlExecutor,
  orgId: string,
  args: { periodId: string; bookId?: string | null },
): Promise<YearScope> {
  const book = await resolveBook(executor, orgId, args.bookId);
  const year = await loadPeriodEndFiscalYear(executor, orgId, args.periodId);
  const features = await orgFeatures(executor, orgId);
  const featureOn = featureEnabled(features, "periodEndJournals");
  const multiCurrency = await lockFreeFeature(executor, orgId, "multiCurrency", features);
  const policy = await periodEndPolicyInEffect(executor, orgId, year.endsOn);
  const globalProblems: PeriodEndProblem[] = [];
  if (!featureOn) {
    globalProblems.push({
      code: "feature_disabled",
      message: "period-end journals are turned off for this organization",
      remedy: "Turn on Period-end journals in Company Settings → Features.",
    });
  }
  let closingPeriod: YearScope["closingPeriod"] = null;
  if (!policy) {
    globalProblems.push({
      code: "policy_missing",
      message: `no period-end journal policy is in effect for fiscal year ${year.fiscalYear} (ending ${year.endsOn})`,
      remedy:
        "Record a period-end journal policy effective on or before the year end in Setup → Accounting → Period-End Journals.",
    });
  } else {
    globalProblems.push(...(await policyAccountProblems(executor, orgId, policy)));
    closingPeriod = closingPeriodFor(year, policy);
    if (!closingPeriod) {
      globalProblems.push({
        code: "closing_period_missing",
        message: `fiscal year ${year.fiscalYear} has no adjustment period to post the period-end journals into`,
        remedy:
          "Enable the adjustment period on the fiscal calendar and generate the year's periods, or record a policy that posts into the last period.",
      });
    }
    if (policy.balanceSheetJournals && !year.nextYearFirstPeriod) {
      globalProblems.push({
        code: "opening_period_missing",
        message: `the opening journals need the first period of fiscal year ${year.fiscalYear + 1}, which does not exist yet`,
        remedy: `Generate the periods of fiscal year ${year.fiscalYear + 1} in Setup → Periods & Close → Periods.`,
      });
    }
  }
  return { book, year, policy, closingPeriod, globalProblems, featureOn, multiCurrency };
}

/** The data-dependent multi-currency default, read without the share lock a write path takes. */
async function lockFreeFeature(
  executor: SqlExecutor,
  orgId: string,
  key: "multiCurrency",
  features: FeatureState,
): Promise<boolean> {
  if (typeof features[key] === "boolean") return featureEnabled(features, key);
  return dataDependentFeatureDefault(executor, orgId, key, features);
}

async function evaluateEntity(
  executor: SqlExecutor,
  orgId: string,
  scope: YearScope,
  subsidiary: { id: string; name: string; baseCurrency: string; isActive: boolean },
): Promise<EntityEvaluation> {
  const { book, year, policy, closingPeriod } = scope;
  const live = await liveSet(executor, orgId, book.id, subsidiary.id, year);
  const preview: PeriodEndEntityPreview = {
    subsidiaryId: subsidiary.id,
    subsidiaryName: subsidiary.name,
    currency: subsidiary.baseCurrency,
    status: "blocked",
    liveSet: live
      ? {
          id: live.id,
          generation: Number(live.generation),
          generatedAt: new Date(live.generated_at).toISOString(),
          generatedBy: live.generated_by,
        }
      : null,
    fiscalYearEarnings: "0.0000",
    priorUnclosedEarnings: "0.0000",
    journals: [],
    problems: [],
  };
  // Without its policy, posting period or (for opening journals) the next
  // year's first period there is nothing to measure; the organization-wide
  // problem names the remedy.
  if (!policy || !closingPeriod || (policy.balanceSheetJournals && !year.nextYearFirstPeriod)) {
    return { preview, plan: null, contentHash: null, live };
  }

  try {
    const bases = await resolveBookBases(executor, {
      orgId,
      book,
      subsidiaryIds: [subsidiary.id],
      postingDate: closingPeriod.endsOn,
    });
    preview.currency = bases.get(subsidiary.id)!.bookCurrency;
    if (policy.balanceSheetJournals) {
      const openingBases = await resolveBookBases(executor, {
        orgId,
        book,
        subsidiaryIds: [subsidiary.id],
        postingDate: year.nextYearFirstPeriod!.startsOn,
      });
      if (openingBases.get(subsidiary.id)!.bookCurrency !== preview.currency)
        throw new BookTranslationError(
          "Closing and opening balances must use the same book currency.",
        );
    }
  } catch (error) {
    if (!(error instanceof BookTranslationError)) throw error;
    preview.problems.push({
      code: "computation_failed",
      message: error.message,
      remedy:
        "Set the book currency policy to cover the closing and opening dates in Setup → Accounting books.",
    });
    return { preview, plan: null, contentHash: null, live };
  }

  const dimensions = await dimensionPolicy(executor, orgId, policy);
  const balances = await ledgerBalances(
    executor,
    orgId,
    book.id,
    subsidiary.id,
    year,
    dimensions,
    live?.id ?? null,
  );
  let plan: PeriodEndPlan;
  try {
    plan = computePeriodEndJournals({
      incomeStatement: balances.incomeStatement,
      balanceSheet: policy.balanceSheetJournals ? balances.balanceSheet : [],
      policy,
    });
  } catch (error) {
    if (!(error instanceof PeriodEndComputationError)) throw error;
    preview.problems.push({
      code: "computation_failed",
      message: error.message,
      remedy:
        "Review the legal entity's trial balance through the year end and correct the out-of-balance entry before generating.",
    });
    return { preview, plan: null, contentHash: null, live };
  }
  preview.fiscalYearEarnings = neg(balances.yearActivity);
  preview.priorUnclosedEarnings = sum([plan.closedEarnings, balances.yearActivity]);
  const contentHash = periodEndPlanHash(plan, {
    bookId: book.id,
    subsidiaryId: subsidiary.id,
    calendarId: year.calendarId,
    fiscalYear: year.fiscalYear,
    closingPeriodId: closingPeriod.id,
    openingPeriodId: policy.balanceSheetJournals ? (year.nextYearFirstPeriod?.id ?? null) : null,
    retainedEarningsAccountId: policy.retainedEarningsAccountId,
    incomeSummaryAccountId: policy.incomeSummaryAccountId,
  });
  preview.journals = await describeJournals(executor, orgId, plan, closingPeriod, year);

  // Readiness: only what generating would need now. A current live
  // generation needs nothing, whatever later lock states say.
  if (live && live.content_hash === contentHash) {
    preview.status = "current";
    return { preview, plan, contentHash, live };
  }
  if (plan.journals.length === 0 && !live) {
    preview.status = "nothing_to_close";
    return { preview, plan, contentHash, live };
  }
  preview.problems.push(
    ...(await entityProblems(executor, orgId, scope, subsidiary, closingPeriod, policy)),
  );
  preview.status = preview.problems.length > 0 ? "blocked" : live ? "stale" : "not_generated";
  return { preview, plan, contentHash, live };
}

async function entityProblems(
  executor: SqlExecutor,
  orgId: string,
  scope: YearScope,
  subsidiary: { id: string; name: string; isActive: boolean },
  closingPeriod: { id: string; name: string; endsOn: string },
  policy: PeriodEndPolicy,
): Promise<PeriodEndProblem[]> {
  const { book, year } = scope;
  const problems: PeriodEndProblem[] = [];
  if (!subsidiary.isActive) {
    problems.push({
      code: "subsidiary_unavailable",
      message: `the legal entity ${subsidiary.name} is inactive`,
      remedy:
        "Reactivate the legal entity in Setup → Company → Subsidiaries to post its period-end journals.",
    });
  }
  const later = await laterLiveYear(executor, orgId, book.id, subsidiary.id, year.endsOn);
  if (later) {
    problems.push({
      code: "later_year_closed",
      message: `fiscal year ${later.fiscal_year} is already closed by period-end journals`,
      remedy: `Request a controlled reopen of ${later.period_name}, whose approval reverses fiscal year ${later.fiscal_year}'s journals, then close fiscal year ${year.fiscalYear} first.`,
      details: { fiscalYear: later.fiscal_year },
    });
  }
  const open = await openPeriodsOfYear(
    executor,
    orgId,
    book.id,
    subsidiary.id,
    year,
    closingPeriod.id,
  );
  if (open.length > 0) {
    problems.push({
      code: "periods_open",
      message: `${open.length} other period(s) of fiscal year ${year.fiscalYear} are not closed in every module: ${open.join(", ")}`,
      remedy:
        "Close every other period of the year in Period Close before generating the period-end journals.",
      details: { periods: open },
    });
  }
  if (!(await glAcceptsPostings(executor, orgId, book.id, subsidiary.id, closingPeriod.id))) {
    problems.push({
      code: "closing_period_closed",
      message: `the general ledger is closed for ${closingPeriod.name}, where the period-end journals post`,
      remedy: `Generate the journals in ${closingPeriod.name}'s close run before it locks, or request a controlled reopen of ${closingPeriod.name}.`,
    });
  }
  if (
    policy.balanceSheetJournals &&
    year.nextYearFirstPeriod &&
    !(await glAcceptsPostings(executor, orgId, book.id, subsidiary.id, year.nextYearFirstPeriod.id))
  ) {
    problems.push({
      code: "opening_period_closed",
      message: `the general ledger is closed for ${year.nextYearFirstPeriod.name}, where the opening journal posts`,
      remedy: `Request a controlled reopen of ${year.nextYearFirstPeriod.name} before generating the opening journal.`,
    });
  }
  const drafts = await draftsInYear(executor, orgId, book.id, subsidiary.id, year);
  if (drafts > 0) {
    problems.push({
      code: "drafts_open",
      message: `${drafts} unposted draft or approved transaction(s) remain in fiscal year ${year.fiscalYear}`,
      remedy:
        "Post, void or move every draft and approved transaction of the year before closing it.",
      details: { count: drafts },
    });
  }
  if (scope.multiCurrency) {
    const fx = await revaluationReadiness(orgId, book.id, closingPeriod.id, [subsidiary.id]);
    if (fx.unrevaluedPositions > 0) {
      problems.push({
        code: "fx_unrevalued",
        message: `${fx.unrevaluedPositions} foreign-currency position(s) are not revalued at ${closingPeriod.name}`,
        remedy: `Run FX revaluation for ${closingPeriod.name} in its close run, then generate the period-end journals.`,
        details: {
          positions: fx.unrevaluedPositions,
          missingSpotRates: fx.positionsMissingSpotRate,
        },
      });
    }
  }
  return problems;
}

async function describeJournals(
  executor: SqlExecutor,
  orgId: string,
  plan: PeriodEndPlan,
  closingPeriod: PeriodEndPeriod,
  year: PeriodEndFiscalYear,
): Promise<PeriodEndPreviewJournal[]> {
  const accountIds = [
    ...new Set(plan.journals.flatMap((journal) => journal.lines.map((line) => line.accountId))),
  ];
  const accounts =
    accountIds.length === 0
      ? []
      : await executor.execute<{ id: string; number: string | null; name: string }>(
          sql`
    select id, number, name from accounts where org_id = ${orgId} and id = any(${`{${accountIds.join(",")}}`}::uuid[])`,
          "objects",
        );
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const labelOf = await dimensionLabeler(executor, orgId, plan);
  return plan.journals.map((journal) => {
    const opening = journal.kind === "opening";
    return {
      kind: journal.kind,
      periodId: opening ? year.nextYearFirstPeriod!.id : closingPeriod.id,
      periodName: opening ? year.nextYearFirstPeriod!.name : closingPeriod.name,
      periodRef: opening ? year.nextYearFirstPeriod!.periodRef : closingPeriod.periodRef,
      postingDate: opening ? year.nextYearFirstPeriod!.startsOn : closingPeriod.endsOn,
      debits: sum(
        journal.lines.filter((line) => !line.amount.startsWith("-")).map((line) => line.amount),
      ),
      lines: journal.lines.map((line) => ({
        accountId: line.accountId,
        accountNumber: byId.get(line.accountId)?.number ?? null,
        accountName: byId.get(line.accountId)?.name ?? line.accountId,
        dimensions: line.dimensions,
        dimensionLabels: labelOf(line.dimensions),
        amount: line.amount,
      })),
    };
  });
}

/** Names for the preserved dimensions a plan's lines carry, resolved once per preview. */
async function dimensionLabeler(
  executor: SqlExecutor,
  orgId: string,
  plan: PeriodEndPlan,
): Promise<(dimensions: PeriodEndDimensions) => PeriodEndDimensionLabel[]> {
  const ids = new Set<string>();
  for (const journal of plan.journals) {
    for (const line of journal.lines) {
      const d = line.dimensions;
      for (const id of [
        d.departmentId,
        d.classId,
        d.locationId,
        d.projectId,
        ...Object.values(d.extraDims),
      ]) {
        if (id) ids.add(id);
      }
    }
  }
  const names = new Map<string, { name: string; segment: string | null }>();
  if (ids.size > 0) {
    const list = `{${[...ids].join(",")}}`;
    const rows = await executor.execute<{ id: string; name: string; segment: string | null }>(
      sql`
      select id, name, null::text as segment from departments where org_id = ${orgId} and id = any(${list}::uuid[])
      union all select id, name, null from classes where org_id = ${orgId} and id = any(${list}::uuid[])
      union all select id, name, null from locations where org_id = ${orgId} and id = any(${list}::uuid[])
      union all select id, name, null from projects where org_id = ${orgId} and id = any(${list}::uuid[])
      union all select v.id, v.name, d.name from segment_values v
        join segment_definitions d on d.org_id = v.org_id and d.id = v.segment_id
       where v.org_id = ${orgId} and v.id = any(${list}::uuid[])`,
      "objects",
    );
    for (const row of rows) names.set(row.id, { name: row.name, segment: row.segment });
  }
  return (dimensions) => {
    const labels: PeriodEndDimensionLabel[] = [];
    const push = (kind: PeriodEndDimensionLabel["kind"], id: string | null) => {
      if (id) labels.push({ kind, label: names.get(id)?.name ?? id });
    };
    push("department", dimensions.departmentId);
    push("class", dimensions.classId);
    push("location", dimensions.locationId);
    push("project", dimensions.projectId);
    for (const [key, id] of Object.entries(dimensions.extraDims)) {
      labels.push({
        kind: "segment",
        segment: names.get(id)?.segment ?? key,
        label: names.get(id)?.name ?? id,
      });
    }
    return labels;
  };
}

function scopeSubsidiaries(
  ctx: SubsidiaryContext,
  requested: readonly string[] | undefined | null,
) {
  const ids = requested ? [...new Set(requested)] : [...ctx.byId.keys()];
  return ids
    .flatMap((id) => {
      const subsidiary = ctx.byId.get(id);
      return subsidiary ? [subsidiary] : [];
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1));
}

/**
 * What generating the fiscal year's period-end journals would post now, per
 * legal entity, with the readiness problems that would refuse it and the
 * state of any live generation. Read-only.
 */
export async function previewPeriodEndJournals(
  orgId: string,
  args: { periodId: string; bookId?: string | null; subsidiaryIds?: readonly string[] | null },
): Promise<PeriodEndPreview> {
  const scope = await resolveYearScope(db, orgId, args);
  const ctx = await loadSubsidiaryContext(db, orgId);
  const entities: PeriodEndEntityPreview[] = [];
  for (const subsidiary of scopeSubsidiaries(ctx, args.subsidiaryIds)) {
    const evaluation = await evaluateEntity(db, orgId, scope, subsidiary);
    if (evaluation.preview.status === "nothing_to_close" && subsidiary.isElimination) continue;
    entities.push(evaluation.preview);
  }
  const names = scope.policy
    ? await db.execute<{ id: string; name: string }>(
        sql`
    select id, name from accounts where org_id = ${orgId}
       and id = any(${`{${[scope.policy.retainedEarningsAccountId, scope.policy.incomeSummaryAccountId].filter(Boolean).join(",")}}`}::uuid[])`,
        "objects",
      )
    : [];
  return {
    fiscalYear: {
      calendarId: scope.year.calendarId,
      fiscalYear: scope.year.fiscalYear,
      startsOn: scope.year.startsOn,
      endsOn: scope.year.endsOn,
      closingPeriod: scope.closingPeriod
        ? {
            id: scope.closingPeriod.id,
            name: scope.closingPeriod.name,
            periodRef: scope.closingPeriod.periodRef,
          }
        : null,
      openingPeriod:
        scope.policy?.balanceSheetJournals && scope.year.nextYearFirstPeriod
          ? {
              id: scope.year.nextYearFirstPeriod.id,
              name: scope.year.nextYearFirstPeriod.name,
              periodRef: scope.year.nextYearFirstPeriod.periodRef,
            }
          : null,
    },
    book: { id: scope.book.id, name: scope.book.name },
    featureEnabled: scope.featureOn,
    policy: scope.policy
      ? {
          ...scope.policy,
          retainedEarningsAccountName:
            names.find((row) => row.id === scope.policy!.retainedEarningsAccountId)?.name ?? null,
          incomeSummaryAccountName:
            names.find((row) => row.id === scope.policy!.incomeSummaryAccountId)?.name ?? null,
        }
      : null,
    problems: scope.globalProblems,
    entities,
  };
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

export interface PeriodEndGenerationResult {
  fiscalYear: number;
  bookId: string;
  generated: {
    subsidiaryId: string;
    setId: string;
    generation: number;
    entryIds: string[];
    replacedSetId: string | null;
  }[];
  unchanged: { subsidiaryId: string; setId: string }[];
  skipped: { subsidiaryId: string; reason: "nothing_to_close" }[];
  refused: { subsidiaryId: string; subsidiaryName: string; problems: PeriodEndProblem[] }[];
}

const KIND_CODES: Record<PeriodEndJournalKind, string> = {
  income_statement: "IS",
  income_summary: "SUM",
  balance_sheet: "BS",
  opening: "OPEN",
};

const KIND_MEMOS: Record<PeriodEndJournalKind, string> = {
  income_statement: "Income statement closing",
  income_summary: "Income summary closing",
  balance_sheet: "Balance sheet closing",
  opening: "Opening balances",
};

async function assertActorAuthority(
  executor: SqlExecutor,
  orgId: string,
  actorId: string,
  subsidiaryIds: readonly string[],
): Promise<void> {
  if (!(await actorHasPermission(executor, orgId, actorId, "close.run"))) {
    throw new PeriodEndJournalError(
      "running the close requires the close.run permission",
      "forbidden",
      "Ask an administrator for the Close run permission.",
    );
  }
  const allowed = await actorAllowedSubsidiaryIds(executor, orgId, actorId);
  if (allowed !== null) {
    const outside = subsidiaryIds.filter((id) => !allowed.has(id));
    if (outside.length > 0) {
      throw new PeriodEndJournalError(
        "the requested legal entities are outside your subsidiary access",
        "forbidden",
        "Ask an administrator with access to every legal entity in scope to run this close action.",
      );
    }
  }
}

function setLockKey(
  orgId: string,
  bookId: string,
  subsidiaryId: string,
  calendarId: string,
  fiscalYear: number,
): string {
  return `period-end-journals:${orgId}:${bookId}:${subsidiaryId}:${calendarId}:${fiscalYear}`;
}

/**
 * Generate the fiscal year's period-end journals for each legal entity in
 * scope. Per entity, in its own savepoint and under its advisory lock: an
 * unchanged live generation is left alone; otherwise readiness is enforced,
 * a changed live generation is reversed, and the new journals post through
 * the kernel with the generation record and its audit. The year's periods
 * are fenced exclusively against concurrent postings for the duration.
 */
export async function generatePeriodEndJournals(
  orgId: string,
  actorId: string,
  args: {
    periodId: string;
    bookId?: string | null;
    reason: string;
    subsidiaryIds?: readonly string[] | null;
  },
): Promise<PeriodEndGenerationResult> {
  const reason = requireReason(args.reason, "generating period-end journals");
  return withOrgTransaction(orgId, async () => {
    await lockLedgerSetupFence(db, orgId, "shared");
    if (!(await lockAndCheckOrgFeature(db, orgId, "periodEndJournals"))) {
      throw new PeriodEndJournalError(
        "period-end journals are turned off for this organization",
        "feature_disabled",
        "Turn on Period-end journals in Company Settings → Features.",
      );
    }
    const scope = await resolveYearScope(db, orgId, args);
    const blocking = scope.globalProblems.filter((problem) => problem.code !== "feature_disabled");
    if (blocking.length > 0 || !scope.policy || !scope.closingPeriod) {
      const first = blocking[0];
      throw new PeriodEndJournalError(
        first?.message ?? "the period-end journal policy is not usable",
        first?.code ?? "policy_missing",
        first?.remedy,
        { problems: blocking },
      );
    }
    const policy = scope.policy;
    const closingPeriod = scope.closingPeriod;
    // Freeze the policy version and the accounts it names for the run.
    await db.execute(
      sql`select id from period_end_journal_policies where org_id = ${orgId} and id = ${policy.id} for share`,
    );
    const ctx = await loadSubsidiaryContext(db, orgId);
    const subsidiaries = scopeSubsidiaries(ctx, args.subsidiaryIds);
    await assertActorAuthority(
      db,
      orgId,
      actorId,
      subsidiaries.map((subsidiary) => subsidiary.id),
    );
    // Exclusive side of the close/posting fence on every period the
    // generation reads or writes, in a stable order: an in-flight posting
    // commits first or waits until the generation commits and its seal holds.
    const fencedPeriods = [
      ...new Set([
        ...scope.year.periods.map((period) => period.id),
        ...(policy.balanceSheetJournals && scope.year.nextYearFirstPeriod
          ? [scope.year.nextYearFirstPeriod.id]
          : []),
      ]),
    ].sort();
    for (const periodId of fencedPeriods)
      await periodScopeAdvisoryLock(db, orgId, periodId, scope.book.id);

    const result: PeriodEndGenerationResult = {
      fiscalYear: scope.year.fiscalYear,
      bookId: scope.book.id,
      generated: [],
      unchanged: [],
      skipped: [],
      refused: [],
    };
    for (const subsidiary of subsidiaries) {
      try {
        await withTransactionSavepoint(db, async () => {
          await db.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${setLockKey(orgId, scope.book.id, subsidiary.id, scope.year.calendarId, scope.year.fiscalYear)}, 0))`,
          );
          const evaluation = await evaluateEntity(db, orgId, scope, subsidiary);
          const { preview, plan, contentHash, live } = evaluation;
          if (preview.status === "current" && live) {
            result.unchanged.push({ subsidiaryId: subsidiary.id, setId: live.id });
            return;
          }
          if (preview.status === "nothing_to_close") {
            result.skipped.push({ subsidiaryId: subsidiary.id, reason: "nothing_to_close" });
            return;
          }
          if (preview.problems.length > 0 || !plan || !contentHash) {
            throw new EntityRefusal(preview.problems);
          }
          await validateOffsetAccounts(db, orgId, ctx, subsidiary.id, policy);
          let replacedSetId: string | null = null;
          if (live) {
            await reverseSet(db, orgId, live.id, {
              actorId,
              reason: `Regenerated: ${reason}`,
              reopenRequestId: null,
            });
            replacedSetId = live.id;
          }
          if (plan.journals.length === 0) {
            // The corrected ledger needs no closing: the replaced generation
            // is reversed and nothing new is posted.
            result.skipped.push({ subsidiaryId: subsidiary.id, reason: "nothing_to_close" });
            return;
          }
          const posted = await postGeneration(db, {
            orgId,
            actorId,
            reason,
            book: scope.book,
            year: scope.year,
            closingPeriod,
            policy,
            subsidiary,
            currency: preview.currency,
            plan,
            contentHash,
            fiscalYearEarnings: preview.fiscalYearEarnings,
            priorUnclosedEarnings: preview.priorUnclosedEarnings,
            replacedSetId,
          });
          result.generated.push({ subsidiaryId: subsidiary.id, ...posted, replacedSetId });
        });
      } catch (error) {
        if (error instanceof EntityRefusal) {
          result.refused.push({
            subsidiaryId: subsidiary.id,
            subsidiaryName: subsidiary.name,
            problems: error.problems,
          });
          continue;
        }
        if (
          error instanceof PostingError ||
          error instanceof CloseError ||
          error instanceof SubsidiaryError ||
          error instanceof PeriodEndJournalError
        ) {
          result.refused.push({
            subsidiaryId: subsidiary.id,
            subsidiaryName: subsidiary.name,
            problems: [
              {
                code: "computation_failed",
                message: error.message,
                remedy:
                  (error as { remedy?: string }).remedy ??
                  "Correct the refused condition and generate again.",
              },
            ],
          });
          continue;
        }
        throw error;
      }
    }
    return result;
  });
}

class EntityRefusal extends Error {
  constructor(readonly problems: PeriodEndProblem[]) {
    super("the legal entity is not ready for its period-end journals");
  }
}

/** The equity accounts the journals credit must admit the legal entity. */
async function validateOffsetAccounts(
  executor: SqlExecutor,
  orgId: string,
  ctx: SubsidiaryContext,
  subsidiaryId: string,
  policy: PeriodEndPolicy,
): Promise<void> {
  await validateSubsidiaryRestrictions(executor, {
    orgId,
    ctx,
    docSubsidiaryId: subsidiaryId,
    lines: [
      policy.retainedEarningsAccountId,
      ...(policy.incomeSummaryAccountId ? [policy.incomeSummaryAccountId] : []),
    ].map((accountId) => ({ accountId, amount: "0", subsidiaryId })),
  });
}

async function postGeneration(
  executor: SqlExecutor,
  input: {
    orgId: string;
    actorId: string;
    reason: string;
    book: BookRow;
    year: PeriodEndFiscalYear;
    closingPeriod: { id: string; name: string; endsOn: string };
    policy: PeriodEndPolicy;
    subsidiary: { id: string; name: string; baseCurrency: string };
    currency: string;
    plan: PeriodEndPlan;
    contentHash: string;
    fiscalYearEarnings: string;
    priorUnclosedEarnings: string;
    replacedSetId: string | null;
  },
): Promise<{ setId: string; generation: number; entryIds: string[] }> {
  const { orgId, book, year, subsidiary, plan, policy, closingPeriod } = input;
  const generation = Number(
    (
      await executor.execute<{ next: number }>(
        sql`
    select coalesce(max(generation), 0) + 1 as next from period_end_journal_sets
     where org_id = ${orgId} and book_id = ${book.id} and subsidiary_id = ${subsidiary.id}
       and fiscal_calendar_id = ${year.calendarId} and fiscal_year = ${year.fiscalYear}`,
        "objects",
      )
    )[0]!.next,
  );
  const setId = randomUUID();
  const entryIds: { kind: PeriodEndJournalKind; entryId: string }[] = [];
  const subsidiaryCode = subsidiary.id.slice(0, 8).toUpperCase();
  for (const journal of plan.journals) {
    const opening = journal.kind === "opening";
    const period = opening ? input.year.nextYearFirstPeriod! : null;
    const entryNumber = `PEJ-${book.code}-FY${year.fiscalYear}-${subsidiaryCode}-G${generation}-${KIND_CODES[journal.kind]}`;
    const memo = `${KIND_MEMOS[journal.kind]} — fiscal year ${year.fiscalYear}`;
    const posted = await postEntry(executor, {
      orgId,
      bookId: book.id,
      subsidiaryId: subsidiary.id,
      entryNumber,
      postingDate: opening ? period!.startsOn : closingPeriod.endsOn,
      periodId: opening ? period!.id : closingPeriod.id,
      memo,
      origin: opening ? "opening" : "closing",
      actorId: input.actorId,
      currency: input.currency,
      amountBasis: "book",
      accountBasis: "book",
      replicate: false,
      closeModules: ["gl"],
      // Closing reaches every account carrying a balance, including accounts
      // retired from new use since; the equity accounts are validated active.
      allowInactiveAccounts: true,
      idempotencyKey: `period-end:${book.id}:${subsidiary.id}:${year.calendarId}:${year.fiscalYear}:g${generation}:${journal.kind}`,
      auditAction: "insert",
      requestId: "period_end_journals",
      auditChanges: {
        mode: "period_end_journal",
        kind: journal.kind,
        setId,
        fiscalYear: year.fiscalYear,
        generation,
        policyId: policy.id,
        reason: input.reason,
      },
      lines: journal.lines.map((line) => ({
        accountId: line.accountId,
        amount: line.amount,
        memo,
        departmentId: line.dimensions.departmentId,
        classId: line.dimensions.classId,
        locationId: line.dimensions.locationId,
        projectId: line.dimensions.projectId,
        extraDims: line.dimensions.extraDims,
      })),
    });
    entryIds.push({ kind: journal.kind, entryId: posted.entryId });
  }
  const snapshot = { ...policy };
  const inserted = (
    await executor.execute<{ id: string }>(
      sql`
    insert into period_end_journal_sets
      (id, org_id, book_id, subsidiary_id, fiscal_calendar_id, fiscal_year, year_starts_on, year_ends_on,
       closing_period_id, opening_period_id, generation, policy_id, policy_snapshot, content_hash, currency,
       fiscal_year_earnings, prior_unclosed_earnings, status, reason, generated_by, created_by, updated_by)
    values (${setId}, ${orgId}, ${book.id}, ${subsidiary.id}, ${year.calendarId}, ${year.fiscalYear},
            ${year.startsOn}::date, ${year.endsOn}::date, ${closingPeriod.id},
            ${entryIds.some((entry) => entry.kind === "opening") ? year.nextYearFirstPeriod!.id : null},
            ${generation}, ${policy.id}, ${JSON.stringify(snapshot)}::jsonb, ${input.contentHash},
            ${input.currency}, ${input.fiscalYearEarnings}, ${input.priorUnclosedEarnings},
            'posted', ${input.reason}, ${input.actorId}, ${input.actorId}, ${input.actorId})
    returning id`,
      "objects",
    )
  )[0];
  if (!inserted)
    throw new PeriodEndJournalError(
      "the period-end journal generation was not recorded",
      "computation_failed",
      "Generate again.",
    );
  for (const entry of entryIds) {
    const link = (
      await executor.execute<{ id: string }>(
        sql`
      insert into period_end_journal_entries (org_id, set_id, kind, entry_id)
      values (${orgId}, ${setId}, ${entry.kind}, ${entry.entryId})
      returning id`,
        "objects",
      )
    )[0];
    if (!link)
      throw new PeriodEndJournalError(
        "a period-end journal link was not recorded",
        "computation_failed",
        "Generate again.",
      );
  }
  await executor.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
    values (${orgId}, 'period_end_journal_sets', ${setId}, 'generate', ${JSON.stringify({
      before: input.replacedSetId ? { liveSetId: input.replacedSetId, status: "reversed" } : null,
      after: {
        status: "posted",
        bookId: book.id,
        subsidiaryId: subsidiary.id,
        fiscalYear: year.fiscalYear,
        generation,
        closingPeriodId: closingPeriod.id,
        entries: entryIds,
        contentHash: input.contentHash,
        fiscalYearEarnings: input.fiscalYearEarnings,
        priorUnclosedEarnings: input.priorUnclosedEarnings,
        policy: snapshot,
      },
      reason: input.reason,
    })}::jsonb, ${input.actorId}, 'period_end_journals')`);
  return { setId, generation, entryIds: entryIds.map((entry) => entry.entryId) };
}

// ---------------------------------------------------------------------------
// Reversal
// ---------------------------------------------------------------------------

const REVERSAL_ORDER: PeriodEndJournalKind[] = [
  "opening",
  "balance_sheet",
  "income_summary",
  "income_statement",
];

/**
 * Reverse one live generation through the posting kernel: each journal gets
 * its negated mirror in the journal's own period (the reversal of a
 * generation's journal is not sealed by that generation), the original is
 * marked reversed, the link records the reversal, and the generation moves
 * to reversed with the actor, reason and any approving reopen request.
 */
async function reverseSet(
  executor: SqlExecutor,
  orgId: string,
  setId: string,
  args: { actorId: string | null; reason: string; reopenRequestId: string | null },
): Promise<string[]> {
  const set = (
    await executor.execute<{ id: string; status: string; fiscal_year: number }>(
      sql`
    select id, status, fiscal_year from period_end_journal_sets
     where org_id = ${orgId} and id = ${setId} for update`,
      "objects",
    )
  )[0];
  if (!set || set.status !== "posted") {
    throw new PeriodEndJournalError(
      "the period-end journal generation is not live",
      "not_generated",
      "Reload the year-end close and try again.",
    );
  }
  const links = (
    await executor.execute<{ id: string; kind: PeriodEndJournalKind; entry_id: string }>(
      sql`
    select id, kind, entry_id from period_end_journal_entries
     where org_id = ${orgId} and set_id = ${setId} and reversal_entry_id is null for update`,
      "objects",
    )
  ).sort((a, b) => REVERSAL_ORDER.indexOf(a.kind) - REVERSAL_ORDER.indexOf(b.kind));
  const reversalIds: string[] = [];
  for (const link of links) {
    const head = (
      await executor.execute<{
        book_id: string;
        subsidiary_id: string;
        entry_number: string;
        posting_date: string;
        period_id: string;
        origin: string;
        status: string;
      }>(
        sql`
      select book_id, subsidiary_id, entry_number, posting_date::text as posting_date, period_id, origin, status
        from journal_entries where org_id = ${orgId} and id = ${link.entry_id} for update`,
        "objects",
      )
    )[0];
    if (!head || head.status !== "posted") {
      throw new PeriodEndJournalError(
        `period-end journal ${head?.entry_number ?? link.entry_id} is not a posted entry`,
        "not_generated",
        "Have the journal entry investigated before reversing the generation.",
      );
    }
    const lines = await executor.execute<Parameters<typeof reversalJournalLines>[0][number]>(
      sql`
      select line_number as "lineNumber", account_id as "accountId", subsidiary_id as "subsidiaryId",
             amount::text as amount, currency, txn_amount::text as "txnAmount", fx_rate::text as "fxRate",
             party_id as "partyId", department_id as "departmentId", project_id as "projectId",
             location_id as "locationId", class_id as "classId", equipment_unit_id as "equipmentUnitId",
             extra_dims as "extraDims", payment_card_id as "paymentCardId", tax_code_id as "taxCodeId",
             eliminate, is_currency_adjustment as "isCurrencyAdjustment",
             memo, quantity::text as quantity, unit, custom, contributor_kind as "contributorKind",
             contributor_ref as "contributorRef"
        from journal_lines where org_id = ${orgId} and entry_id = ${link.entry_id}
       order by line_number`,
      "objects",
    );
    const mirror = reversalJournalLines(lines, { entryId: "", orgId });
    const reversal = await postEntry(executor, {
      orgId,
      bookId: head.book_id,
      subsidiaryId: head.subsidiary_id,
      entryNumber: `${head.entry_number}-R`,
      postingDate: head.posting_date,
      periodId: head.period_id,
      memo: `Reversal of ${head.entry_number} — ${args.reason}`,
      origin: head.origin,
      replicate: false,
      reversesEntryId: link.entry_id,
      actorId: args.actorId,
      closeModules: ["gl"],
      allowInactiveAccounts: true,
      idempotencyKey: `period-end-reversal:${link.entry_id}`,
      auditAction: "update",
      requestId: "period_end_journals",
      auditChanges: {
        mode: "period_end_journal_reversal",
        setId,
        kind: link.kind,
        reversedEntryId: link.entry_id,
        reason: args.reason,
      },
      lines: mirror.map(reversalPostEntryLine),
    });
    await markEntryReversed(executor, { orgId, entryId: link.entry_id, actorId: args.actorId });
    const linked = (
      await executor.execute<{ id: string }>(
        sql`
      update period_end_journal_entries set reversal_entry_id = ${reversal.entryId}
       where org_id = ${orgId} and id = ${link.id} and reversal_entry_id is null
       returning id`,
        "objects",
      )
    )[0];
    if (!linked)
      throw new PeriodEndJournalError(
        "the period-end journal reversal was not linked",
        "not_generated",
        "Reload the year-end close and try again.",
      );
    reversalIds.push(reversal.entryId);
  }
  const updated = (
    await executor.execute<{ id: string }>(
      sql`
    update period_end_journal_sets
       set status = 'reversed', reversed_at = now(), reversed_by = ${args.actorId},
           reversal_reason = ${args.reason}, reopen_request_id = ${args.reopenRequestId},
           updated_at = now(), updated_by = ${args.actorId}
     where org_id = ${orgId} and id = ${setId} and status = 'posted'
     returning id`,
      "objects",
    )
  )[0];
  if (!updated)
    throw new PeriodEndJournalError(
      "the period-end journal generation was not marked reversed",
      "not_generated",
      "Reload the year-end close and try again.",
    );
  await executor.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
    values (${orgId}, 'period_end_journal_sets', ${setId}, 'reverse', ${JSON.stringify({
      before: { status: "posted" },
      after: {
        status: "reversed",
        reversalEntryIds: reversalIds,
        reopenRequestId: args.reopenRequestId,
      },
      reason: args.reason,
    })}::jsonb, ${args.actorId}, 'period_end_journals')`);
  return reversalIds;
}

export interface PeriodEndReversalResult {
  fiscalYear: number;
  reversed: { subsidiaryId: string; setId: string; reversalEntryIds: string[] }[];
}

/**
 * Reverse the fiscal year's live period-end journals while their periods
 * are still open (before the closing period locks, or inside an approved
 * reopen window): the operator's governed way to withdraw a generation, for
 * example to admit a late adjustment before closing the year.
 */
export async function reversePeriodEndJournals(
  orgId: string,
  actorId: string,
  args: {
    periodId: string;
    bookId?: string | null;
    reason: string;
    subsidiaryIds?: readonly string[] | null;
  },
): Promise<PeriodEndReversalResult> {
  const reason = requireReason(args.reason, "reversing period-end journals");
  return withOrgTransaction(orgId, async () => {
    await lockLedgerSetupFence(db, orgId, "shared");
    if (!(await lockAndCheckOrgFeature(db, orgId, "periodEndJournals"))) {
      throw new PeriodEndJournalError(
        "period-end journals are turned off for this organization",
        "feature_disabled",
        "Turn on Period-end journals in Company Settings → Features, or reverse the journals through a controlled reopen of the year-end period.",
      );
    }
    const book = await resolveBook(db, orgId, args.bookId);
    const year = await loadPeriodEndFiscalYear(db, orgId, args.periodId);
    const ctx = await loadSubsidiaryContext(db, orgId);
    const subsidiaries = scopeSubsidiaries(ctx, args.subsidiaryIds);
    await assertActorAuthority(
      db,
      orgId,
      actorId,
      subsidiaries.map((subsidiary) => subsidiary.id),
    );
    const result: PeriodEndReversalResult = { fiscalYear: year.fiscalYear, reversed: [] };
    for (const subsidiary of subsidiaries) {
      await db.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${setLockKey(orgId, book.id, subsidiary.id, year.calendarId, year.fiscalYear)}, 0))`,
      );
      const live = await liveSet(db, orgId, book.id, subsidiary.id, year);
      if (!live) continue;
      const later = await laterLiveYear(db, orgId, book.id, subsidiary.id, year.endsOn);
      if (later) {
        throw new PeriodEndJournalError(
          `fiscal year ${later.fiscal_year} is closed by period-end journals after fiscal year ${year.fiscalYear}`,
          "later_year_closed",
          `Reverse fiscal year ${later.fiscal_year}'s journals first; its closing period is ${later.period_name}.`,
        );
      }
      const reversalEntryIds = await reverseSet(db, orgId, live.id, {
        actorId,
        reason,
        reopenRequestId: null,
      });
      result.reversed.push({ subsidiaryId: subsidiary.id, setId: live.id, reversalEntryIds });
    }
    if (result.reversed.length === 0) {
      throw new PeriodEndJournalError(
        `fiscal year ${year.fiscalYear} has no live period-end journals in this book for the legal entities in scope`,
        "not_generated",
        "Nothing to reverse; generate the journals from the year-end close step.",
      );
    }
    return result;
  });
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export interface PeriodEndHistoryEntry {
  setId: string;
  bookId: string;
  bookName: string;
  subsidiaryId: string;
  subsidiaryName: string;
  fiscalYear: number;
  generation: number;
  status: "posted" | "reversed";
  currency: string;
  fiscalYearEarnings: string;
  priorUnclosedEarnings: string;
  closingPeriodName: string;
  reason: string;
  generatedAt: string;
  generatedByName: string | null;
  reversedAt: string | null;
  reversedByName: string | null;
  reversalReason: string | null;
  reopenRequestId: string | null;
  entries: {
    kind: PeriodEndJournalKind;
    entryId: string;
    entryNumber: string;
    reversalEntryId: string | null;
    reversalEntryNumber: string | null;
  }[];
}

/** Every generation of a fiscal year (or all years), newest first, with its journals and reversals. */
export async function periodEndJournalHistory(
  orgId: string,
  args: {
    fiscalYear?: number | null;
    bookId?: string | null;
    subsidiaryIds?: readonly string[] | null;
    limit?: number;
  },
): Promise<PeriodEndHistoryEntry[]> {
  const subsidiaryFilter = args.subsidiaryIds
    ? args.subsidiaryIds.length
      ? sql`and s.subsidiary_id = any(${`{${args.subsidiaryIds.join(",")}}`}::uuid[])`
      : sql`and false`
    : sql``;
  const rows = await db.execute<{
    id: string;
    book_id: string;
    book_name: string;
    subsidiary_id: string;
    subsidiary_name: string;
    fiscal_year: number;
    generation: number;
    status: "posted" | "reversed";
    currency: string;
    fiscal_year_earnings: string;
    prior_unclosed_earnings: string;
    closing_period_name: string;
    reason: string;
    generated_at: Date;
    generated_by_name: string | null;
    reversed_at: Date | null;
    reversed_by_name: string | null;
    reversal_reason: string | null;
    reopen_request_id: string | null;
    entries: PeriodEndHistoryEntry["entries"];
  }>(
    sql`
    select s.id, s.book_id, b.name as book_name, s.subsidiary_id, sub.name as subsidiary_name,
           s.fiscal_year, s.generation, s.status, s.currency,
           s.fiscal_year_earnings::text as fiscal_year_earnings,
           s.prior_unclosed_earnings::text as prior_unclosed_earnings,
           ${canonicalPeriodLabelSql()} as closing_period_name, s.reason, s.generated_at,
           gu.name as generated_by_name, s.reversed_at, ru.name as reversed_by_name,
           s.reversal_reason, s.reopen_request_id,
           coalesce((
             select jsonb_agg(jsonb_build_object(
                      'kind', pe.kind, 'entryId', pe.entry_id, 'entryNumber', e.entry_number,
                      'reversalEntryId', pe.reversal_entry_id, 'reversalEntryNumber', r.entry_number)
                    order by array_position(array['income_statement','income_summary','balance_sheet','opening'], pe.kind))
               from period_end_journal_entries pe
               join journal_entries e on e.org_id = pe.org_id and e.id = pe.entry_id
               left join journal_entries r on r.org_id = pe.org_id and r.id = pe.reversal_entry_id
              where pe.org_id = s.org_id and pe.set_id = s.id
           ), '[]'::jsonb) as entries
      from period_end_journal_sets s
      join accounting_books b on b.org_id = s.org_id and b.id = s.book_id
      join subsidiaries sub on sub.org_id = s.org_id and sub.id = s.subsidiary_id
      join accounting_periods p on p.org_id = s.org_id and p.id = s.closing_period_id
      left join users gu on gu.id = s.generated_by
      left join users ru on ru.id = s.reversed_by
     where s.org_id = ${orgId}
       ${args.fiscalYear != null ? sql`and s.fiscal_year = ${args.fiscalYear}` : sql``}
       ${args.bookId ? sql`and s.book_id = ${args.bookId}` : sql``}
       ${subsidiaryFilter}
     order by s.fiscal_year desc, s.generated_at desc, sub.name
     limit ${Math.min(Math.max(args.limit ?? 200, 1), 500)}`,
    "objects",
  );
  return rows.map((row) => ({
    setId: row.id,
    bookId: row.book_id,
    bookName: row.book_name,
    subsidiaryId: row.subsidiary_id,
    subsidiaryName: row.subsidiary_name,
    fiscalYear: Number(row.fiscal_year),
    generation: Number(row.generation),
    status: row.status,
    currency: row.currency,
    fiscalYearEarnings: row.fiscal_year_earnings,
    priorUnclosedEarnings: row.prior_unclosed_earnings,
    closingPeriodName: row.closing_period_name,
    reason: row.reason,
    generatedAt: new Date(row.generated_at).toISOString(),
    generatedByName: row.generated_by_name,
    reversedAt: row.reversed_at ? new Date(row.reversed_at).toISOString() : null,
    reversedByName: row.reversed_by_name,
    reversalReason: row.reversal_reason,
    reopenRequestId: row.reopen_request_id,
    entries: row.entries,
  }));
}

// ---------------------------------------------------------------------------
// Close checklist step
// ---------------------------------------------------------------------------

export interface PeriodEndCloseCheck {
  /** Legal entities whose period-end journals are missing, stale or blocked in this run. */
  count: number;
  details?: Record<string, unknown>;
}

/**
 * The close run's year-end step. It applies only when the run's period is
 * the period the policy posts the journals into; otherwise it is complete.
 * Entities with nothing to close count as complete.
 */
export async function periodEndJournalCloseCheck(
  orgId: string,
  args: { periodId: string; bookId: string; subsidiaryIds: readonly string[] },
): Promise<PeriodEndCloseCheck> {
  const scope = await resolveYearScope(db, orgId, args);
  if (!scope.featureOn) return { count: 0 };
  if (!scope.policy) {
    return { count: 1, details: { problems: scope.globalProblems } };
  }
  if (!scope.closingPeriod) {
    // The policy targets an adjustment period this year lacks: the last
    // regular period's run carries the refusal so the year cannot close
    // silently without its journals.
    return args.periodId === scope.year.lastRegularPeriod.id
      ? { count: 1, details: { problems: scope.globalProblems } }
      : { count: 0 };
  }
  if (scope.closingPeriod.id !== args.periodId) return { count: 0 };
  const ctx = await loadSubsidiaryContext(db, orgId);
  const pending: { subsidiaryId: string; subsidiaryName: string; status: PeriodEndEntityStatus }[] =
    [];
  for (const subsidiary of scopeSubsidiaries(
    ctx,
    args.subsidiaryIds.length ? args.subsidiaryIds : null,
  )) {
    const evaluation = await evaluateEntity(db, orgId, scope, subsidiary);
    if (evaluation.preview.status === "current" || evaluation.preview.status === "nothing_to_close")
      continue;
    pending.push({
      subsidiaryId: subsidiary.id,
      subsidiaryName: subsidiary.name,
      status: evaluation.preview.status,
    });
  }
  const globalBlocking = scope.globalProblems.length;
  return {
    count: pending.length + globalBlocking,
    details:
      pending.length || globalBlocking
        ? { entities: pending, problems: scope.globalProblems }
        : undefined,
  };
}

// ---------------------------------------------------------------------------
// Governed reopen
// ---------------------------------------------------------------------------

interface ReopenScope {
  orgId: string;
  periodId: string;
  bookId: string;
  subsidiaryId?: string | null;
  modules: readonly string[];
}

async function liveSetsSealing(executor: SqlExecutor, scope: ReopenScope) {
  return await executor.execute<{
    id: string;
    subsidiary_id: string;
    subsidiary_name: string;
    fiscal_year: number;
    closing_period_id: string;
    closing_period_name: string;
    opening_period_id: string | null;
    opening_period_name: string | null;
  }>(
    sql`
    select s.id, s.subsidiary_id, sub.name as subsidiary_name, s.fiscal_year, s.closing_period_id,
           ${canonicalPeriodLabelSql("cp")} as closing_period_name, s.opening_period_id, ${canonicalPeriodLabelSql("op")} as opening_period_name
      from period_end_journal_sets s
      join accounting_periods target on target.org_id = s.org_id and target.id = ${scope.periodId}
      join subsidiaries sub on sub.org_id = s.org_id and sub.id = s.subsidiary_id
      join accounting_periods cp on cp.org_id = s.org_id and cp.id = s.closing_period_id
      left join accounting_periods op on op.org_id = s.org_id and op.id = s.opening_period_id
     where s.org_id = ${scope.orgId} and s.book_id = ${scope.bookId} and s.status = 'posted'
       and target.ends_on <= s.year_ends_on
       ${scope.subsidiaryId ? sql`and s.subsidiary_id = ${scope.subsidiaryId}` : sql``}
     order by s.year_ends_on desc, sub.name`,
    "objects",
  );
}

/**
 * Reopen requests that would reopen the general ledger behind live
 * period-end journals are admitted only for the period holding those
 * journals (its approval reverses them), and only when their opening
 * journals can be reversed. Any other period of a closed year waits until
 * the year-end period has been reopened. Refused by name with the remedy.
 */
export async function assertPeriodEndReopenAllowed(
  executor: SqlExecutor,
  scope: ReopenScope,
): Promise<void> {
  if (!scope.modules.includes("gl")) return;
  const sealing = await liveSetsSealing(executor, scope);
  if (sealing.length === 0) return;
  const elsewhere = sealing.find((set) => set.closing_period_id !== scope.periodId);
  if (elsewhere) {
    throw new CloseError(
      `fiscal year ${elsewhere.fiscal_year} is closed by period-end journals for ${elsewhere.subsidiary_name}; request the reopen of ${elsewhere.closing_period_name} first — its approval reverses those journals — then reopen this period`,
    );
  }
  for (const set of sealing) {
    if (!set.opening_period_id) continue;
    if (
      !(await glAcceptsPostings(
        executor,
        scope.orgId,
        scope.bookId,
        set.subsidiary_id,
        set.opening_period_id,
      ))
    ) {
      throw new CloseError(
        `reopening ${set.closing_period_name} reverses fiscal year ${set.fiscal_year}'s opening journal in ${set.opening_period_name}, which is closed for ${set.subsidiary_name}; reopen ${set.opening_period_name} first`,
      );
    }
  }
}

/**
 * Inside an approved reopen of the closing period: reverse every live
 * generation the window unseals, attributed to the approver and the reopen
 * request. The periods were opened by the same transaction, so the
 * reversals post through the ordinary kernel gates; any refusal rolls the
 * approval back with its reason.
 */
export async function reversePeriodEndJournalsForReopen(
  executor: SqlExecutor,
  scope: ReopenScope & { actorId: string; reason: string; requestId: string },
): Promise<void> {
  if (!scope.modules.includes("gl")) return;
  await assertPeriodEndReopenAllowed(executor, scope);
  const sealing = await liveSetsSealing(executor, scope);
  for (const set of sealing) {
    try {
      await reverseSet(executor, scope.orgId, set.id, {
        actorId: scope.actorId,
        reason: `Reopen approved: ${scope.reason}`,
        reopenRequestId: scope.requestId,
      });
    } catch (error) {
      if (error instanceof PostingError || error instanceof PeriodEndJournalError) {
        throw new CloseError(
          `fiscal year ${set.fiscal_year}'s period-end journals for ${set.subsidiary_name} could not be reversed: ${error.message}`,
        );
      }
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// Policy versions
// ---------------------------------------------------------------------------

/**
 * Why a new period-end journal policy version cannot be recorded, or null.
 * The accounts must be active, postable equity accounts, the income summary
 * account is required by (and only by) the income summary method, and a
 * version cannot take effect on or before the end of a year already closed
 * by journal — the same rules storage enforces, phrased for the operator.
 */
export async function periodEndPolicyWriteRefusal(
  executor: SqlExecutor,
  orgId: string,
  input: {
    effectiveFrom?: unknown;
    closingMethod?: unknown;
    retainedEarningsAccountId?: unknown;
    incomeSummaryAccountId?: unknown;
  },
): Promise<string | null> {
  const method = input.closingMethod === "income_summary" ? "income_summary" : "retained_earnings";
  const retained =
    typeof input.retainedEarningsAccountId === "string" ? input.retainedEarningsAccountId : "";
  const summary =
    typeof input.incomeSummaryAccountId === "string" && input.incomeSummaryAccountId !== ""
      ? input.incomeSummaryAccountId
      : null;
  if (method === "income_summary" && !summary)
    return "Choose the income summary account the closing passes through.";
  if (method === "retained_earnings" && summary)
    return "An income summary account applies only to the income summary closing method.";
  if (summary && summary === retained)
    return "Choose an income summary account different from the retained earnings account.";
  if (!isUuid(retained)) return "Choose the retained earnings account the closing credits.";
  if (summary && !isUuid(summary))
    return "Choose the income summary account the closing passes through.";
  if (input.effectiveFrom !== undefined && !isIsoCalendarDate(input.effectiveFrom)) {
    return "Choose a valid effective date for the closing policy.";
  }
  const ids = [retained, ...(summary ? [summary] : [])];
  const accounts = await executor.execute<{
    id: string;
    type: string;
    is_summary: boolean;
    is_active: boolean;
  }>(
    sql`
    select id, type, is_summary, is_active from accounts
     where org_id = ${orgId} and id = any(${`{${ids.join(",")}}`}::uuid[])`,
    "objects",
  );
  for (const id of ids) {
    const account = accounts.find((row) => row.id === id);
    if (!account || account.type !== "equity" || account.is_summary || !account.is_active) {
      return id === retained
        ? "The retained earnings account must be an active, postable equity account."
        : "The income summary account must be an active, postable equity account.";
    }
  }
  if (isIsoCalendarDate(input.effectiveFrom)) {
    const closed = (
      await executor.execute<{ fiscal_year: number; year_ends_on: string }>(
        sql`
      select fiscal_year, year_ends_on::text as year_ends_on from period_end_journal_sets
       where org_id = ${orgId} and status = 'posted' and year_ends_on >= ${input.effectiveFrom}::date
       order by year_ends_on desc limit 1`,
        "objects",
      )
    )[0];
    if (closed) {
      return `Fiscal year ${closed.fiscal_year} is closed by period-end journals through ${closed.year_ends_on}; choose an effective date after it, or reopen that year first.`;
    }
  }
  return null;
}
