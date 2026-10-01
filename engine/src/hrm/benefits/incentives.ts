import { createHash } from "node:crypto";
import { actorHasPermission } from "../../organization/actor-permissions.ts";
import { lockAndCheckOrgFeature } from "../../organization/org-feature-lock.ts";
import { fromUnits, toUnits } from "../../money/money.ts";
import { InvalidCivilDateError, parseCivilDate } from "../temporal.ts";
import type { BenefitMetricScope } from "./program-types.ts";
import type { IncentivePeriodBasis } from "./incentive-math.ts";
import { BenefitsError } from "./errors.ts";
import { requireActorId, requireOrgId, type SqlExecutor } from "./shared.ts";
import { sql } from "drizzle-orm";

/**
 * Incentive source measurement: posted general-ledger money and approved
 * time, read under the program's legal entity, currency, scope, and period.
 *
 * These loaders take explicit source configuration (named revenue and
 * expense accounts, typed department/project ids) — never an account-type
 * guess. Money measures bind each named account to its actual GL type and
 * refuse a revenue account that is not income (or an expense account that
 * is not a cost); gross versus net is decided by WHICH expense accounts the
 * program names, never inferred. Missing dimensions (an un-shaped posting
 * inside a department or project measure) refuse instead of silently
 * understating the base, and postings outside the program currency refuse
 * instead of being converted by an invented rate.
 *
 * Snapshots freeze the facts a preview showed so settlement can persist
 * them as award evidence: the fenced primary book, entry and line ids, a
 * deterministic digest over the exact ordered posting lines, account ids,
 * scope, totals, and the latest posting stamp. Previews are never
 * obligations; only settled snapshots become award evidence.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURRENCY_RE = /^[A-Z]{3}$/;

const REVENUE_TYPES = new Set(["income", "income_other"]);
const EXPENSE_TYPES = new Set(["cogs", "expense", "expense_other", "expense_deferred"]);

/**
 * Real calendar-date validation through the HRM temporal primitive (the
 * same validator behind the benefits shared date checks). Nonexistent
 * dates refuse here, never reach a period comparison.
 */
function requireDay(value: string, label: string): string {
  try {
    return parseCivilDate(value);
  } catch (error) {
    if (error instanceof InvalidCivilDateError) {
      throw new BenefitsError(
        "INVALID_INPUT",
        `${label} ${JSON.stringify(value)} is not a real calendar date — use YYYY-MM-DD`,
      );
    }
    throw error;
  }
}

function requireUuid(value: string, label: string): string {
  if (!UUID_RE.test(value)) {
    throw new BenefitsError(
      "INVALID_INPUT",
      `${label} ${JSON.stringify(value)} is not a record id — reload the selection; ids are never typed by hand`,
    );
  }
  return value;
}

function uuidList(ids: readonly string[], label: string): string {
  const checked = ids.map((id) => requireUuid(id, label));
  return `{${checked.join(",")}}`;
}

export type MoneyMeasureMetric = "revenue" | "gross_profit" | "net_profit";

export interface MoneySourceConfig {
  readonly metric: MoneyMeasureMetric;
  readonly scope: BenefitMetricScope;
  readonly departmentIds: readonly string[];
  readonly projectIds: readonly string[];
  /** Explicit revenue accounts (normally income-type). Required. */
  readonly revenueAccountIds: readonly string[];
  /**
   * Explicit cost accounts: the COGS subset for gross_profit, the full
   * expense set for net_profit, empty for revenue.
   */
  readonly expenseAccountIds: readonly string[];
  readonly legalEntityId: string;
  /** ISO currency the program settles in; postings in any other currency refuse. */
  readonly currency: string;
  readonly periodFrom: string;
  readonly periodTo: string;
  /**
   * Expense account the program's own pay component posts to. When it sits
   * inside the expense set the measure is circular (each award would shrink
   * the next base) and the read refuses — the remedy names the fix.
   */
  readonly incentiveExpenseAccountId: string | null;
  /**
   * Actor's employer-subsidiary scope (null = unrestricted), resolved by the
   * caller from the benefits manage/read aggregate. A legal entity outside
   * the scope refuses here at the read boundary — never in the UI alone.
   */
  readonly allowedSubsidiaryIds: Set<string> | null;
}

export interface PostingSourceFact {
  readonly entryId: string;
  readonly lineId: string;
  readonly accountId: string;
  readonly amount: string;
  readonly currency: string;
  readonly legalEntityId: string;
  readonly departmentId: string | null;
  readonly projectId: string | null;
  readonly postingDate: string;
  readonly postedAt: string | null;
}

export interface ApprovedHoursFact {
  readonly entryId: string;
  readonly employeePartyId: string;
  readonly employmentId: string | null;
  readonly workedOn: string;
  readonly hours: string;
  readonly departmentId: string | null;
  readonly projectId: string | null;
  readonly approvedBy: string | null;
  readonly approvedAt: string | null;
}

export interface MoneySourceSnapshot {
  readonly metric: MoneyMeasureMetric;
  readonly scope: BenefitMetricScope;
  readonly periodFrom: string;
  readonly periodTo: string;
  readonly value: string;
  readonly currency: string;
  readonly revenueTotal: string;
  readonly expenseTotal: string;
  readonly revenueAccountIds: readonly string[];
  readonly expenseAccountIds: readonly string[];
  readonly legalEntityId: string;
  /** Primary posting book the measure fenced (parallel books never merge). */
  readonly bookId: string;
  readonly entryIds: readonly string[];
  readonly entryCount: number;
  readonly lineCount: number;
  readonly maxPostedAt: string | null;
  /**
   * Deterministic digest over the exact ordered posting lines (entry, line,
   * account, amount, currency, dimensions, date). Entry ids plus a max stamp
   * cannot see a changed line under the same entries; the digest can, so a
   * re-measure over moved sources never passes as the frozen snapshot.
   */
  readonly digest: string;
  readonly postingFacts: readonly PostingSourceFact[];
}

export interface HoursSourceConfig {
  readonly scope: BenefitMetricScope;
  readonly departmentIds: readonly string[];
  readonly projectIds: readonly string[];
  readonly legalEntityId: string;
  readonly periodFrom: string;
  readonly periodTo: string;
  /** Member employments to attribute hours to (allocation evidence). */
  readonly memberEmploymentIds: readonly string[];
  /** Effective program membership dates fence attribution, independently of the base. */
  readonly memberPeriods?: ReadonlyArray<{
    readonly employmentId: string;
    readonly effectiveFrom: string;
    readonly effectiveTo: string | null;
  }>;
  /**
   * Actor's employer-subsidiary scope (null = unrestricted), resolved by the
   * caller from the benefits manage/read aggregate. Refused at the read.
   */
  readonly allowedSubsidiaryIds: Set<string> | null;
}

export interface HoursSourceSnapshot {
  readonly metric: "approved_hours";
  readonly scope: BenefitMetricScope;
  readonly periodFrom: string;
  readonly periodTo: string;
  readonly totalHours: string;
  readonly hoursByEmployment: ReadonlyArray<{ readonly employmentId: string; readonly hours: string }>;
  readonly entryIds: readonly string[];
  readonly entryCount: number;
  readonly maxApprovedAt: string | null;
  readonly approvedHoursFacts: readonly ApprovedHoursFact[];
}

async function requireMoneyRead(exec: SqlExecutor, orgId: string, actorId: string): Promise<void> {
  if (!(await actorHasPermission(exec, orgId, actorId, "gl.read"))) {
    throw new BenefitsError(
      "REFUSED",
      "profit and revenue measures read the general ledger — grant this operator gl.read (read-only ledger access) or have a ledger reader run the preview; HR access alone never opens company profit",
    );
  }
}

function requireScopeIds(
  scope: BenefitMetricScope,
  departmentIds: readonly string[],
  projectIds: readonly string[],
): void {
  if (scope === "company") {
    if (departmentIds.length > 0 || projectIds.length > 0) {
      throw new BenefitsError(
        "INVALID_INPUT",
        "a company measure takes no department or project ids — clear the scope list or narrow the scope to department or project",
      );
    }
    return;
  }
  if (scope === "department") {
    if (departmentIds.length === 0) {
      throw new BenefitsError(
        "REFUSED",
        "a department measure names no department — select at least one department; the base is never guessed from all departments",
      );
    }
    if (projectIds.length > 0) {
      throw new BenefitsError(
        "INVALID_INPUT",
        "a department measure takes no project ids — move them to a project measure",
      );
    }
    return;
  }
  if (projectIds.length === 0) {
    throw new BenefitsError(
      "REFUSED",
      "a project measure names no project — select at least one project; the base is never guessed from all projects",
    );
  }
  if (departmentIds.length > 0) {
    throw new BenefitsError(
      "INVALID_INPUT",
      "a project measure takes no department ids — move them to a department measure",
    );
  }
}

export interface ResolvedPeriodBasis {
  readonly basis: IncentivePeriodBasis;
  /** Fiscal calendar row the basis was resolved from (also set for calendar). */
  readonly calendarId: string;
}

/**
 * Resolve the measurement basis from the organization's native fiscal
 * calendar: the active default calendar. A January monthly calendar is the
 * explicitly named calendar basis; anything else is a fiscal basis carrying
 * the calendar's name, year-start month, and cadence, which the settlement
 * snapshots with the award evidence. No default calendar (or two claiming
 * to be default) refuses — the basis is configuration, never an assumption.
 */
export async function resolvePeriodBasis(
  exec: SqlExecutor,
  orgId: string,
): Promise<ResolvedPeriodBasis> {
  const org = requireOrgId(orgId);
  const rows = (await exec.execute<{
    id: string; name: string; cadence: string; year_start_month: number;
  }>(sql`
    select id::text as id, name, cadence, year_start_month
      from fiscal_calendars
     where org_id = ${org} and is_active and is_default
     order by id
  `)).rows;
  if (rows.length === 0) {
    throw new BenefitsError(
      "REFUSED",
      "no default fiscal calendar is configured — set one under accounting periods before measuring incentive periods; the measurement basis is configuration, never an assumption",
    );
  }
  const first = rows[0]!;
  if (rows.length > 1) {
    throw new BenefitsError(
      "REFUSED",
      `two fiscal calendars claim to be default ("${first.name}" and ${rows.length - 1} other(s)) — keep exactly one default before measuring incentive periods`,
    );
  }
  if (first.cadence === "monthly" && first.year_start_month === 1) {
    return { basis: { kind: "calendar" }, calendarId: first.id };
  }
  return {
    basis: {
      kind: "fiscal",
      calendarName: first.name,
      yearStartMonth: first.year_start_month,
      cadence: first.cadence,
    },
    calendarId: first.id,
  };
}

async function requireProjectsFeature(exec: SqlExecutor, orgId: string): Promise<void> {
  if (!(await lockAndCheckOrgFeature(exec, orgId, "projects"))) {
    throw new BenefitsError(
      "REFUSED",
      "project measures need the Projects feature — enable it under Company Settings → Features; existing project data is preserved",
    );
  }
}

async function requireProjectsExist(
  exec: SqlExecutor,
  orgId: string,
  projectIds: readonly string[],
): Promise<void> {
  if (projectIds.length === 0) return;
  const rows = (await exec.execute<{ id: string }>(sql`
    select id::text as id from projects
     where org_id = ${orgId} and id = any (${uuidList(projectIds, "project id")}::uuid[])
  `)).rows;
  const found = new Set(rows.map((r) => r.id));
  const missing = projectIds.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new BenefitsError(
      "REFUSED",
      `project measure names ${missing.length} project(s) outside this organization (${missing.slice(0, 3).join(", ")}) — reselect the projects; measures never cross tenants`,
    );
  }
}

/**
 * Resolve the org's primary posting book: the one book a measure fences.
 * Parallel books (tax representations and peers) duplicate entries inside
 * the same entity, so summing every book would double-count the base.
 */
async function resolvePrimaryBook(exec: SqlExecutor, orgId: string): Promise<string> {
  const rows = (await exec.execute<{ id: string }>(sql`
    select id::text as id from accounting_books
     where org_id = ${orgId} and is_primary and posts_gl and is_active
     order by id
  `)).rows;
  if (rows.length === 0) {
    throw new BenefitsError(
      "REFUSED",
      "no active primary posting book is configured — designate the primary book before measuring; the base never merges parallel books",
    );
  }
  if (rows.length > 1) {
    throw new BenefitsError(
      "REFUSED",
      "two posting books claim to be primary — keep exactly one primary book before measuring; the base never merges parallel books",
    );
  }
  return rows[0]!.id;
}

/**
 * Posted money base for one period. Revenue is the negated credit-side sum
 * (income posts credit-negative); expenses are the debit-side sum. Only
 * posted entries of the primary posting book count — drafts never count,
 * and a reversed entry counts through its posted reversal (the voided
 * original leaves the posted set, its posted correction enters it), so the
 * net is correct double-entry accounting, not an exclusion.
 */
export async function measureMoneySource(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  config: MoneySourceConfig,
): Promise<MoneySourceSnapshot> {
  const org = requireOrgId(orgId);
  const actor = requireActorId(actorId);
  await requireMoneyRead(exec, org, actor);
  const legalEntityId = requireUuid(config.legalEntityId, "legal entity");
  if (config.allowedSubsidiaryIds !== null && !config.allowedSubsidiaryIds.has(legalEntityId)) {
    throw new BenefitsError(
      "NOT_FOUND",
      "this legal entity is outside your scope — reload the program list; entities you cannot see are never measured",
    );
  }
  const currency = config.currency.trim().toUpperCase();
  if (!CURRENCY_RE.test(currency)) {
    throw new BenefitsError(
      "INVALID_INPUT",
      `currency ${JSON.stringify(config.currency)} is not an ISO code — settle in a real currency like USD or EUR`,
    );
  }
  const periodFrom = requireDay(config.periodFrom, "periodFrom");
  const periodTo = requireDay(config.periodTo, "periodTo");
  if (periodFrom > periodTo) {
    throw new BenefitsError(
      "INVALID_INPUT",
      `measure period ${periodFrom}..${periodTo} ends before it starts — name the measured span with periodFrom on or before periodTo`,
    );
  }
  requireScopeIds(config.scope, config.departmentIds, config.projectIds);
  if (config.revenueAccountIds.length === 0) {
    throw new BenefitsError(
      "REFUSED",
      "this measure names no revenue account — select the explicit income accounts the base sums; revenue is never inferred from all income",
    );
  }
  if (config.metric !== "revenue" && config.expenseAccountIds.length === 0) {
    throw new BenefitsError(
      "REFUSED",
      `a ${config.metric} measure names no expense account — select the explicit cost accounts it subtracts; ${config.metric === "gross_profit" ? "gross profit subtracts cost of goods sold" : "net profit subtracts the full expense set"}`,
    );
  }
  if (config.metric === "revenue" && config.expenseAccountIds.length > 0) {
    throw new BenefitsError(
      "INVALID_INPUT",
      "a revenue measure takes no expense accounts — move them to a gross or net profit measure",
    );
  }
  if (config.incentiveExpenseAccountId !== null) {
    requireUuid(config.incentiveExpenseAccountId, "incentive expense account");
    if (config.expenseAccountIds.includes(config.incentiveExpenseAccountId)) {
      throw new BenefitsError(
        "REFUSED",
        "the program's own incentive expense account sits inside this measure's expense set — every award would shrink the next base. Post incentive payouts to a dedicated expense account outside the measured set, or measure a before-incentive base that excludes it",
      );
    }
  }

  // Bind every named account to its actual GL type: a revenue account that
  // is not income, or a cost account that is not a cost, refuses here.
  const allAccounts = [...config.revenueAccountIds, ...config.expenseAccountIds];
  const accountRows = (await exec.execute<{ id: string; type: string; name: string }>(sql`
    select id::text as id, type, name from accounts
     where org_id = ${org} and id = any (${uuidList(allAccounts, "account id")}::uuid[])
  `)).rows;
  const typeById = new Map(accountRows.map((r) => [r.id, r]));
  for (const id of allAccounts) {
    const row = typeById.get(id);
    if (!row) {
      throw new BenefitsError(
        "REFUSED",
        `measure names account ${id}, which is outside this organization — reselect the accounts; measures never cross tenants`,
      );
    }
  }
  for (const id of config.revenueAccountIds) {
    const row = typeById.get(id)!;
    if (!REVENUE_TYPES.has(row.type)) {
      throw new BenefitsError(
        "REFUSED",
        `revenue account "${row.name}" is type ${row.type}, not income — bind it to an actual income account or move it to the expense set; the base never re-labels an account`,
      );
    }
  }
  for (const id of config.expenseAccountIds) {
    const row = typeById.get(id)!;
    if (!EXPENSE_TYPES.has(row.type)) {
      throw new BenefitsError(
        "REFUSED",
        `expense account "${row.name}" is type ${row.type}, not a cost — bind it to an actual cost account (cogs or expense); the base never re-labels an account`,
      );
    }
  }

  if (config.scope === "project") {
    await requireProjectsFeature(exec, org);
    await requireProjectsExist(exec, org, config.projectIds);
  }
  const bookId = await resolvePrimaryBook(exec, org);
  const bookFilter = sql`e.book_id = ${bookId}::uuid`;

  // One statement supplies both the totals and their evidence. Independent
  // aggregate and detail reads could observe different posting commits.
  const sourceRows = (await exec.execute<{
    entry_id: string; line_id: string; account_id: string; amount: string;
    currency: string; subsidiary_id: string; department_id: string | null;
    project_id: string | null; posting_date: string; posted_at: string | null;
  }>(sql`
    select l.entry_id::text as entry_id, l.id::text as line_id,
           l.account_id::text as account_id, l.amount::text as amount, l.currency,
           l.subsidiary_id::text as subsidiary_id,
           l.department_id::text as department_id, l.project_id::text as project_id,
           l.posting_date::text as posting_date, e.posted_at::text as posted_at
      from journal_lines l
      join journal_entries e on e.org_id = l.org_id and e.id = l.entry_id
     where l.org_id = ${org} and e.status = 'posted' and ${bookFilter}
       and l.posting_date >= ${periodFrom}::date and l.posting_date <= ${periodTo}::date
       and l.subsidiary_id = ${legalEntityId}::uuid
       and l.account_id = any (${uuidList(allAccounts, "account id")}::uuid[])
     order by l.entry_id, l.line_number, l.id
  `)).rows;
  const dimensionIds = new Set(config.scope === "department" ? config.departmentIds : config.projectIds);
  const lineRows = sourceRows.filter((r) => {
    if (config.scope === "company") return true;
    const dimension = config.scope === "department" ? r.department_id : r.project_id;
    if (dimension === null) {
      throw new BenefitsError("REFUSED", `measured posting ${r.line_id} carries no ${config.scope} — stamp that dimension on every posting in the measured accounts, or narrow the accounts; un-shaped postings never silently leave the base`);
    }
    return dimensionIds.has(dimension);
  });
  const foreign = new Set(lineRows.filter((r) => r.currency !== currency).map((r) => r.currency));
  if (foreign.size > 0) {
    throw new BenefitsError("REFUSED", `the measured accounts post ${[...foreign].sort().join(", ")} outside the program currency ${currency} — settle in the posting currency, or move those postings out of the measured set; amounts are never converted by an invented rate`);
  }
  const revenueIds = new Set(config.revenueAccountIds);
  let revenueUnits = 0n;
  let expenseUnits = 0n;
  for (const row of lineRows) {
    // Revenue posts credit-negative; signed reversals naturally net the base.
    if (revenueIds.has(row.account_id)) revenueUnits -= toUnits(row.amount);
    else expenseUnits += toUnits(row.amount);
  }
  const valueUnits = revenueUnits - expenseUnits;
  const entryIds = [...new Set(lineRows.map((r) => r.entry_id))].sort();
  const stamps = lineRows.map((r) => r.posted_at).filter((s): s is string => s !== null).sort();
  const digest = createHash("sha256")
    .update(
      lineRows.map((r) =>
        [r.entry_id, r.line_id, r.account_id, r.amount, r.currency, r.subsidiary_id,
          r.department_id ?? "", r.project_id ?? "", r.posting_date].join(":"),
      ).join("|"),
      "utf8",
    )
    .digest("hex");
  return {
    metric: config.metric,
    scope: config.scope,
    periodFrom,
    periodTo,
    value: fromUnits(valueUnits),
    currency,
    revenueTotal: fromUnits(revenueUnits),
    expenseTotal: fromUnits(expenseUnits),
    revenueAccountIds: [...config.revenueAccountIds],
    expenseAccountIds: [...config.expenseAccountIds],
    legalEntityId,
    bookId,
    entryIds,
    entryCount: entryIds.length,
    lineCount: lineRows.length,
    maxPostedAt: stamps.length > 0 ? stamps[stamps.length - 1]! : null,
    digest,
    postingFacts: lineRows.map((r) => ({
      entryId: r.entry_id, lineId: r.line_id, accountId: r.account_id,
      amount: r.amount, currency: r.currency, legalEntityId: r.subsidiary_id,
      departmentId: r.department_id, projectId: r.project_id,
      postingDate: r.posting_date.slice(0, 10), postedAt: r.posted_at,
    })),
  };
};

/**
 * Approved-hours base for one period: the metric total counts every
 * approved entry in scope (membership-independent), while attribution maps
 * hours onto member employments for hours allocations. Only approved time
 * counts — drafts, submitted-but-unapproved, and rejected entries never
 * enter a base.
 */
export async function measureApprovedHours(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  config: HoursSourceConfig,
): Promise<HoursSourceSnapshot> {
  const org = requireOrgId(orgId);
  const actor = requireActorId(actorId);
  const legalEntityId = requireUuid(config.legalEntityId, "legal entity");
  if (config.allowedSubsidiaryIds !== null && !config.allowedSubsidiaryIds.has(legalEntityId)) {
    throw new BenefitsError(
      "NOT_FOUND",
      "this legal entity is outside your scope — reload the program list; entities you cannot see are never measured",
    );
  }
  const periodFrom = requireDay(config.periodFrom, "periodFrom");
  const periodTo = requireDay(config.periodTo, "periodTo");
  if (periodFrom > periodTo) {
    throw new BenefitsError(
      "INVALID_INPUT",
      `measure period ${periodFrom}..${periodTo} ends before it starts — name the measured span with periodFrom on or before periodTo`,
    );
  }
  requireScopeIds(config.scope, config.departmentIds, config.projectIds);
  if (config.memberEmploymentIds.length === 0) {
    throw new BenefitsError(
      "REFUSED",
      "hours attribution names no member employment — add program members before measuring; effort is never spread across the roster",
    );
  }
  if (config.scope === "project") {
    await requireProjectsFeature(exec, org);
    await requireProjectsExist(exec, org, config.projectIds);
  }

  // Member employments must exist in this org and sit in the program's
  // legal entity — the measure-time half of the same-entity proof — and
  // one party maps to exactly one member employment, so a day's hours are
  // never split or doubled across two employments of the same worker.
  const memberRows = (await exec.execute<{ id: string; worker_party_id: string; employer_subsidiary_id: string }>(sql`
    select id::text as id, worker_party_id::text as worker_party_id,
           employer_subsidiary_id::text as employer_subsidiary_id
      from worker_employments
     where org_id = ${org}
       and id = any (${uuidList(config.memberEmploymentIds, "member employment id")}::uuid[])
  `)).rows;
  const memberById = new Map(memberRows.map((r) => [r.id, r]));
  for (const id of config.memberEmploymentIds) {
    const row = memberById.get(id);
    if (!row) {
      throw new BenefitsError(
        "REFUSED",
        `member employment ${id} is outside this organization — re-check program membership; measures never cross tenants`,
      );
    }
    if (row.employer_subsidiary_id !== legalEntityId) {
      throw new BenefitsError(
        "REFUSED",
        `member employment ${id} belongs to another legal entity — membership stays in the program's entity; move the employment or narrow the membership`,
      );
    }
  }
  const employmentByParty = new Map<string, string>();
  for (const row of memberRows) {
    const prior = employmentByParty.get(row.worker_party_id);
    if (prior !== undefined && prior !== row.id) {
      throw new BenefitsError(
        "REFUSED",
        `one worker holds two member employments (${prior}, ${row.id}) — end or split the duplicate membership before measuring; a day's hours are never divided by guesswork`,
      );
    }
    employmentByParty.set(row.worker_party_id, row.id);
  }

  const dimFilter = config.scope === "company"
    ? sql`true`
    : config.scope === "department"
      ? sql`t.department_id = any (${uuidList(config.departmentIds, "department id")}::uuid[])`
      : sql`t.project_id = any (${uuidList(config.projectIds, "project id")}::uuid[])`;

  if (config.scope !== "company") {
    const dimColumn = config.scope === "department" ? sql`t.department_id` : sql`t.project_id`;
    const unshaped = (await exec.execute<{ n: number }>(sql`
      select count(*)::int as n from time_entries t
     where t.org_id = ${org} and t.status = 'approved'
       and t.worked_on >= ${periodFrom}::date and t.worked_on <= ${periodTo}::date
       and ${dimColumn} is null
       and exists (
         select 1 from worker_employments emp
          where emp.org_id = t.org_id and emp.worker_party_id = t.employee_party_id
            and emp.employer_subsidiary_id = ${legalEntityId}::uuid
       )
    `)).rows[0]?.n ?? 0;
    if (unshaped > 0) {
      const dim = config.scope === "department" ? "department" : "project";
      throw new BenefitsError(
        "REFUSED",
        `${unshaped} approved time entr${unshaped === 1 ? "y carries" : "ies carry"} no ${dim} — stamp the ${dim} on every entry in the period, or narrow the scope; un-shaped time never silently leaves the base`,
      );
    }
  }

  const rows = (await exec.execute<{
    id: string; hours: string; employee_party_id: string; approved_at: string | null;
    worked_on: string; department_id: string | null; project_id: string | null; approved_by: string | null;
  }>(sql`
    select t.id::text as id, t.hours::text as hours,
           t.worked_on::text as worked_on, t.department_id::text as department_id,
           t.project_id::text as project_id, t.approved_by::text as approved_by,
           t.employee_party_id::text as employee_party_id,
           t.approved_at::text as approved_at
      from time_entries t
     where t.org_id = ${org} and t.status = 'approved'
       and t.worked_on >= ${periodFrom}::date and t.worked_on <= ${periodTo}::date
       and ${dimFilter}
       and exists (
         select 1 from worker_employments emp
          where emp.org_id = t.org_id and emp.worker_party_id = t.employee_party_id
            and emp.employer_subsidiary_id = ${legalEntityId}::uuid
       )
     order by t.id
  `)).rows;

  const memberPeriods = new Map<string, Array<{ effectiveFrom: string; effectiveTo: string | null }>>();
  for (const period of config.memberPeriods ?? []) {
    const from = requireDay(period.effectiveFrom, "membership effectiveFrom");
    const to = period.effectiveTo === null ? null : requireDay(period.effectiveTo, "membership effectiveTo");
    if (to !== null && to < from) throw new BenefitsError("INVALID_INPUT", "membership ends before it starts");
    memberPeriods.set(period.employmentId, [...(memberPeriods.get(period.employmentId) ?? []), { effectiveFrom: from, effectiveTo: to }]);
  }
  const approvedHoursFacts: ApprovedHoursFact[] = [];
  let total = 0n;
  const byEmployment = new Map<string, bigint>();
  const entryIds: string[] = [];
  let maxApprovedAt: string | null = null;
  for (const row of rows) {
    const hours = toUnits(row.hours);
    if (hours < 0n) {
      throw new BenefitsError(
        "REFUSED",
        `approved time entry ${row.id} carries negative hours — correct the entry; a base never nets time`,
      );
    }
    total += hours;
    entryIds.push(row.id);
    if (row.approved_at !== null && (maxApprovedAt === null || row.approved_at > maxApprovedAt)) {
      maxApprovedAt = row.approved_at;
    }
    const employmentId = employmentByParty.get(row.employee_party_id);
    const workedOn = row.worked_on.slice(0, 10);
    const periods = employmentId === undefined ? [] : memberPeriods.get(employmentId) ?? [];
    const attributable = employmentId !== undefined && (config.memberPeriods === undefined ||
      periods.some((p) => p.effectiveFrom <= workedOn && (p.effectiveTo === null || p.effectiveTo >= workedOn)));
    if (attributable) {
      byEmployment.set(employmentId, (byEmployment.get(employmentId) ?? 0n) + hours);
    }
    approvedHoursFacts.push({
      entryId: row.id, employeePartyId: row.employee_party_id,
      employmentId: attributable ? employmentId : null, workedOn, hours: row.hours,
      departmentId: row.department_id, projectId: row.project_id,
      approvedBy: row.approved_by, approvedAt: row.approved_at,
    });
  }
  void actor;
  return {
    metric: "approved_hours",
    scope: config.scope,
    periodFrom,
    periodTo,
    totalHours: fromUnits(total),
    hoursByEmployment: [...config.memberEmploymentIds].sort().map((employmentId) => ({
      employmentId,
      hours: fromUnits(byEmployment.get(employmentId) ?? 0n),
    })),
    entryIds,
    entryCount: entryIds.length,
    maxApprovedAt,
    approvedHoursFacts,
  };
}
