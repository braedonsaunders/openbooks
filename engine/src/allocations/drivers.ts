import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { resolveAccountGroups } from "../records/account-groups.ts";
import { add, normalizeDecimal } from "../money/money.ts";
import {
  DRIVER_SOURCE_KINDS,
  DriverAdminError,
  getDriver,
  listDriverValues,
  parseAllocationDimension,
  validateDriverConfig,
} from "./driver-admin.ts";
import type {
  AccountScope,
  AllocationDimension,
  AllocationDriver,
  DriverAsOf,
  DriverResolveRequest,
  DriverResolver,
  DriverVector,
  ReportDriverTemporal,
  ReportTemporalMode,
} from "./types.ts";

/**
 * Allocation driver evaluation (fleet shard A2) — one resolver per
 * `source_kind` plus `previewDriverVector` for the Drivers tab.
 *
 * Registry WRITES live in `driver-admin.ts` (A8): this module builds on its
 * validators (`parseAllocationDimension`, `validateDriverConfig`) and its
 * reads (`getDriver`, `listDriverValues`), and owns evaluation only.
 * Design: docs/design/allocation-kernel.md §2 (`allocation_drivers`,
 * `allocation_driver_values`) and §3 (`drivers.ts`). Every resolver reads
 * posted ledger reality only (`posted` + `reversed` entries mirror each
 * other, so a reversal nets out instead of double-counting).
 *
 * Cross-shard surface: A3 (period-run) injects `DriverResolver`
 * (`createDriverResolver()`); A8's routes call `previewDriverVector` and
 * wire the real `ReportDriverRunner` for `report_definition` drivers
 * (engine never imports the web report path, so the runner is injected).
 */

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * A measure that cannot honestly be computed (valid configuration, no
 * backing data source for this dimension). Callers must surface this —
 * resolvers never return silent zeros for an uncomputable measure.
 */
export class DriverNotAvailableError extends Error {
  readonly name = "DriverNotAvailableError";
  readonly code = "driver_not_available" as const;
  readonly field?: string;

  constructor(message: string, field?: string) {
    super(message);
    if (field) this.field = field;
  }
}

function notFound(message: string): DriverAdminError {
  return new DriverAdminError("not_found", message);
}

function invalid(message: string): DriverAdminError {
  return new DriverAdminError("validation", message);
}

// ---------------------------------------------------------------------------
// As-of windows, books, dimensions, scopes
// ---------------------------------------------------------------------------

export type ResolvedWindow = {
  from: string;
  to: string;
};

type PeriodRow = {
  starts_on: string;
  ends_on: string;
};

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function parseDateOnly(input: unknown, field: string): string {
  if (typeof input !== "string" || !DATE_PATTERN.test(input)) {
    throw invalid(`${field} must be a YYYY-MM-DD date`);
  }
  return input;
}

function monthWindow(date: string): ResolvedWindow {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const from = `${date.slice(0, 7)}-01`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { from, to: `${date.slice(0, 7)}-${String(lastDay).padStart(2, "0")}` };
}

async function resolveWindow(orgId: string, asOf: DriverAsOf): Promise<ResolvedWindow> {
  if ("periodId" in asOf) {
    const rows = (await db.execute<PeriodRow>(sql`
      select starts_on::text as starts_on, ends_on::text as ends_on
      from accounting_periods
      where id = ${asOf.periodId} and org_id = ${orgId}
    `)).rows;
    const period = rows[0];
    if (!period) throw notFound(`accounting period ${asOf.periodId} not found`);
    return { from: period.starts_on.slice(0, 10), to: period.ends_on.slice(0, 10) };
  }
  return monthWindow(parseDateOnly(asOf.date, "asOf.date"));
}

/** The as-of date a manual driver reads: period → period end, date → itself. */
async function resolveValueDate(orgId: string, asOf: DriverAsOf): Promise<string> {
  if ("periodId" in asOf) return (await resolveWindow(orgId, asOf)).to;
  return parseDateOnly(asOf.date, "asOf.date");
}

async function primaryPostingBookId(orgId: string): Promise<string> {
  const rows = (await db.execute<{ id: string }>(sql`
    select id from accounting_books
    where org_id = ${orgId} and is_primary and is_active and posts_gl
    limit 1
  `)).rows;
  const bookId = rows[0]?.id;
  if (!bookId) throw notFound("no active primary posting book");
  return bookId;
}

/** SQL for the grouping key of a dimension over `journal_lines l`. */
function journalDimExpr(dimension: AllocationDimension) {
  switch (dimension) {
    case "department":
      return sql`l.department_id`;
    case "location":
      return sql`l.location_id`;
    case "class":
      return sql`l.class_id`;
    case "project":
      return sql`l.project_id`;
    case "subsidiary":
      return sql`l.subsidiary_id`;
    default:
      return sql`(l.extra_dims ->> ${dimension.slice("extra:".length)})`;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asAccountScope(input: unknown): AccountScope {
  if (!isRecord(input)) throw invalid("accountScope must be an object");
  if (input["kind"] === "any") return { kind: "any" };
  if (input["kind"] === "accounts" && Array.isArray(input["accountIds"])) {
    const accountIds = (input["accountIds"] as unknown[]).filter(
      (v): v is string => typeof v === "string" && v.length > 0,
    );
    if (accountIds.length > 0) return { kind: "accounts", accountIds };
  }
  if (
    input["kind"] === "account_group" &&
    typeof input["dimension"] === "string" &&
    typeof input["groupKey"] === "string"
  ) {
    return {
      kind: "account_group",
      dimension: input["dimension"] as string,
      groupKey: input["groupKey"] as string,
    };
  }
  throw invalid("accountScope must be any, accounts, or account_group");
}

async function resolveScopeAccountIds(orgId: string, scope: AccountScope): Promise<string[] | null> {
  if (scope.kind === "any") return null;
  if (scope.kind === "accounts") return [...new Set(scope.accountIds)];
  const resolved = await resolveAccountGroups(scope.dimension, orgId);
  const ids: string[] = [];
  for (const [accountId, ref] of resolved.byAccount) {
    if (ref.key === scope.groupKey) ids.push(accountId);
  }
  if (!resolved.groups.some((g) => g.key === scope.groupKey)) {
    throw notFound(`account group "${scope.groupKey}" not found in dimension "${scope.dimension}"`);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Resolver options (additive over types.ts DriverResolveRequest)
// ---------------------------------------------------------------------------

/**
 * Extra knobs the frozen `DriverResolveRequest` does not carry. The
 * resolver honors them when present; A3 passes `excludeRuleIds` for
 * idempotent re-runs and `bookId` for non-primary books.
 */
export type DriverResolveOptions = DriverResolveRequest & {
  /** Never include lines this rule produced (allocation_lineage rule ids). */
  excludeRuleIds?: string[];
  /** Posting book; defaults to the primary posting book. */
  bookId?: string | null;
};

export type ReportDriverRow = {
  dimension: string;
  value: string;
};

export type ReportDriverRunInput = {
  orgId: string;
  reportDefinitionId: string;
  dimensionColumn: string;
  valueColumn: string;
  params: Record<string, unknown>;
  from: string;
  to: string;
  actorId: string;
  /** The declared temporal contract, normalized by `validateDriverConfig`. */
  temporalMode: ReportTemporalMode;
};

/**
 * What the runner measured, plus the temporal contract it enforced to get
 * there. Previews and runs echo `temporal` so a vector never presents
 * period-less weights as period weights.
 */
export type ReportDriverEvidence = {
  rows: ReportDriverRow[];
  temporal: ReportDriverTemporal;
};

/**
 * Runs a report definition for a `report_definition` driver. Implemented
 * by the engine (`report-runner.ts`: the saved entity-query definition
 * compiled with the declared temporal contract enforced). The
 * implementation owns the report engine's permission checks under
 * `actorId`.
 */
export type ReportDriverRunner = {
  runReport(input: ReportDriverRunInput): Promise<ReportDriverEvidence>;
};

export type DriverResolverDeps = {
  reportRunner?: ReportDriverRunner;
};

type VectorRow = {
  dim: string;
  total: string;
};

function canonicalWeight(raw: unknown): string {
  return normalizeDecimal(String(raw ?? 0), 4);
}

function toVector(rows: VectorRow[]): DriverVector {
  const vector: DriverVector = new Map();
  for (const row of rows) {
    if (row.dim === null || row.dim === undefined || row.dim === "") continue;
    vector.set(String(row.dim), canonicalWeight(row.total));
  }
  return vector;
}

function lineageExclusion(orgId: string, excludeRuleIds: readonly string[]) {
  if (excludeRuleIds.length === 0) return sql``;
  return sql`and not exists (
    select 1 from allocation_lineage al
    where al.org_id = ${orgId}
      and al.journal_line_id = l.id
      and al.rule_id in (${sql.join(excludeRuleIds.map((id) => sql`${id}`), sql`, `)})
  )`;
}

// ---------------------------------------------------------------------------
// statistical_journal
// ---------------------------------------------------------------------------

async function resolveStatistical(
  orgId: string,
  driver: AllocationDriver,
  window: ResolvedWindow,
  opts: { subsidiaryId?: string | null; excludeRuleIds: readonly string[] },
): Promise<DriverVector> {
  const config = validateDriverConfig("statistical_journal", driver.config);
  const unit = config["unit"];
  if (typeof unit !== "string" || unit.length === 0) throw invalid("statistical driver needs config.unit");
  const accountIds = config["accountIds"];
  const accountList = accountIds === undefined
    ? undefined
    : (accountIds as unknown[]).filter((v): v is string => typeof v === "string" && v.length > 0);
  if (accountList !== undefined && accountList.length === 0) return new Map();
  const dim = journalDimExpr(driver.dimension);
  const rows = (await db.execute<VectorRow>(sql`
    select ${dim} as dim, coalesce(sum(l.quantity), 0) as total
    from journal_lines l
    join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
    where l.org_id = ${orgId}
      and e.status in ('posted', 'reversed')
      and l.quantity is not null
      and e.posting_date >= ${window.from} and e.posting_date <= ${window.to}
      and l.unit = ${unit}
      ${accountList ? sql`and l.account_id in (${sql.join(accountList.map((id) => sql`${id}`), sql`, `)})` : sql``}
      ${opts.subsidiaryId ? sql`and l.subsidiary_id = ${opts.subsidiaryId}` : sql``}
      and ${dim} is not null
      ${lineageExclusion(orgId, opts.excludeRuleIds)}
    group by 1
  `)).rows;
  return toVector(rows);
}

// ---------------------------------------------------------------------------
// manual
// ---------------------------------------------------------------------------

async function resolveManual(
  orgId: string,
  driver: AllocationDriver,
  asOf: DriverAsOf,
): Promise<DriverVector> {
  validateDriverConfig("manual", driver.config);
  const date = await resolveValueDate(orgId, asOf);
  const rows = await listDriverValues(orgId, driver.id, { onDate: date });
  const vector: DriverVector = new Map();
  for (const row of rows) {
    vector.set(row.dimensionValueId, canonicalWeight(row.value));
  }
  return vector;
}

// ---------------------------------------------------------------------------
// gl_activity / gl_balance
// ---------------------------------------------------------------------------

function monthAligned(window: ResolvedWindow): boolean {
  const month = monthWindow(window.from);
  return month.from === window.from && month.to === window.to;
}

/** The aggregate fits only for subsidiary splits with no lineage filter. */
function fitsAggregate(
  dimension: AllocationDimension,
  excludeRuleIds: readonly string[],
  window: ResolvedWindow,
): boolean {
  return dimension === "subsidiary" && excludeRuleIds.length === 0 && monthAligned(window);
}

async function resolveGlAggregate(
  orgId: string,
  scopeAccountIds: string[] | null,
  bookId: string,
  window: ResolvedWindow,
  balance: boolean,
  subsidiaryId?: string | null,
): Promise<DriverVector> {
  if (scopeAccountIds !== null && scopeAccountIds.length === 0) return new Map();
  const month = `${window.from.slice(0, 7)}-01`;
  const rows = (await db.execute<VectorRow>(sql`
    select g.subsidiary_id::text as dim, coalesce(sum(g.debit_total - g.credit_total), 0) as total
    from gl_month_activity g
    where g.org_id = ${orgId}
      and g.book_id = ${bookId}
      ${balance ? sql`and g.month <= ${month}` : sql`and g.month = ${month}`}
      ${scopeAccountIds ? sql`and g.account_id in (${sql.join(scopeAccountIds.map((id) => sql`${id}`), sql`, `)})` : sql``}
      ${subsidiaryId ? sql`and g.subsidiary_id = ${subsidiaryId}` : sql``}
    group by 1
  `)).rows;
  return toVector(rows);
}

async function resolveGlLines(
  orgId: string,
  driver: AllocationDriver,
  scopeAccountIds: string[] | null,
  bookId: string,
  window: ResolvedWindow,
  balance: boolean,
  opts: { subsidiaryId?: string | null; excludeRuleIds: readonly string[] },
): Promise<DriverVector> {
  if (scopeAccountIds !== null && scopeAccountIds.length === 0) return new Map();
  const dim = journalDimExpr(driver.dimension);
  const rows = (await db.execute<VectorRow>(sql`
    select ${dim} as dim, coalesce(sum(l.amount), 0) as total
    from journal_lines l
    join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
    where l.org_id = ${orgId}
      and e.status in ('posted', 'reversed')
      and e.book_id = ${bookId}
      ${balance ? sql`` : sql`and e.posting_date >= ${window.from}`}
      and e.posting_date <= ${window.to}
      ${scopeAccountIds ? sql`and l.account_id in (${sql.join(scopeAccountIds.map((id) => sql`${id}`), sql`, `)})` : sql``}
      ${opts.subsidiaryId ? sql`and l.subsidiary_id = ${opts.subsidiaryId}` : sql``}
      and ${dim} is not null
      ${lineageExclusion(orgId, opts.excludeRuleIds)}
    group by 1
  `)).rows;
  return toVector(rows);
}

async function resolveGl(
  orgId: string,
  driver: AllocationDriver,
  asOf: DriverAsOf,
  balance: boolean,
  opts: { subsidiaryId?: string | null; excludeRuleIds: readonly string[]; bookId?: string | null },
): Promise<DriverVector> {
  const window = await resolveWindow(orgId, asOf);
  const kind = balance ? "gl_balance" : "gl_activity";
  const config = validateDriverConfig(kind, driver.config);
  const scope = asAccountScope(config["accountScope"]);
  const scopeAccountIds = await resolveScopeAccountIds(orgId, scope);
  const bookId = opts.bookId ?? (await primaryPostingBookId(orgId));
  if (fitsAggregate(driver.dimension, opts.excludeRuleIds, window)) {
    return resolveGlAggregate(orgId, scopeAccountIds, bookId, window, balance, opts.subsidiaryId);
  }
  return resolveGlLines(orgId, driver, scopeAccountIds, bookId, window, balance, opts);
}

// ---------------------------------------------------------------------------
// native_measure
// ---------------------------------------------------------------------------

function nativeMeasureOf(driver: AllocationDriver): string {
  const config = validateDriverConfig("native_measure", driver.config);
  const measure = config["measure"];
  if (typeof measure !== "string" || measure.length === 0) throw invalid("native driver needs config.measure");
  return measure;
}

function requireDimension(driver: AllocationDriver, measure: string, supported: readonly string[]): void {
  if (!(supported as readonly string[]).includes(driver.dimension)) {
    throw new DriverNotAvailableError(
      `native measure "${measure}" has no data source for dimension "${driver.dimension}"`,
      "dimension",
    );
  }
}

async function resolveHeadcount(
  orgId: string,
  window: ResolvedWindow,
  subsidiaryId?: string | null,
): Promise<DriverVector> {
  // Employee roles active at any point in the window (the payroll-side
  // headcount, not time-entry presence — someone on leave still counts).
  const rows = (await db.execute<VectorRow>(sql`
    select er.department_id::text as dim, count(*) as total
    from employee_roles er
    join parties p on p.id = er.party_id and p.org_id = er.org_id
    where er.org_id = ${orgId}
      and er.is_active and p.is_active
      and (er.hired_on is null or er.hired_on <= ${window.to})
      and (er.terminated_on is null or er.terminated_on >= ${window.from})
      and er.department_id is not null
      ${subsidiaryId ? sql`and p.subsidiary_id = ${subsidiaryId}` : sql``}
    group by 1
  `)).rows;
  return toVector(rows);
}

async function resolveTimeHours(
  orgId: string,
  driver: AllocationDriver,
  window: ResolvedWindow,
  billedOnly: boolean,
  subsidiaryId?: string | null,
): Promise<DriverVector> {
  // Approved time only: draft, submitted, and rejected hours are not worked
  // reality (the same approved-only rule as utilization and project costing).
  const dim = driver.dimension === "project" ? sql`t.project_id` : sql`t.department_id`;
  const rows = (await db.execute<VectorRow>(sql`
    select ${dim}::text as dim, coalesce(sum(t.hours), 0) as total
    from time_entries t
    ${subsidiaryId ? sql`join parties p on p.id = t.employee_party_id and p.org_id = t.org_id` : sql``}
    where t.org_id = ${orgId}
      and t.status = 'approved'
      and t.worked_on >= ${window.from} and t.worked_on <= ${window.to}
      ${billedOnly ? sql`and t.is_billable` : sql``}
      ${subsidiaryId ? sql`and p.subsidiary_id = ${subsidiaryId}` : sql``}
      and ${dim} is not null
    group by 1
  `)).rows;
  return toVector(rows);
}

async function resolveNativeGl(
  orgId: string,
  driver: AllocationDriver,
  measure: string,
  window: ResolvedWindow,
  opts: { subsidiaryId?: string | null; excludeRuleIds: readonly string[]; bookId?: string | null },
): Promise<DriverVector> {
  // The True Cost base vocabulary (web/lib/analytics/true-cost-data.ts):
  // labor dollars, revenue, and direct cost straight from posted GL.
  const bookId = opts.bookId ?? (await primaryPostingBookId(orgId));
  const dim = journalDimExpr(driver.dimension);
  const accountFilter =
    measure === "labor_cost"
      ? sql`and a.type in ('expense', 'expense_other', 'expense_deferred', 'cogs')
             and a.name ~* 'wage|salary|payroll|labou?r'`
      : measure === "revenue"
        ? sql`and a.type in ('income', 'income_other')`
        : sql`and a.type = 'cogs'`;
  const sign = measure === "revenue" ? sql`-` : sql``;
  const rows = (await db.execute<VectorRow>(sql`
    select ${dim} as dim, coalesce(${sign}sum(l.amount), 0) as total
    from journal_lines l
    join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
    join accounts a on a.id = l.account_id and a.org_id = l.org_id
    where l.org_id = ${orgId}
      and e.status in ('posted', 'reversed')
      and e.book_id = ${bookId}
      and e.posting_date >= ${window.from} and e.posting_date <= ${window.to}
      and a.is_summary = false
      ${accountFilter}
      ${opts.subsidiaryId ? sql`and l.subsidiary_id = ${opts.subsidiaryId}` : sql``}
      and ${dim} is not null
      ${lineageExclusion(orgId, opts.excludeRuleIds)}
    group by 1
  `)).rows;
  return toVector(rows);
}

async function resolveRentableArea(
  orgId: string,
  subsidiaryId?: string | null,
): Promise<DriverVector> {
  // Rentable area is a point-in-time attribute of live units, not a flow:
  // every unit of an active property counts, whatever the period.
  const rows = (await db.execute<VectorRow>(sql`
    select mp.location_id::text as dim, coalesce(sum(pu.rentable_area), 0) as total
    from property_units pu
    join managed_properties mp on mp.id = pu.property_id and mp.org_id = pu.org_id
    where pu.org_id = ${orgId}
      and mp.status = 'active'
      and mp.location_id is not null
      and pu.rentable_area is not null
      ${subsidiaryId ? sql`and mp.subsidiary_id = ${subsidiaryId}` : sql``}
    group by 1
  `)).rows;
  return toVector(rows);
}

async function resolveNative(
  orgId: string,
  driver: AllocationDriver,
  asOf: DriverAsOf,
  opts: { subsidiaryId?: string | null; excludeRuleIds: readonly string[]; bookId?: string | null },
): Promise<DriverVector> {
  const measure = nativeMeasureOf(driver);
  const window = await resolveWindow(orgId, asOf);
  switch (measure) {
    case "headcount":
      requireDimension(driver, measure, ["department"]);
      return resolveHeadcount(orgId, window, opts.subsidiaryId);
    case "labor_hours":
    case "billed_hours":
      requireDimension(driver, measure, ["department", "project"]);
      return resolveTimeHours(orgId, driver, window, measure === "billed_hours", opts.subsidiaryId);
    case "labor_cost":
    case "revenue":
    case "direct_cost":
      return resolveNativeGl(orgId, driver, measure, window, opts);
    case "rentable_area":
      requireDimension(driver, measure, ["location"]);
      return resolveRentableArea(orgId, opts.subsidiaryId);
    default:
      throw invalid(`unknown native measure "${measure}"`);
  }
}

// ---------------------------------------------------------------------------
// report_definition
// ---------------------------------------------------------------------------

async function resolveReport(
  orgId: string,
  driver: AllocationDriver,
  asOf: DriverAsOf,
  actorId: string | null | undefined,
  runner: ReportDriverRunner | undefined,
): Promise<{ vector: DriverVector; temporal: ReportDriverTemporal }> {
  const config = validateDriverConfig("report_definition", driver.config);
  if (!actorId) throw invalid("report_definition drivers require an actorId");
  if (!runner) {
    throw new DriverNotAvailableError(
      "report_definition drivers need a report runner (wired by the web layer)",
      "config.reportDefinitionId",
    );
  }
  const window = await resolveWindow(orgId, asOf);
  const dimensionColumn = config["dimensionColumn"];
  const valueColumn = config["valueColumn"];
  const reportDefinitionId = config["reportDefinitionId"];
  const temporalMode = config["temporalMode"];
  if (
    typeof dimensionColumn !== "string" ||
    typeof valueColumn !== "string" ||
    typeof reportDefinitionId !== "string" ||
    (temporalMode !== "period_activity" &&
      temporalMode !== "balance_as_of" &&
      temporalMode !== "fixed_query")
  ) {
    throw invalid("report_definition driver needs reportDefinitionId, dimensionColumn, valueColumn");
  }
  const params = config["params"];
  const evidence = await runner.runReport({
    orgId,
    reportDefinitionId,
    dimensionColumn,
    valueColumn,
    params: isRecord(params) ? params : {},
    from: window.from,
    to: window.to,
    actorId,
    temporalMode,
  });
  const vector: DriverVector = new Map();
  for (const row of evidence.rows) {
    if (!row.dimension) continue;
    let value: string;
    try {
      value = canonicalWeight(row.value);
    } catch {
      throw invalid(`report row for "${row.dimension}" has a non-decimal value`);
    }
    vector.set(row.dimension, value);
  }
  return { vector, temporal: evidence.temporal };
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

async function resolveDriverVectorInner(
  request: DriverResolveRequest,
  deps: DriverResolverDeps = {},
): Promise<{ vector: DriverVector; temporal: ReportDriverTemporal | null }> {
  const opts: DriverResolveOptions = request;
  const { orgId, driver, asOf } = request;
  if (!orgId) throw invalid("orgId is required");
  if (!driver || driver.orgId !== orgId) {
    throw notFound("driver not found for this org");
  }
  parseAllocationDimension(driver.dimension);
  if (!(DRIVER_SOURCE_KINDS as readonly string[]).includes(driver.sourceKind)) {
    throw invalid(`unknown source_kind "${String(driver.sourceKind)}"`);
  }
  const excludeRuleIds = opts.excludeRuleIds ?? [];
  const shared = { subsidiaryId: request.subsidiaryId, excludeRuleIds, bookId: opts.bookId ?? null };
  let vector: DriverVector;
  let temporal: ReportDriverTemporal | null = null;
  switch (driver.sourceKind) {
    case "statistical_journal":
      vector = await resolveStatistical(orgId, driver, await resolveWindow(orgId, asOf), shared);
      break;
    case "manual":
      vector = await resolveManual(orgId, driver, asOf);
      break;
    case "gl_activity":
      vector = await resolveGl(orgId, driver, asOf, false, shared);
      break;
    case "gl_balance":
      vector = await resolveGl(orgId, driver, asOf, true, shared);
      break;
    case "native_measure":
      vector = await resolveNative(orgId, driver, asOf, shared);
      break;
    case "report_definition": {
      const reported = await resolveReport(orgId, driver, asOf, request.actorId, deps.reportRunner);
      vector = reported.vector;
      temporal = reported.temporal;
      break;
    }
  }
  const include = request.include ? new Set(request.include) : null;
  const exclude = request.exclude ? new Set(request.exclude) : null;
  if (!include && !exclude) return { vector, temporal };
  const filtered: DriverVector = new Map();
  for (const [key, value] of vector) {
    if (include && !include.has(key)) continue;
    if (exclude?.has(key)) continue;
    filtered.set(key, value);
  }
  return { vector: filtered, temporal };
}

async function resolveDriverVector(
  request: DriverResolveRequest,
  deps: DriverResolverDeps = {},
): Promise<DriverVector> {
  return (await resolveDriverVectorInner(request, deps)).vector;
}

/** Build a `DriverResolver` (types.ts contract) with optional dependencies. */
export function createDriverResolver(deps: DriverResolverDeps = {}): DriverResolver {
  return {
    async resolve(request: DriverResolveRequest): Promise<DriverVector> {
      return resolveDriverVector(request, deps);
    },
    async resolveWithTemporal(
      request: DriverResolveRequest,
    ): Promise<{ vector: DriverVector; temporal: ReportDriverTemporal | null }> {
      return resolveDriverVectorInner(request, deps);
    },
  };
}

/** Default resolver: every source_kind except `report_definition` (no runner). */
export const driverResolver: DriverResolver = createDriverResolver();

// ---------------------------------------------------------------------------
// previewDriverVector — the Drivers-tab vector preview (A8 routes)
// ---------------------------------------------------------------------------

export type DriverPreviewRequest = {
  orgId: string;
  driverId: string;
  asOf: DriverAsOf;
  include?: string[];
  exclude?: string[];
  subsidiaryId?: string | null;
  actorId?: string | null;
  excludeRuleIds?: string[];
  bookId?: string | null;
};

export type DriverPreview = {
  driver: AllocationDriver;
  from: string;
  to: string;
  vector: Array<{ key: string; value: string }>;
  total: string;
  /** The enforced temporal contract (report_definition drivers only). */
  temporal: ReportDriverTemporal | null;
};

/**
 * Resolve any driver kind to a sorted preview payload. Manual drivers read
 * the effective-dated values table; every other kind runs its resolver, so
 * the tab shows the same numbers a run would apportion on.
 */
export async function previewDriverVector(
  request: DriverPreviewRequest,
  deps: DriverResolverDeps = {},
): Promise<DriverPreview> {
  const driver = await getDriver(request.orgId, request.driverId);
  if (!driver) throw notFound(`allocation driver ${request.driverId} not found`);
  const window = await resolveWindow(request.orgId, request.asOf);
  const resolveRequest: DriverResolveOptions = {
    orgId: request.orgId,
    driver,
    asOf: request.asOf,
    include: request.include,
    exclude: request.exclude,
    subsidiaryId: request.subsidiaryId,
    actorId: request.actorId,
    excludeRuleIds: request.excludeRuleIds,
    bookId: request.bookId,
  };
  const { vector, temporal } = await resolveDriverVectorInner(resolveRequest, deps);
  const entries = [...vector.entries()]
    .map(([key, value]) => ({ key, value }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  let total = "0.0000";
  for (const entry of entries) total = add(total, entry.value);
  return { driver, from: window.from, to: window.to, vector: entries, total, temporal };
}
