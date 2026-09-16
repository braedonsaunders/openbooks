import { createHash, randomUUID } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { resolveAccountGroups } from "../account-groups.ts";
import { canonicalJson } from "../canonical-json.ts";
import { businessToday } from "../business-date.ts";
import { db, inDbTransaction } from "../db.ts";
import { add, cmp, isZero, neg, sum } from "../money.ts";
import { apportion, fixedPercentWeights } from "./apportion.ts";
import type { DriverResolveOptions } from "./drivers.ts";
import { allocationServiceDeps } from "./service.ts";
import {
  postProjectGlEntryWithinTransaction,
  reverseProjectGlEntryWithinTransaction,
  type GlLine,
} from "../project-recognition.ts";
import { uuidArray } from "../subsidiaries.ts";
import type {
  AccountScope,
  AllocationDimension,
  AllocationDriver,
  AllocationImpact,
  AllocationResidualPolicy,
  AllocationRunStatus,
  AllocationRunTrigger,
  AllocationSourceMeasure,
  ContributedLine,
  Coordinate,
  DimensionFilters,
  DriverResolveRequest,
  DriverResolver,
  DriverVector,
  RunComputation,
  WeightedTarget,
} from "./types.ts";

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Period-mode allocation runs (shard A3).
 *
 * preview → post → reverse / rerun over one allocation rule, one accounting
 * period, one book. The full explain payload (sources, driver vector,
 * per-target weight/share/amount/residual, journal lines) is stored on the
 * run; post and reverse never recompute, they mirror what preview stored.
 *
 * Apportionment is A1's canonical `./apportion.ts` (`apportion` plus
 * `fixedPercentWeights`): exact bigint money, floors plus a single residual
 * absorber, Σ(amounts) === total always. Likewise the driver vector resolves
 * through A2's `./drivers.ts` dispatcher by default (test doubles still plug
 * in through `PeriodRunDeps`).
 */

export interface PeriodRunDeps {
  driverResolver?: DriverResolver;
}

export interface PreviewAllocationRunOptions {
  orgId: string;
  ruleId: string;
  periodId: string;
  bookId: string;
  subsidiaryId?: string | null;
  actorId: string;
  trigger?: AllocationRunTrigger;
}

export interface AllocationRunRecord {
  id: string;
  orgId: string;
  ruleId: string;
  versionId: string;
  definitionHash: string;
  periodId: string;
  bookId: string;
  subsidiaryId: string | null;
  status: AllocationRunStatus;
  triggerKind: AllocationRunTrigger;
  sourceTotal: string;
  allocatedTotal: string;
  residual: string;
  journalEntryId: string | null;
  reversalEntryId: string | null;
  reversesRunId: string | null;
  supersededByRunId: string | null;
  computation: RunComputation;
  fingerprint: string | null;
  /** The approval flow run this run is waiting on (pending_approval only). */
  flowRunId: string | null;
}

/**
 * Posting options. `viaApproval` marks the approval engine's completion
 * callback: the version's approval flow already approved, so post directly.
 * `eventSource` records where an approval request came from for flow
 * conditions (scheduler and close automation pass their own source).
 */
export interface PostAllocationRunOptions {
  viaApproval?: boolean;
  eventSource?: "api" | "schedule" | "close_automation";
}

export interface RerunAllocationRunResult {
  run: AllocationRunRecord;
  /** True when the fresh computation fingerprinted identically: nothing posted. */
  idempotent: boolean;
}

/** Test double (and A2 stand-in): a resolver backed by a fixed weight map. */
export function staticDriverResolver(weights: Record<string, string>): DriverResolver {
  const entries = Object.entries(weights);
  return {
    resolve: async (request: DriverResolveRequest): Promise<DriverVector> => {
      const vector: DriverVector = new Map();
      for (const [key, value] of entries) {
        if (request.include && !request.include.includes(key)) continue;
        if (request.exclude?.includes(key)) continue;
        vector.set(key, value);
      }
      return vector;
    },
  };
}

// ---------------------------------------------------------------------------
// Apportionment is A1's canonical engine (`./apportion.ts`): exact bigint
// money, floors plus a single residual absorber, Σ(amounts) === total always.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Rule / version / period loading + guards
// ---------------------------------------------------------------------------

type RuleRow = {
  id: string;
  org_id: string;
  key: string;
  name: string;
  mode: string;
  is_active: boolean;
  current_version_id: string | null;
};

type VersionRow = {
  id: string;
  org_id: string;
  rule_id: string;
  status: string;
  effective_from: string;
  effective_to: string | null;
  book_scope: string;
  book_ids: string[] | null;
  account_scope: AccountScope;
  dimension_filters: DimensionFilters;
  source_measure: AllocationSourceMeasure;
  basis_kind: string;
  driver_id: string | null;
  driver_as_of: string;
  target_kind: string;
  dynamic_target: Partial<Record<string, unknown>>;
  impact: AllocationImpact;
  offset_account_id: string | null;
  residual_policy: AllocationResidualPolicy;
  residual_target_id: string | null;
  solve_method: string;
  approval_flow_id: string | null;
  memo_template: string | null;
  line_description_template: string | null;
  definition_hash: string | null;
};

type TargetRow = {
  id: string;
  sequence: number;
  target_account_id: string | null;
  department_id: string | null;
  location_id: string | null;
  class_id: string | null;
  project_id: string | null;
  subsidiary_id: string | null;
  extra_dims: Record<string, string> | null;
  fixed_percent: string | null;
  weight: string | null;
  is_remainder: boolean;
  label: string | null;
};

type PeriodRow = {
  id: string;
  org_id: string;
  name: string;
  starts_on: string;
  ends_on: string;
  fiscal_year: number;
};

type Tx = DbTransaction;

async function loadRule(tx: Tx, orgId: string, ruleId: string): Promise<RuleRow> {
  const rows = (await tx.execute<RuleRow>(sql`
    select id, org_id, key, name, mode, is_active, current_version_id
      from allocation_rules where id = ${ruleId} for share`)).rows;
  const rule = rows[0];
  if (!rule || rule.org_id !== orgId) {
    throw new Error(`allocation rule ${ruleId} does not belong to this organization`);
  }
  if (rule.mode !== "period") {
    throw new Error(`allocation rule ${rule.key} is a ${rule.mode} rule and cannot run as a period sweep`);
  }
  if (!rule.is_active) throw new Error(`allocation rule ${rule.key} is not active`);
  return rule;
}

async function loadVersionInForce(tx: Tx, rule: RuleRow, period: PeriodRow): Promise<VersionRow> {
  const load = async (id: string): Promise<VersionRow | undefined> =>
    (await tx.execute<VersionRow>(sql`
      select id, org_id, rule_id, status, effective_from::text, effective_to::text,
             book_scope, book_ids, account_scope, dimension_filters, source_measure,
             basis_kind, driver_id, driver_as_of, target_kind, dynamic_target, impact,
             offset_account_id, residual_policy, residual_target_id, approval_flow_id,
             memo_template, line_description_template, definition_hash, solve_method
        from allocation_rule_versions
       where id = ${id} and org_id = ${rule.org_id} for share`)).rows[0];
  const inWindow = (version: VersionRow): boolean =>
    version.effective_from <= period.ends_on &&
    (version.effective_to === null || version.effective_to >= period.starts_on);
  if (rule.current_version_id) {
    const current = await load(rule.current_version_id);
    if (current && current.status === "published" && inWindow(current)) return current;
  }
  const published = (await tx.execute<VersionRow>(sql`
    select id, org_id, rule_id, status, effective_from::text, effective_to::text,
           book_scope, book_ids, account_scope, dimension_filters, source_measure,
           basis_kind, driver_id, driver_as_of, target_kind, dynamic_target, impact,
           offset_account_id, residual_policy, residual_target_id, approval_flow_id,
           memo_template, line_description_template, definition_hash, solve_method
      from allocation_rule_versions
     where org_id = ${rule.org_id} and rule_id = ${rule.id} and status = 'published'
       and effective_from <= ${period.ends_on}
       and (effective_to is null or effective_to >= ${period.starts_on})
     order by version_no desc limit 1 for share`)).rows[0];
  if (!published) {
    throw new Error(`allocation rule ${rule.key} has no published version in effect for period ${period.name}`);
  }
  return published;
}

async function loadTargets(tx: Tx, orgId: string, versionId: string): Promise<TargetRow[]> {
  const rows = (await tx.execute<TargetRow>(sql`
    select id, sequence, target_account_id, department_id, location_id, class_id,
           project_id, subsidiary_id, extra_dims,
           fixed_percent::text, weight::text, is_remainder, label
      from allocation_rule_targets
     where org_id = ${orgId} and version_id = ${versionId}
     order by sequence for share`)).rows;
  return rows.map((row) => ({ ...row, extra_dims: row.extra_dims ?? {} }));
}

async function loadPeriod(tx: Tx, orgId: string, periodId: string): Promise<PeriodRow> {
  const rows = (await tx.execute<PeriodRow>(sql`
    select id, org_id, name, starts_on::text, ends_on::text, fiscal_year
      from accounting_periods where id = ${periodId} for share`)).rows;
  const period = rows[0];
  if (!period || period.org_id !== orgId) {
    throw new Error(`accounting period ${periodId} does not belong to this organization`);
  }
  return period;
}

async function loadBook(tx: Tx, orgId: string, bookId: string): Promise<{ id: string; code: string; isPrimary: boolean }> {
  const rows = (await tx.execute<{ id: string; org_id: string; code: string; is_primary: boolean }>(sql`
    select id, org_id, code, is_primary
      from accounting_books
     where id = ${bookId} and is_active and posts_gl for share`)).rows;
  const book = rows[0];
  if (!book || book.org_id !== orgId) {
    throw new Error(`accounting book ${bookId} does not belong to this organization`);
  }
  return { id: book.id, code: book.code, isPrimary: book.is_primary };
}

async function requireSubsidiary(tx: Tx, orgId: string, subsidiaryId: string): Promise<void> {
  const rows = (await tx.execute<{ id: string }>(sql`
    select id from subsidiaries where id = ${subsidiaryId} and org_id = ${orgId} and is_active for share`)).rows;
  if (!rows[0]) throw new Error(`subsidiary ${subsidiaryId} does not belong to this organization`);
}

/** Fail closed when the GL module is shut for any subsidiary this run touches. */
async function assertPeriodOpen(
  tx: Tx,
  orgId: string,
  period: PeriodRow,
  bookId: string,
  subsidiaryIds: string[],
): Promise<void> {
  const distinct = [...new Set(subsidiaryIds)];
  for (const subsidiaryId of distinct) {
    const rows = (await tx.execute<{ is_closed: boolean }>(sql`
      select period_module_is_closed(${orgId}, ${period.id}, ${bookId}, ${subsidiaryId}, 'gl') as is_closed`)).rows;
    if (rows[0]?.is_closed) {
      throw new Error(`the GL period ${period.name} is closed and cannot take allocation postings`);
    }
  }
}

function renderMemo(
  template: string | null | undefined,
  vars: { ruleName: string; periodName: string; targetLabel: string },
): string {
  const fallback = vars.targetLabel
    ? `${vars.ruleName} — ${vars.periodName} — ${vars.targetLabel}`
    : `${vars.ruleName} — ${vars.periodName}`;
  if (!template) return fallback;
  return template
    .split("{{rule.name}}").join(vars.ruleName)
    .split("{{period.name}}").join(vars.periodName)
    .split("{{target.label}}").join(vars.targetLabel);
}

// ---------------------------------------------------------------------------
// Source read: per-coordinate pool amounts, excluding this rule's own lines
// ---------------------------------------------------------------------------

interface SourceCoordinate extends Coordinate {
  amount: string;
  lineCount: number;
}

interface SourcePool {
  sources: SourceCoordinate[];
  total: string;
}

function dimensionFilterSql(filters: DimensionFilters): { clause: SQL; subsidiaryIds: string[] } {
  const parts: SQL[] = [];
  const eqAny = (column: string, ids: string[] | undefined): void => {
    if (ids && ids.length > 0) parts.push(sql`and l.${sql.raw(column)} = any(${uuidArray(ids)}::uuid[])`);
  };
  eqAny("department_id", filters.departmentIds);
  eqAny("location_id", filters.locationIds);
  eqAny("class_id", filters.classIds);
  eqAny("project_id", filters.projectIds);
  eqAny("party_id", filters.partyIds);
  if (filters.itemIds && filters.itemIds.length > 0) {
    throw new Error("item filters do not apply to period-mode source balances");
  }
  const extra = filters.extraDims ?? {};
  for (const [segment, values] of Object.entries(extra)) {
    if (values.length > 0) parts.push(sql`and l.extra_dims ->> ${segment} = any(${values}::text[])`);
  }
  const untagged = filters.requireUntagged ?? [];
  for (const dimension of untagged) {
    const column = dimension === "class" ? "class_id" : `${dimension}_id`;
    parts.push(sql`and l.${sql.raw(column)} is null`);
  }
  return { clause: sql.join(parts, sql` `), subsidiaryIds: filters.subsidiaryIds ?? [] };
}

async function readSources(
  tx: Tx,
  opts: {
    orgId: string;
    ruleId: string;
    period: PeriodRow;
    bookId: string;
    subsidiaryId: string | null;
    accountScope: AccountScope;
    dimensionFilters: DimensionFilters;
    sourceMeasure: AllocationSourceMeasure;
  },
): Promise<SourcePool> {
  const { clause: filterClause, subsidiaryIds: filterSubs } = dimensionFilterSql(opts.dimensionFilters);
  const scopeSubs = opts.subsidiaryId ? [opts.subsidiaryId] : filterSubs;
  const subClause = scopeSubs.length > 0
    ? sql`and l.subsidiary_id = any(${uuidArray(scopeSubs)}::uuid[])`
    : sql``;

  let accountClause: SQL = sql``;
  if (opts.accountScope.kind === "accounts") {
    if (opts.accountScope.accountIds.length === 0) {
      return { sources: [], total: "0.0000" };
    }
    accountClause = sql`and l.account_id = any(${uuidArray(opts.accountScope.accountIds)}::uuid[])`;
  } else if (opts.accountScope.kind === "account_group") {
    const { dimension, groupKey } = opts.accountScope;
    const resolved = await resolveAccountGroups(dimension, opts.orgId);
    const groupIds = [...resolved.byAccount.entries()]
      .filter(([, ref]) => ref.key === groupKey)
      .map(([accountId]) => accountId);
    if (groupIds.length === 0) return { sources: [], total: "0.0000" };
    accountClause = sql`and l.account_id = any(${uuidArray(groupIds)}::uuid[])`;
  }

  let periodClause: SQL;
  if (opts.sourceMeasure === "period_activity") {
    periodClause = sql`and e.period_id = ${opts.period.id}`;
  } else if (opts.sourceMeasure === "ytd_activity") {
    periodClause = sql`and e.period_id in (
      select id from accounting_periods
       where org_id = ${opts.orgId} and not is_adjustment
         and fiscal_year = ${opts.period.fiscal_year} and ends_on <= ${opts.period.ends_on})`;
  } else {
    periodClause = sql`and e.period_id in (
      select id from accounting_periods
       where org_id = ${opts.orgId} and not is_adjustment and ends_on <= ${opts.period.ends_on})`;
  }

  const rows = (await tx.execute<{
    account_id: string;
    subsidiary_id: string;
    department_id: string | null;
    location_id: string | null;
    class_id: string | null;
    project_id: string | null;
    party_id: string | null;
    extra_dims: Record<string, string> | null;
    amount: string;
    line_count: string;
  }>(sql`
    select l.account_id, l.subsidiary_id, l.department_id, l.location_id, l.class_id,
           l.project_id, l.party_id, l.extra_dims,
           sum(l.amount)::text as amount, count(*)::text as line_count
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
     where l.org_id = ${opts.orgId}
       and e.book_id = ${opts.bookId}
       and e.status in ('posted', 'reversed')
       ${periodClause} ${subClause} ${accountClause} ${filterClause}
       and not exists (
         select 1 from allocation_lineage lineage
          where lineage.org_id = l.org_id and lineage.rule_id = ${opts.ruleId}
            and lineage.journal_line_id = l.id)
       -- Null-safe: kernel lines carry no contributor stamp, and a bare
       -- NOT (nullable = ...) would evaluate to NULL and hide the whole pool.
       and (
         coalesce(l.contributor_kind, 'kernel') <> 'rule'
         or coalesce(l.contributor_ref, '00000000-0000-0000-0000-000000000000'::uuid) not in (
           select id from allocation_rule_versions
            where org_id = ${opts.orgId} and rule_id = ${opts.ruleId})
       )
     group by l.account_id, l.subsidiary_id, l.department_id, l.location_id,
              l.class_id, l.project_id, l.party_id, l.extra_dims
    having sum(l.amount) <> 0
     order by l.account_id, l.subsidiary_id, l.department_id, l.location_id,
              l.class_id, l.project_id, l.party_id`)).rows;

  const sources: SourceCoordinate[] = rows.map((row) => ({
    accountId: row.account_id,
    subsidiaryId: row.subsidiary_id,
    departmentId: row.department_id,
    locationId: row.location_id,
    classId: row.class_id,
    projectId: row.project_id,
    partyId: row.party_id,
    extraDims: row.extra_dims ?? {},
    amount: row.amount,
    lineCount: Number(row.line_count),
  }));
  return { sources, total: sum(sources.map((source) => source.amount)) };
}

// ---------------------------------------------------------------------------
// Target weights: fixed percents, manual weights, or the driver vector
// ---------------------------------------------------------------------------

interface ResolvedTarget {
  key: string;
  weight: string;
  coordinate: Coordinate;
  label: string;
  driverValue: string | null;
}

const DIMENSION_TABLES: Record<string, "departments" | "locations" | "classes" | "projects" | "subsidiaries"> = {
  department: "departments",
  location: "locations",
  class: "classes",
  project: "projects",
  subsidiary: "subsidiaries",
};

function targetDimensionValue(target: TargetRow, dimension: AllocationDimension): string | null {
  if (dimension === "department") return target.department_id;
  if (dimension === "location") return target.location_id;
  if (dimension === "class") return target.class_id;
  if (dimension === "project") return target.project_id;
  if (dimension === "subsidiary") return target.subsidiary_id;
  return target.extra_dims?.[dimension.slice("extra:".length)] ?? null;
}

function setDimensionValue(coordinate: Coordinate, dimension: AllocationDimension, valueId: string): void {
  if (dimension === "department") coordinate.departmentId = valueId;
  else if (dimension === "location") coordinate.locationId = valueId;
  else if (dimension === "class") coordinate.classId = valueId;
  else if (dimension === "project") coordinate.projectId = valueId;
  else if (dimension === "subsidiary") coordinate.subsidiaryId = valueId;
  else coordinate.extraDims = { ...(coordinate.extraDims ?? {}), [dimension.slice("extra:".length)]: valueId };
}

/**
 * Explicit-target weights via A1's `fixedPercentWeights` (percent grids) or
 * straight manual weights. Percent and manual-weight targets never mix, and a
 * remainder target only pairs with a percent grid — ambiguous grids fail
 * closed here instead of silently under-allocating.
 */
function resolveExplicitWeights(
  targets: TargetRow[],
): { weights: WeightedTarget[] } {
  if (targets.length === 0) throw new Error("allocation rule version has no targets");
  const percentTargets = targets.filter((target) => target.fixed_percent !== null);
  const weightTargets = targets.filter((target) => target.fixed_percent === null && target.weight !== null);
  const bare = targets.filter((target) => target.fixed_percent === null && target.weight === null && !target.is_remainder);
  if (bare.length > 0) {
    throw new Error("explicit allocation targets need a fixed percent or a weight");
  }
  const remainders = targets.filter((target) => target.is_remainder);
  if (remainders.length > 1) throw new Error("at most one explicit target may take the remainder");
  if (remainders.length === 1 && weightTargets.length > 0) {
    throw new Error("a remainder target cannot be mixed with manual-weight targets");
  }
  if (percentTargets.length > 0 && weightTargets.length > 0) {
    throw new Error("cannot mix fixed-percent and manual-weight targets on one version");
  }
  if (percentTargets.length > 0 || remainders.length === 1) {
    const weights = fixedPercentWeights(targets.map((target) => ({
      sequence: target.sequence,
      id: target.id,
      fixedPercent: target.fixed_percent,
      weight: target.weight,
      isRemainder: target.is_remainder,
    })));
    return { weights };
  }
  return {
    weights: targets.map((target) => ({ key: target.id, weight: target.weight! })),
  };
}

async function resolveDriverVectorForRun(
  tx: Tx,
  opts: {
    orgId: string;
    version: VersionRow;
    ruleId: string;
    ruleKey: string;
    period: PeriodRow;
    bookId: string;
    subsidiaryId: string | null;
    actorId: string;
  },
  deps: PeriodRunDeps,
): Promise<{ driverId: string; driverKey: string; dimension: string; asOf: { periodId: string } | { date: string }; vector: DriverVector }> {
  if (!opts.version.driver_id) throw new Error(`allocation rule ${opts.ruleKey} uses a driver basis but names no driver`);
  const rows = (await tx.execute<{
    id: string; org_id: string; key: string; name: string; unit: string | null;
    dimension: string; source_kind: AllocationDriver["sourceKind"]; config: Record<string, unknown>;
    is_active: boolean;
  }>(sql`
    select id, org_id, key, name, unit, dimension, source_kind, config, is_active
      from allocation_drivers
     where id = ${opts.version.driver_id} for share`)).rows;
  const driver = rows[0];
  if (!driver || driver.org_id !== opts.orgId) {
    throw new Error(`allocation driver ${opts.version.driver_id} does not belong to this organization`);
  }
  if (!driver.is_active) throw new Error(`allocation driver ${driver.key} is not active`);
  // A2's dispatcher covers every source_kind; report_definition needs the
  // production runner, which the single service factory provides by default.
  // Callers may still inject a test double through deps.
  const resolver = deps.driverResolver ?? allocationServiceDeps().driverResolver;
  let asOf: { periodId: string } | { date: string };
  if (opts.version.driver_as_of === "prior_period") {
    const prior = (await tx.execute<{ id: string }>(sql`
      select id from accounting_periods
       where org_id = ${opts.orgId} and not is_adjustment and ends_on < ${opts.period.starts_on}
       order by ends_on desc limit 1`)).rows[0];
    if (!prior) throw new Error(`no prior period exists for driver lookback on ${opts.period.name}`);
    asOf = { periodId: prior.id };
  } else if (opts.version.driver_as_of === "document_date") {
    asOf = { date: opts.period.ends_on };
  } else {
    asOf = { periodId: opts.period.id };
  }
  // A2 honors these knobs when present: this rule's own lines stay out of
  // GL-backed driver vectors (idempotent re-runs) and the vector follows the
  // run's book. Plain DriverResolver doubles ignore the extra fields.
  const request: DriverResolveOptions = {
    orgId: opts.orgId,
    driver: {
      id: driver.id,
      orgId: opts.orgId,
      key: driver.key,
      name: driver.name,
      unit: driver.unit,
      dimension: driver.dimension as AllocationDimension,
      sourceKind: driver.source_kind,
      config: driver.config ?? {},
      isActive: driver.is_active,
    },
    asOf,
    subsidiaryId: opts.subsidiaryId,
    actorId: opts.actorId,
    excludeRuleIds: [opts.ruleId],
    bookId: opts.bookId,
  };
  const vector = await resolver.resolve(request);
  return { driverId: driver.id, driverKey: driver.key, dimension: driver.dimension, asOf, vector };
}

async function resolveTargets(
  tx: Tx,
  opts: {
    orgId: string;
    version: VersionRow;
    ruleId: string;
    ruleKey: string;
    period: PeriodRow;
    bookId: string;
    subsidiaryId: string | null;
    actorId: string;
    targets: TargetRow[];
  },
  deps: PeriodRunDeps,
): Promise<{
  resolved: ResolvedTarget[];
  weights: WeightedTarget[];
  driver: { id: string; key: string; asOf: { periodId: string } | { date: string }; vector: Array<{ key: string; value: string }> } | null;
}> {
  if (opts.version.basis_kind === "stepped") {
    throw new Error("stepped allocation basis is not supported by period runs yet");
  }
  if (opts.version.target_kind === "dynamic") {
    const dynamic = opts.version.dynamic_target as {
      dimension?: AllocationDimension; include?: string[]; exclude?: string[]; minWeight?: string; targetAccountId?: string | null;
    };
    const dimension = dynamic.dimension;
    if (!dimension) throw new Error("dynamic allocation targets name no dimension");
    if (opts.version.basis_kind !== "driver") {
      throw new Error("dynamic allocation targets need a driver basis");
    }
    const table = DIMENSION_TABLES[dimension];
    if (!table) throw new Error(`dynamic allocation targets on ${dimension} are not supported yet`);
    const include = dynamic.include ?? [];
    const exclude = dynamic.exclude ?? [];
    const minWeight = dynamic.minWeight ?? "0";
    const resolved = await resolveDriverVectorForRun(tx, opts, deps);
    let values = (await tx.execute<{ id: string; name: string }>(sql`
      select id, name from ${sql.raw(table)}
       where org_id = ${opts.orgId} and is_active
         ${include.length > 0 ? sql`and id = any(${uuidArray(include)}::uuid[])` : sql``}
         ${exclude.length > 0 ? sql`and not (id = any(${uuidArray(exclude)}::uuid[]))` : sql``}
         ${dimension === "subsidiary" && opts.subsidiaryId ? sql`and id = ${opts.subsidiaryId}` : sql``}
       order by name, id for share`)).rows;
    values = values.filter((value) => {
      const weight = resolved.vector.get(value.id) ?? "0";
      return cmp(weight, minWeight) > 0;
    });
    if (values.length === 0) throw new Error("no dynamic allocation target clears the minimum weight");
    const resolvedTargets: ResolvedTarget[] = values.map((value) => {
      const coordinate: Coordinate = {
        accountId: dynamic.targetAccountId ?? "",
        subsidiaryId: null,
        departmentId: null,
        locationId: null,
        classId: null,
        projectId: null,
        extraDims: {},
      };
      setDimensionValue(coordinate, dimension, value.id);
      return {
        key: value.id,
        weight: resolved.vector.get(value.id) ?? "0",
        coordinate,
        label: value.name,
        driverValue: resolved.vector.get(value.id) ?? "0",
      };
    });
    return {
      resolved: resolvedTargets,
      weights: resolvedTargets.map((target) => ({ key: target.key, weight: target.weight })),
      driver: {
        id: resolved.driverId,
        key: resolved.driverKey,
        asOf: resolved.asOf,
        vector: [...resolved.vector.entries()].map(([key, value]) => ({ key, value })),
      },
    };
  }

  // Explicit targets.
  if (opts.version.basis_kind === "driver") {
    const resolved = await resolveDriverVectorForRun(tx, opts, deps);
    const driverDimension = resolved.dimension as AllocationDimension;
    const resolvedTargets: ResolvedTarget[] = opts.targets.map((target) => {
      const value = targetDimensionValue(target, driverDimension);
      if (!value) {
        throw new Error("explicit driver-basis targets must carry a value in the driver dimension");
      }
      const coordinate: Coordinate = {
        accountId: target.target_account_id ?? "",
        subsidiaryId: target.subsidiary_id,
        departmentId: target.department_id,
        locationId: target.location_id,
        classId: target.class_id,
        projectId: target.project_id,
        extraDims: target.extra_dims ?? {},
      };
      return {
        key: target.id,
        weight: resolved.vector.get(value) ?? "0",
        coordinate,
        label: target.label ?? `Target ${target.sequence}`,
        driverValue: resolved.vector.get(value) ?? "0",
      };
    });
    return {
      resolved: resolvedTargets,
      weights: resolvedTargets.map((target) => ({ key: target.key, weight: target.weight })),
      driver: {
        id: resolved.driverId,
        key: resolved.driverKey,
        asOf: resolved.asOf,
        vector: [...resolved.vector.entries()].map(([key, value]) => ({ key, value })),
      },
    };
  }

  const { weights } = resolveExplicitWeights(opts.targets);
  const byRow = new Map(opts.targets.map((target) => [target.id, target]));
  const resolvedTargets: ResolvedTarget[] = weights.map((weight) => {
    const row = byRow.get(weight.key)!;
    return {
      key: weight.key,
      weight: weight.weight,
      coordinate: {
        accountId: row.target_account_id ?? "",
        subsidiaryId: row.subsidiary_id,
        departmentId: row.department_id,
        locationId: row.location_id,
        classId: row.class_id,
        projectId: row.project_id,
        extraDims: row.extra_dims ?? {},
      },
      label: row.label ?? `Target ${row.sequence}`,
      driverValue: row.weight,
    };
  });
  return { resolved: resolvedTargets, weights, driver: null };
}

// ---------------------------------------------------------------------------
// Computation: apportion the pool, build lines per impact, fingerprint
// ---------------------------------------------------------------------------

interface BuiltComputation {
  computation: RunComputation;
  fingerprint: string;
  sourceTotal: string;
  allocatedTotal: string;
  residual: string;
}

function sameDims(coordinate: Coordinate, source: SourceCoordinate): Coordinate {
  return {
    accountId: coordinate.accountId || source.accountId,
    subsidiaryId: coordinate.subsidiaryId ?? source.subsidiaryId,
    departmentId: coordinate.departmentId ?? source.departmentId,
    locationId: coordinate.locationId ?? source.locationId,
    classId: coordinate.classId ?? source.classId,
    projectId: coordinate.projectId ?? source.projectId,
    partyId: source.partyId,
    extraDims: { ...(source.extraDims ?? {}), ...(coordinate.extraDims ?? {}) },
  };
}

async function buildComputation(
  tx: Tx,
  opts: {
    orgId: string;
    rule: RuleRow;
    version: VersionRow;
    targets: TargetRow[];
    period: PeriodRow;
    bookId: string;
    subsidiaryId: string | null;
    actorId: string;
  },
  deps: PeriodRunDeps,
): Promise<BuiltComputation> {
  if (!opts.version.definition_hash) {
    throw new Error(`allocation rule ${opts.rule.key} has a published version with no definition hash`);
  }
  // Reciprocal (simultaneous) solving is not implemented — publication
  // refuses it, and this guard covers versions published before the refusal
  // so no entry point can silently execute them sequentially instead.
  if (opts.version.solve_method === "simultaneous") {
    throw new Error(
      `allocation rule ${opts.rule.key} uses simultaneous solving, which is not supported; republish it as sequential`,
    );
  }
  // Book scope: a primary-scoped version only sweeps the primary book.
  if (opts.version.book_scope === "primary") {
    const primary = (await tx.execute<{ id: string }>(sql`
      select id from accounting_books
       where org_id = ${opts.orgId} and is_primary and is_active limit 1 for share`)).rows[0];
    if (!primary || primary.id !== opts.bookId) {
      throw new Error(`allocation rule ${opts.rule.key} is scoped to the primary book`);
    }
  } else if (opts.version.book_scope === "books") {
    const allowed = (opts.version.book_ids ?? []) as string[];
    if (!allowed.includes(opts.bookId)) {
      throw new Error(`allocation rule ${opts.rule.key} does not cover the requested book`);
    }
  }

  const pool = await readSources(tx, {
    orgId: opts.orgId,
    ruleId: opts.rule.id,
    period: opts.period,
    bookId: opts.bookId,
    subsidiaryId: opts.subsidiaryId,
    accountScope: opts.version.account_scope,
    dimensionFilters: opts.version.dimension_filters,
    sourceMeasure: opts.version.source_measure,
  });
  // An empty pool apportions to exact zeros and would post a journal-less
  // "posted" run with no lineage that consumes the one-posted-run slot, so a
  // later period with real data cannot post. Fail closed: run when there is
  // something to allocate.
  if (pool.sources.length === 0) {
    throw new Error(
      `allocation rule ${opts.rule.key} found no source lines for period ${opts.period.name}; refusing to post an empty run`,
    );
  }
  const targetSet = await resolveTargets(
    tx,
    {
      orgId: opts.orgId,
      version: opts.version,
      ruleId: opts.rule.id,
      ruleKey: opts.rule.key,
      period: opts.period,
      bookId: opts.bookId,
      subsidiaryId: opts.subsidiaryId,
      actorId: opts.actorId,
      targets: opts.targets,
    },
    deps,
  );
  if (targetSet.resolved.length === 0) throw new Error("allocation produced no targets");
  // Zero weights carry no basis: A1 would split equally, which invents
  // attribution for driver/manual targets, so fail closed instead. Percent
  // grids always sum to 100 and never trip this.
  if (cmp(sum(targetSet.weights.map((weight) => weight.weight)), "0") === 0) {
    throw new Error("allocation produced no positive target weight");
  }

  // A1's absorber precedence: an explicit residual key wins, else a sole
  // remainder target absorbs, else the residual policy decides.
  const residualKey = opts.version.residual_policy === "explicit_target"
    ? (opts.version.residual_target_id ?? undefined)
    : undefined;
  const display = apportion(pool.total, targetSet.weights, opts.version.residual_policy, residualKey);

  const driverTotal = targetSet.driver
    ? targetSet.driver.vector.reduce((acc, entry) => add(acc, entry.value), "0")
    : null;
  const byKey = new Map(targetSet.resolved.map((target) => [target.key, target]));
  const displayByKey = new Map(display.targets.map((target) => [target.key, target]));

  // Per-source apportionment keeps every account exact when the pool spans
  // several source accounts: each source is credited once and its own amount
  // is split across the targets, so Σ(lines) === 0 by construction.
  type BuiltLine = ContributedLine & { lineNumber: number };
  const lines: BuiltLine[] = [];
  const targetAmounts = new Map<string, string>();
  const targetResiduals = new Map<string, string>();
  let lineNumber = 1;
  const memoFor = (label: string): string =>
    renderMemo(opts.version.line_description_template ?? opts.version.memo_template, {
      ruleName: opts.rule.name,
      periodName: opts.period.name,
      targetLabel: label,
    });

  if (opts.version.impact === "report_only") {
    // No journal lines — but the statistical targets still carry the
    // apportioned amounts so reports and the fingerprint see the split.
    for (const apportioned of display.targets) {
      targetAmounts.set(apportioned.key, apportioned.amount);
      targetResiduals.set(apportioned.key, apportioned.residual);
    }
  } else {
    for (const source of pool.sources) {
      const split = apportion(source.amount, targetSet.weights, opts.version.residual_policy, residualKey);
      const creditAccount = opts.version.impact === "reclass"
        ? (opts.version.offset_account_id ?? source.accountId)
        : source.accountId;
      // Reclass credits the offset (contra/clearing) account when one is set,
      // else the source coordinate itself; net_zero_pair always credits the
      // source account at the source coordinate so no account total can move.
      const creditCoordinate: Coordinate = {
        ...sameDims({ accountId: "", subsidiaryId: null, extraDims: {} }, source),
        accountId: creditAccount,
      };
      const creditLine: BuiltLine = {
        ...creditCoordinate,
        amount: neg(source.amount),
        memo: memoFor(""),
        contributorKind: "rule",
        contributorRef: opts.version.id,
        lineNumber: lineNumber++,
        lineage: {
          mode: "period",
          ruleId: opts.rule.id,
          versionId: opts.version.id,
          definitionHash: opts.version.definition_hash,
          amount: neg(source.amount),
          residual: "0.0000",
        },
      };
      lines.push(creditLine);
      for (const apportioned of split.targets) {
        const target = byKey.get(apportioned.key)!;
        if (opts.version.impact === "net_zero_pair" && target.coordinate.accountId && target.coordinate.accountId !== source.accountId) {
          throw new Error("net_zero_pair targets must use the source account so no account total moves");
        }
        const coordinate = sameDims(target.coordinate, source);
        if (opts.version.impact === "net_zero_pair") coordinate.accountId = source.accountId;
        const debitLine: BuiltLine = {
          ...coordinate,
          amount: apportioned.amount,
          memo: memoFor(target.label),
          contributorKind: "rule",
          contributorRef: opts.version.id,
          lineNumber: lineNumber++,
          lineage: {
            mode: "period",
            ruleId: opts.rule.id,
            versionId: opts.version.id,
            definitionHash: opts.version.definition_hash,
            driverId: targetSet.driver?.id ?? null,
            driverValue: target.driverValue,
            driverTotal,
            share: apportioned.share,
            amount: apportioned.amount,
            residual: apportioned.residual,
          },
        };
        lines.push(debitLine);
        targetAmounts.set(target.key, add(targetAmounts.get(target.key) ?? "0.0000", apportioned.amount));
        targetResiduals.set(target.key, add(targetResiduals.get(target.key) ?? "0.0000", apportioned.residual));
      }
    }
    const check = sum(lines.map((line) => line.amount));
    if (!isZero(check)) throw new Error(`allocation lines do not balance (${check})`);
  }

  const computation: RunComputation = {
    ruleId: opts.rule.id,
    versionId: opts.version.id,
    definitionHash: opts.version.definition_hash,
    periodId: opts.period.id,
    bookId: opts.bookId,
    subsidiaryId: opts.subsidiaryId,
    sourceMeasure: opts.version.source_measure,
    sources: pool.sources.map((source) => ({
      accountId: source.accountId,
      subsidiaryId: source.subsidiaryId,
      departmentId: source.departmentId,
      locationId: source.locationId,
      classId: source.classId,
      projectId: source.projectId,
      partyId: source.partyId,
      extraDims: source.extraDims,
      amount: source.amount,
      lineCount: source.lineCount,
    })),
    sourceTotal: pool.total,
    driver: targetSet.driver,
    targets: targetSet.resolved.map((target) => {
      const shown = displayByKey.get(target.key)!;
      return {
        key: target.key,
        weight: target.weight,
        share: shown.share,
        amount: targetAmounts.get(target.key) ?? "0.0000",
        residual: targetResiduals.get(target.key) ?? "0.0000",
        coordinate: sameDims(target.coordinate, pool.sources[0] ?? {
          accountId: target.coordinate.accountId || "",
          subsidiaryId: opts.subsidiaryId,
          extraDims: {},
          amount: "0.0000",
          lineCount: 0,
        }),
        label: target.label,
      };
    }),
    lines,
    residualPolicy: opts.version.residual_policy,
    impact: opts.version.impact,
  };
  const fingerprint = createHash("sha256").update(canonicalJson(computation)).digest("hex");
  const residual = sum(computation.targets.map((target) => target.residual));
  return {
    computation,
    fingerprint,
    sourceTotal: pool.total,
    allocatedTotal: sum(computation.targets.map((target) => target.amount)),
    residual,
  };
}

// ---------------------------------------------------------------------------
// Run rows
// ---------------------------------------------------------------------------

type RunRow = {
  id: string;
  org_id: string;
  rule_id: string;
  version_id: string;
  definition_hash: string;
  period_id: string;
  book_id: string;
  subsidiary_id: string | null;
  status: AllocationRunStatus;
  trigger_kind: AllocationRunTrigger;
  source_total: string;
  allocated_total: string;
  residual: string;
  journal_entry_id: string | null;
  reversal_entry_id: string | null;
  reverses_run_id: string | null;
  superseded_by_run_id: string | null;
  computation: RunComputation;
  fingerprint: string | null;
  flow_run_id: string | null;
};

function toRecord(row: RunRow): AllocationRunRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    ruleId: row.rule_id,
    versionId: row.version_id,
    definitionHash: row.definition_hash,
    periodId: row.period_id,
    bookId: row.book_id,
    subsidiaryId: row.subsidiary_id,
    status: row.status,
    triggerKind: row.trigger_kind,
    sourceTotal: row.source_total,
    allocatedTotal: row.allocated_total,
    residual: row.residual,
    journalEntryId: row.journal_entry_id,
    reversalEntryId: row.reversal_entry_id,
    reversesRunId: row.reverses_run_id,
    supersededByRunId: row.superseded_by_run_id,
    computation: row.computation,
    fingerprint: row.fingerprint,
    flowRunId: row.flow_run_id,
  };
}

const RUN_COLUMNS = sql`
  id, org_id, rule_id, version_id, definition_hash, period_id, book_id,
  subsidiary_id, status, trigger_kind,
  source_total::text, allocated_total::text, residual::text,
  journal_entry_id, reversal_entry_id, reverses_run_id, superseded_by_run_id,
  computation, fingerprint, flow_run_id`;

async function insertRunRow(
  tx: Tx,
  opts: {
    orgId: string;
    ruleId: string;
    actorId: string;
    trigger: AllocationRunTrigger;
    built: BuiltComputation;
    versionId: string;
    definitionHash: string;
    periodId: string;
    bookId: string;
    subsidiaryId: string | null;
  },
): Promise<RunRow> {
  const id = randomUUID();
  await tx.execute(sql`
    insert into allocation_runs
      (id, org_id, rule_id, version_id, definition_hash, period_id, book_id, subsidiary_id,
       status, trigger_kind, source_total, allocated_total, residual,
       computation, fingerprint, requested_by, started_at, completed_at, created_by, updated_by)
    values (${id}, ${opts.orgId}, ${opts.ruleId}, ${opts.versionId}, ${opts.definitionHash},
            ${opts.periodId}, ${opts.bookId}, ${opts.subsidiaryId},
            'previewed', ${opts.trigger}, ${opts.built.sourceTotal}, ${opts.built.allocatedTotal},
            ${opts.built.residual}, ${JSON.stringify(opts.built.computation)}::jsonb,
            ${opts.built.fingerprint}, ${opts.actorId}, now(), now(), ${opts.actorId}, ${opts.actorId})`);
  const rows = (await tx.execute<RunRow>(sql`
    select ${RUN_COLUMNS} from allocation_runs where id = ${id} and org_id = ${opts.orgId}`)).rows;
  const row = rows[0];
  if (!row) throw new Error("allocation run insert returned no row");
  return row;
}

async function writeAudit(
  tx: Tx,
  orgId: string,
  runId: string,
  actorId: string,
  changes: Record<string, unknown>,
): Promise<void> {
  await tx.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
    values (${orgId}, 'allocation_runs', ${runId}, 'update',
            ${JSON.stringify(changes)}::jsonb, ${actorId}, 'allocation_run')`);
}

// ---------------------------------------------------------------------------
// Journal write + lineage (shared by post and rerun)
// ---------------------------------------------------------------------------

function computationGlLines(computation: RunComputation): GlLine[] {
  return computation.lines.map((line) => ({
    accountId: line.accountId,
    amount: line.amount,
    projectId: line.projectId ?? null,
    partyId: line.partyId ?? null,
    memo: line.memo ?? null,
    departmentId: line.departmentId ?? null,
    locationId: line.locationId ?? null,
    classId: line.classId ?? null,
    subsidiaryId: line.subsidiaryId ?? null,
    extraDims: line.extraDims ?? {},
    contributorKind: "rule" as const,
    contributorRef: line.contributorRef,
  }));
}

/**
 * Post the stored computation's lines as an origin='allocation' journal and
 * stamp lineage per line. Report-only (or empty) computations post nothing
 * and return null. The computation is NEVER recomputed here.
 */
async function postStoredJournal(
  tx: Tx,
  opts: {
    orgId: string;
    actorId: string;
    run: RunRow;
    ruleKey: string;
    period: PeriodRow;
    entryNumberSuffix: string;
  },
): Promise<string | null> {
  const computation = opts.run.computation;
  if (computation.lines.length === 0) return null;
  const glLines = computationGlLines(computation);
  const headerSubsidiary = opts.run.subsidiary_id ?? glLines[0]?.subsidiaryId ?? null;
  const lineSubs = glLines.map((line) => line.subsidiaryId ?? headerSubsidiary);
  if (lineSubs.some((sub) => !sub)) throw new Error("allocation lines are missing a subsidiary");
  await assertPeriodOpen(tx, opts.orgId, opts.period, opts.run.book_id, lineSubs as string[]);
  const duplicate = (await tx.execute<{ id: string }>(sql`
    select id from allocation_runs
     where org_id = ${opts.orgId} and rule_id = ${opts.run.rule_id}
       and period_id = ${opts.run.period_id} and book_id = ${opts.run.book_id}
       and coalesce(subsidiary_id, '00000000-0000-0000-0000-000000000000'::uuid)
         = coalesce(${opts.run.subsidiary_id}, '00000000-0000-0000-0000-000000000000'::uuid)
       and status = 'posted' and id <> ${opts.run.id} for share`)).rows[0];
  if (duplicate) {
    throw new Error("one posted run already exists for this rule, period, book and subsidiary");
  }
  // Entry memo from the rule key and period (the per-line memos already carry
  // the rendered memo/line-description templates from preview time).
  const memo = `Allocation ${opts.ruleKey} — ${opts.period.name}`;
  const entryId = await postProjectGlEntryWithinTransaction(tx, {
    orgId: opts.orgId,
    actorId: opts.actorId,
    origin: "allocation",
    entryNumber: `ALLOC-${opts.ruleKey}-${opts.period.name}-${opts.entryNumberSuffix}`,
    postingDate: opts.period.ends_on,
    memo,
    subsidiaryId: headerSubsidiary,
    bookId: opts.run.book_id,
    lines: glLines,
  });
  if (!entryId) throw new Error("allocation journal posting returned no entry");
  const postedLines = (await tx.execute<{ id: string; line_number: number }>(sql`
    select id, line_number from journal_lines
     where org_id = ${opts.orgId} and entry_id = ${entryId} order by line_number for share`)).rows;
  const lineIdByNumber = new Map(postedLines.map((line) => [line.line_number, line.id]));
  for (const line of computation.lines) {
    const journalLineId = lineIdByNumber.get(line.lineNumber);
    if (!journalLineId) throw new Error(`allocation journal is missing line ${line.lineNumber}`);
    const draft = line.lineage;
    await tx.execute(sql`
      insert into allocation_lineage
        (id, org_id, mode, rule_id, version_id, definition_hash, run_id,
         journal_entry_id, journal_line_id,
         driver_id, driver_value, driver_total, share, amount, residual)
      values (${randomUUID()}, ${opts.orgId}, 'period', ${computation.ruleId}, ${computation.versionId},
              ${computation.definitionHash}, ${opts.run.id},
              ${entryId}, ${journalLineId},
              ${draft?.driverId ?? null}, ${draft?.driverValue ?? null}, ${draft?.driverTotal ?? null},
              ${draft?.share ?? null}, ${line.amount}, ${draft?.residual ?? "0.0000"})`);
  }
  return entryId;
}

/** Lineage for a report-only post: per-target statistical rows, no journal. */
async function writeReportLineage(
  tx: Tx,
  opts: { orgId: string; run: RunRow },
): Promise<void> {
  const computation = opts.run.computation;
  const driverTotal = computation.driver
    ? computation.driver.vector.reduce((acc, entry) => add(acc, entry.value), "0")
    : null;
  const vectorByKey = new Map((computation.driver?.vector ?? []).map((entry) => [entry.key, entry.value]));
  for (const target of computation.targets) {
    await tx.execute(sql`
      insert into allocation_lineage
        (id, org_id, mode, rule_id, version_id, definition_hash, run_id,
         driver_id, driver_value, driver_total, share, amount, residual)
      values (${randomUUID()}, ${opts.orgId}, 'period', ${computation.ruleId}, ${computation.versionId},
              ${computation.definitionHash}, ${opts.run.id},
              ${computation.driver?.id ?? null}, ${vectorByKey.get(target.key) ?? null},
              ${driverTotal}, ${target.share}, ${target.amount}, ${target.residual})`);
  }
}

/**
 * Mirror the stored journal via the existing reversal helper and write the
 * reversal's lineage by negating the original rows (never recomputed).
 */
async function reverseStoredJournal(
  tx: Tx,
  opts: {
    orgId: string;
    actorId: string;
    run: RunRow;
    reason: string;
    reversalDate: string;
  },
): Promise<string | null> {
  if (!opts.run.journal_entry_id) {
    // Report-only runs post no journal: the reversal mirrors the statistical
    // rows with negated amounts so the attribution nets to zero in reports.
    const originals = (await tx.execute<{ id: string }>(sql`
      select id from allocation_lineage
       where org_id = ${opts.orgId} and run_id = ${opts.run.id} for share`)).rows;
    for (const original of originals) {
      await tx.execute(sql`
        insert into allocation_lineage
          (id, org_id, mode, rule_id, version_id, definition_hash, run_id,
           driver_id, driver_value, driver_total, share, amount, residual)
        select ${randomUUID()}, ${opts.orgId}, mode, rule_id, version_id, definition_hash, run_id,
               driver_id, driver_value, driver_total, share, -amount, -residual
          from allocation_lineage where id = ${original.id}`);
    }
    return null;
  }
  const reversal = await reverseProjectGlEntryWithinTransaction(
    tx,
    opts.orgId,
    opts.actorId,
    opts.run.journal_entry_id,
    opts.reason,
    opts.reversalDate,
  );
  if (reversal.status === "missing") {
    throw new Error(`allocation journal ${opts.run.journal_entry_id} is missing`);
  }
  const reversalEntryId = reversal.reversalId;
  if (!reversalEntryId) throw new Error("allocation reversal returned no entry");
  const reversalLines = (await tx.execute<{ id: string; line_number: number }>(sql`
    select id, line_number from journal_lines
     where org_id = ${opts.orgId} and entry_id = ${reversalEntryId} order by line_number for share`)).rows;
  const reversalByNumber = new Map(reversalLines.map((line) => [line.line_number, line.id]));
  const originals = (await tx.execute<{
    journal_line_id: string | null; line_number: number | null;
    driver_id: string | null; driver_value: string | null; driver_total: string | null;
    share: string | null; amount: string; residual: string;
  }>(sql`
    select lineage.journal_line_id, line.line_number,
           lineage.driver_id, lineage.driver_value::text, lineage.driver_total::text,
           lineage.share::text, lineage.amount::text, lineage.residual::text
      from allocation_lineage lineage
      left join journal_lines line
        on line.id = lineage.journal_line_id and line.org_id = lineage.org_id
     where lineage.org_id = ${opts.orgId} and lineage.run_id = ${opts.run.id}
       and lineage.journal_entry_id = ${opts.run.journal_entry_id}`)).rows;
  for (const original of originals) {
    const reversalLineId = original.line_number === null
      ? null
      : (reversalByNumber.get(original.line_number) ?? null);
    await tx.execute(sql`
      insert into allocation_lineage
        (id, org_id, mode, rule_id, version_id, definition_hash, run_id,
         journal_entry_id, journal_line_id,
         driver_id, driver_value, driver_total, share, amount, residual)
      values (${randomUUID()}, ${opts.orgId}, 'period', ${opts.run.rule_id}, ${opts.run.version_id},
              ${opts.run.definition_hash}, ${opts.run.id},
              ${reversalEntryId}, ${reversalLineId},
              ${original.driver_id}, ${original.driver_value}, ${original.driver_total},
              ${original.share}, ${neg(original.amount)}, ${neg(original.residual)})`);
  }
  return reversalEntryId;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function requireActor(actorId: string): void {
  if (!actorId) throw new Error("an attributable actor is required");
}

function requireReason(reason: string, what: string): string {
  const trimmed = reason.trim();
  if (trimmed.length === 0 || trimmed.length > 500) {
    throw new Error(`a ${what} reason between 1 and 500 characters is required`);
  }
  return trimmed;
}

/**
 * Compute a period sweep and store it as a `previewed` run. Previewing never
 * writes GL — it only reads the pool, resolves the driver vector, apportions,
 * and stores the full computation with its sha256 fingerprint.
 */
export async function previewAllocationRun(
  opts: PreviewAllocationRunOptions,
  deps: PeriodRunDeps = {},
): Promise<AllocationRunRecord> {
  requireActor(opts.actorId);
  return inDbTransaction(async (tx) => {
    const subsidiaryId = opts.subsidiaryId ?? null;
    const period = await loadPeriod(tx, opts.orgId, opts.periodId);
    const book = await loadBook(tx, opts.orgId, opts.bookId);
    if (subsidiaryId) await requireSubsidiary(tx, opts.orgId, subsidiaryId);
    const rule = await loadRule(tx, opts.orgId, opts.ruleId);
    const version = await loadVersionInForce(tx, rule, period);
    const targets = await loadTargets(tx, opts.orgId, version.id);
    const built = await buildComputation(
      tx,
      {
        orgId: opts.orgId,
        rule,
        version,
        targets,
        period,
        bookId: book.id,
        subsidiaryId,
        actorId: opts.actorId,
      },
      deps,
    );
    const row = await insertRunRow(tx, {
      orgId: opts.orgId,
      ruleId: rule.id,
      actorId: opts.actorId,
      trigger: opts.trigger ?? "manual",
      built,
      versionId: version.id,
      definitionHash: version.definition_hash!,
      periodId: period.id,
      bookId: book.id,
      subsidiaryId,
    });
    await writeAudit(tx, opts.orgId, row.id, opts.actorId, {
      mode: "allocation_run_preview",
      rule: rule.key,
      period: period.name,
      book: book.code,
      fingerprint: built.fingerprint,
    });
    return toRecord(row);
  });
}

/** Lock a run row for a state transition; the run's own org scopes everything. */
async function lockRun(tx: Tx, runId: string): Promise<RunRow> {
  const rows = (await tx.execute<RunRow>(sql`
    select ${RUN_COLUMNS} from allocation_runs where id = ${runId} for update`)).rows;
  const run = rows[0];
  if (!run) throw new Error(`allocation run ${runId} was not found`);
  return run;
}

/**
 * Open the version's approval flow for a previewed run: validate the
 * configured flow, dispatch the run's `on_submit` flows, and park the run in
 * `pending_approval` with `flow_run_id` stamped. NO journal is written here —
 * the flow engine's release posts it (actor = approver) or records the
 * rejection. Fails closed when the configured flow is missing, disabled,
 * for another subject kind, or produces no gate: the run stays previewed.
 */
async function openRunApproval(
  tx: Tx,
  opts: {
    orgId: string;
    run: RunRow;
    ruleKey: string;
    actorId: string;
    reason: string;
    approvalFlowId: string;
    eventSource: "api" | "schedule" | "close_automation";
  },
): Promise<AllocationRunRecord> {
  const { orgId, run } = opts;
  const flow = (await tx.execute<{ id: string; subject_kind: string; enabled: boolean }>(sql`
    select id, subject_kind, enabled from flows
     where id = ${opts.approvalFlowId} and org_id = ${orgId} for share`)).rows[0];
  if (!flow) {
    throw new Error(`allocation approval flow ${opts.approvalFlowId} is not configured for this organization`);
  }
  if (flow.subject_kind !== "allocation_run") {
    throw new Error(`allocation approval flow ${opts.approvalFlowId} is not an allocation_run flow`);
  }
  if (!flow.enabled) {
    throw new Error(`allocation approval flow ${opts.approvalFlowId} is not enabled`);
  }
  // Break the static import cycle (the allocation adapter calls back into
  // postAllocationRun on release).
  const { runRecordFlows } = await import("../flows/index.ts");
  const dispatched = await runRecordFlows(
    { kind: "on_submit", source: opts.eventSource },
    "allocation_run",
    run.id,
    { orgId, userId: opts.actorId },
  );
  const gated = dispatched.runs.find(
    (item) => item.flowId === opts.approvalFlowId && item.gatesCreated > 0,
  );
  if (!gated) {
    // Fail closed like close approval: cancel anything the dispatch opened
    // so a half-routed approval cannot linger, then refuse — the run stays
    // previewed and no journal exists.
    const openedIds = dispatched.runs.map((item) => item.runId);
    if (openedIds.length > 0) {
      await tx.execute(sql`
        update flow_gates set status = 'cancelled', updated_at = now(), updated_by = ${opts.actorId}
         where run_id in (select jsonb_array_elements_text(${JSON.stringify(openedIds)}::jsonb)::uuid)
           and org_id = ${orgId} and status in ('pending', 'escalated')`);
      await tx.execute(sql`
        update flow_runs set status = 'cancelled', finished_at = now(), updated_at = now(), updated_by = ${opts.actorId}
         where id in (select jsonb_array_elements_text(${JSON.stringify(openedIds)}::jsonb)::uuid)
           and org_id = ${orgId} and status in ('running', 'waiting')`);
    }
    throw new Error(
      dispatched.failed
        ? "allocation approval routing failed"
        : `allocation approval flow ${opts.approvalFlowId} produced no approval gate`,
    );
  }
  await tx.execute(sql`
    update allocation_runs
       set status = 'pending_approval', flow_run_id = ${gated.runId},
           requested_by = ${opts.actorId}, error = null,
           completed_at = null, updated_at = now(), updated_by = ${opts.actorId}
     where id = ${run.id} and org_id = ${orgId}`);
  await writeAudit(tx, orgId, run.id, opts.actorId, {
    mode: "allocation_run_approval_requested",
    reason: opts.reason,
    approvalFlowId: opts.approvalFlowId,
    flowRunId: gated.runId,
  });
  return toRecord({ ...run, status: "pending_approval", flow_run_id: gated.runId });
}

/**
 * Post a previewed run: in ONE transaction, re-check the period/book/closed
 * module (same checks as depreciation), write the origin='allocation' journal
 * from the STORED computation, stamp lineage, and flip previewed→posted.
 * At most one posted run per (rule, period, book, subsidiary).
 *
 * When the run's version names an approval_flow_id (and this call is not the
 * approval engine's release), the run is NOT posted: the approval flow opens
 * and the run waits in pending_approval instead.
 */
export async function postAllocationRun(
  runId: string,
  actorId: string,
  reason: string,
  opts: PostAllocationRunOptions = {},
): Promise<AllocationRunRecord> {
  requireActor(actorId);
  const cleanReason = requireReason(reason, "posting");
  return inDbTransaction(async (tx) => {
    const run = await lockRun(tx, runId);
    if (opts.viaApproval) {
      // The approval engine's release: the run waited in pending_approval
      // for exactly this call. Anything else is a double-release or a
      // lifecycle violation — never post it.
      if (run.status !== "pending_approval") {
        throw new Error(`allocation run ${runId} is ${run.status} and cannot be released from approval`);
      }
    } else if (run.status !== "previewed") {
      throw new Error(`allocation run ${runId} is ${run.status} and cannot be posted`);
    }
    const orgId = run.org_id;
    const period = await loadPeriod(tx, orgId, run.period_id);
    // The preview's world may have moved on (rule deactivated, version
    // retired): re-check the head and the pinned version before money moves,
    // the same guards preview and rerun already enforce.
    const rule = await loadRule(tx, orgId, run.rule_id);
    const ruleKey = rule.key;
    const version = (await tx.execute<VersionRow>(sql`
      select id, org_id, rule_id, status, effective_from::text, effective_to::text,
             book_scope, book_ids, account_scope, dimension_filters, source_measure,
             basis_kind, driver_id, driver_as_of, target_kind, dynamic_target, impact,
             offset_account_id, residual_policy, residual_target_id, approval_flow_id,
             memo_template, line_description_template, definition_hash, solve_method
        from allocation_rule_versions
       where id = ${run.version_id} and org_id = ${orgId} for share`)).rows[0];
    if (!version || version.status !== "published") {
      throw new Error(
        `allocation rule ${ruleKey} version ${run.version_id} is ${version?.status ?? "missing"} and cannot take postings`,
      );
    }
    const approvalFlowId = version?.approval_flow_id ?? null;
    if (approvalFlowId && !opts.viaApproval) {
      return openRunApproval(tx, {
        orgId,
        run,
        ruleKey,
        actorId,
        reason: cleanReason,
        approvalFlowId,
        eventSource: opts.eventSource ?? "api",
      });
    }
    let journalEntryId: string | null = null;
    try {
      journalEntryId = await postStoredJournal(tx, {
        orgId,
        actorId,
        run,
        ruleKey,
        period,
        entryNumberSuffix: run.id.slice(0, 8),
      });
      if (!journalEntryId && run.computation.impact === "report_only") {
        await writeReportLineage(tx, { orgId, run });
      }
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as { code?: string }).code === "23505") {
        throw new Error("one posted run already exists for this rule, period, book and subsidiary");
      }
      throw error;
    }
    await tx.execute(sql`
      update allocation_runs
         set status = 'posted', journal_entry_id = ${journalEntryId},
             completed_at = now(), updated_at = now(), updated_by = ${actorId}
       where id = ${run.id} and org_id = ${orgId}`);
    await writeAudit(tx, orgId, run.id, actorId, {
      mode: "allocation_run_post",
      reason: cleanReason,
      journalEntryId,
    });
    return toRecord({ ...run, status: "posted", journal_entry_id: journalEntryId });
  });
}

export interface ReverseAllocationRunOptions {
  reversalDate?: string;
}

/**
 * Reverse a posted run by mirroring its STORED lines (never recomputed) via
 * the existing project-GL reversal helper. Refused when the run's period is
 * closed — same rule as depreciation.
 */
export async function reverseAllocationRun(
  runId: string,
  actorId: string,
  reason: string,
  opts: ReverseAllocationRunOptions = {},
): Promise<AllocationRunRecord> {
  requireActor(actorId);
  const cleanReason = reason.trim();
  if (cleanReason.length < 5 || cleanReason.length > 500) {
    throw new Error("a reversal reason between 5 and 500 characters is required");
  }
  return inDbTransaction(async (tx) => {
    const run = await lockRun(tx, runId);
    if (run.status !== "posted") {
      throw new Error(`allocation run ${runId} is ${run.status} and cannot be reversed`);
    }
    const orgId = run.org_id;
    const period = await loadPeriod(tx, orgId, run.period_id);
    const reversalDate = opts.reversalDate ?? (await businessToday(orgId));
    // The reversal lands on the reversal date AND unwinds this run's period:
    // both GL scopes must be open.
    const computation = run.computation;
    const touchedSubs = computation.lines.length > 0
      ? computation.lines.map((line) => line.subsidiaryId ?? run.subsidiary_id).filter((sub): sub is string => !!sub)
      : [
        ...(run.subsidiary_id ? [run.subsidiary_id] : []),
        ...computation.sources.map((source) => source.subsidiaryId).filter((sub): sub is string => !!sub),
      ];
    await assertPeriodOpen(tx, orgId, period, run.book_id, touchedSubs);
    const reversalEntryId = await reverseStoredJournal(tx, {
      orgId,
      actorId,
      run,
      reason: cleanReason,
      reversalDate,
    });
    await tx.execute(sql`
      update allocation_runs
         set status = 'reversed', reversal_entry_id = ${reversalEntryId},
             completed_at = now(), updated_at = now(), updated_by = ${actorId}
       where id = ${run.id} and org_id = ${orgId}`);
    await writeAudit(tx, orgId, run.id, actorId, {
      mode: "allocation_run_reverse",
      reason: cleanReason,
      reversalDate,
      reversalEntryId,
    });
    return toRecord({ ...run, status: "reversed", reversal_entry_id: reversalEntryId });
  });
}

export interface RerunAllocationRunOptions {
  reversalDate?: string;
}

/**
 * Reverse + preview + post as one atomic chain. When the fresh computation
 * fingerprints identically to the stored one, nothing is posted and the
 * existing run is returned (idempotent). Otherwise the old run is reversed
 * (or superseded, if it never posted) and the new run carries
 * reverses_run_id while the old points back via superseded_by_run_id.
 */
export async function rerunAllocationRun(
  runId: string,
  actorId: string,
  reason: string,
  opts: RerunAllocationRunOptions = {},
  deps: PeriodRunDeps = {},
): Promise<RerunAllocationRunResult> {
  requireActor(actorId);
  const cleanReason = reason.trim();
  if (cleanReason.length < 5 || cleanReason.length > 500) {
    throw new Error("a re-run reason between 5 and 500 characters is required");
  }
  return inDbTransaction(async (tx) => {
    const run = await lockRun(tx, runId);
    if (run.status !== "posted" && run.status !== "previewed" && run.status !== "reversed") {
      throw new Error(`allocation run ${runId} is ${run.status} and cannot be re-run`);
    }
    const orgId = run.org_id;
    const period = await loadPeriod(tx, orgId, run.period_id);
    const book = await loadBook(tx, orgId, run.book_id);
    if (run.subsidiary_id) await requireSubsidiary(tx, orgId, run.subsidiary_id);
    const rule = await loadRule(tx, orgId, run.rule_id);
    const version = await loadVersionInForce(tx, rule, period);
    const targets = await loadTargets(tx, orgId, version.id);
    const built = await buildComputation(
      tx,
      {
        orgId,
        rule,
        version,
        targets,
        period,
        bookId: book.id,
        subsidiaryId: run.subsidiary_id,
        actorId,
      },
      deps,
    );
    if (built.fingerprint === run.fingerprint) {
      return { run: toRecord(run), idempotent: true };
    }
    const fresh = await insertRunRow(tx, {
      orgId,
      ruleId: rule.id,
      actorId,
      trigger: "rerun",
      built,
      versionId: version.id,
      definitionHash: version.definition_hash!,
      periodId: period.id,
      bookId: book.id,
      subsidiaryId: run.subsidiary_id,
    });
    const reversalDate = opts.reversalDate ?? (await businessToday(orgId));
    if (run.status === "posted") {
      const computation = run.computation;
      const touchedSubs = computation.lines.length > 0
        ? computation.lines.map((line) => line.subsidiaryId ?? run.subsidiary_id).filter((sub): sub is string => !!sub)
        : [
          ...(run.subsidiary_id ? [run.subsidiary_id] : []),
          ...computation.sources.map((source) => source.subsidiaryId).filter((sub): sub is string => !!sub),
        ];
      await assertPeriodOpen(tx, orgId, period, run.book_id, touchedSubs);
      const reversalEntryId = await reverseStoredJournal(tx, {
        orgId,
        actorId,
        run,
        reason: cleanReason,
        reversalDate,
      });
      await tx.execute(sql`
        update allocation_runs
           set status = 'reversed', reversal_entry_id = ${reversalEntryId},
               superseded_by_run_id = ${fresh.id},
               completed_at = now(), updated_at = now(), updated_by = ${actorId}
         where id = ${run.id} and org_id = ${orgId}`);
    } else if (run.status === "reversed") {
      // Already unwound (reversal_entry_id kept): just chain forward.
      await tx.execute(sql`
        update allocation_runs
           set superseded_by_run_id = ${fresh.id},
               completed_at = now(), updated_at = now(), updated_by = ${actorId}
         where id = ${run.id} and org_id = ${orgId}`);
    } else {
      await tx.execute(sql`
        update allocation_runs
           set status = 'superseded', superseded_by_run_id = ${fresh.id},
               completed_at = now(), updated_at = now(), updated_by = ${actorId}
         where id = ${run.id} and org_id = ${orgId}`);
    }
    // A re-run under a flow-governed version needs fresh approval: the new
    // run waits in pending_approval instead of posting (same path as post).
    if (version.approval_flow_id) {
      const waiting = await openRunApproval(tx, {
        orgId,
        run: fresh,
        ruleKey: rule.key,
        actorId,
        reason: cleanReason,
        approvalFlowId: version.approval_flow_id,
        eventSource: "api",
      });
      await tx.execute(sql`
        update allocation_runs
           set reverses_run_id = ${run.id}
         where id = ${fresh.id} and org_id = ${orgId}`);
      await writeAudit(tx, orgId, fresh.id, actorId, {
        mode: "allocation_run_rerun",
        reason: cleanReason,
        reversesRunId: run.id,
        flowRunId: waiting.flowRunId,
      });
      return {
        run: { ...waiting, reversesRunId: run.id },
        idempotent: false,
      };
    }
    let journalEntryId: string | null = null;
    try {
      journalEntryId = await postStoredJournal(tx, {
        orgId,
        actorId,
        run: fresh,
        ruleKey: rule.key,
        period,
        entryNumberSuffix: fresh.id.slice(0, 8),
      });
      if (!journalEntryId && fresh.computation.impact === "report_only") {
        await writeReportLineage(tx, { orgId, run: fresh });
      }
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as { code?: string }).code === "23505") {
        throw new Error("one posted run already exists for this rule, period, book and subsidiary");
      }
      throw error;
    }
    await tx.execute(sql`
      update allocation_runs
         set status = 'posted', journal_entry_id = ${journalEntryId},
             reverses_run_id = ${run.id},
             completed_at = now(), updated_at = now(), updated_by = ${actorId}
       where id = ${fresh.id} and org_id = ${orgId}`);
    await writeAudit(tx, orgId, fresh.id, actorId, {
      mode: "allocation_run_rerun",
      reason: cleanReason,
      reversesRunId: run.id,
      journalEntryId,
    });
    return {
      run: toRecord({ ...fresh, status: "posted", journal_entry_id: journalEntryId, reverses_run_id: run.id }),
      idempotent: false,
    };
  });
}

/**
 * Reads stay in A8's `./run-queries.ts` (`listRuns`, `getRun`,
 * `queryLineage`) — the single run/list/detail surface shared with the Runs
 * tab. period-run.ts owns the lifecycle (preview/post/reverse/rerun) only.
 */





