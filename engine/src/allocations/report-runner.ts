import { sql } from "drizzle-orm";
import {
  compileCustomQuery,
  customQueryReferencesBook,
  isBaseMoneyMeasure,
  isMoneyBlendingMeasure,
  isTxnCurrencyMeasure,
  MAX_REPORT_ROWS,
  parseDenominationCounts,
  payrollRestrictedEntity,
  REPORT_ENTITY_MAP,
  resolveDenominations,
  resolvePeriodPresetLeaves,
  resolvePreset,
  validateCustomQuery,
  type CompiledReportQuery,
  type ReportCustomQuery,
  type ReportMeasure,
} from "@openbooks/reports";
import { db, pool } from "../platform/db.ts";
import { dataDependentFeatureDefault } from "../organization/feature-defaults.ts";
import { featureEnabled, type FeatureState } from "../organization/feature-registry.ts";
import { add, normalizeDecimal } from "../money/money.ts";
import { actorHasPermission } from "../organization/actor-permissions.ts";
import { actorAllowedSubsidiaryIds } from "../organization/actor-subsidiaries.ts";
import { ensureReportDefinitions } from "../reports/ensure-report-definitions.ts";
import { DriverAdminError } from "./driver-admin.ts";
import {
  createDriverResolver,
  DriverNotAvailableError,
  type ReportDriverEvidence,
  type ReportDriverRow,
  type ReportDriverRunInput,
  type ReportDriverRunner,
} from "./drivers.ts";
import type { DriverResolver, ReportDriverTemporal } from "./types.ts";
import {
  applyReportPeriodWindow,
  resolveReportPeriodField,
} from "./report-window.ts";

/**
 * Engine-side `ReportDriverRunner` for `report_definition` drivers (A5
 * composition over A2's resolver contract).
 *
 * It runs a saved entity-query definition exactly the way the report routes
 * do — same compiler, same org/subsidiary/book scoping, same fiscal bins —
 * under the calling actor's permissions, and projects two columns out of the
 * raw rows (display shaping would corrupt the measure). Definitions carry
 * their own filters, so the run needs no parameter dialect; the window the
 * driver passes is honoured through the as-of snapshot.
 *
 * Boundaries (loud, never silent): statement-kind definitions run through
 * the statement engine, which has no engine entry point; custom-record
 * entities resolve through the web catalog; period presets need declared
 * periods. A driver pointed at any of those refuses instead of measuring.
 * Display queries are bounded (the saved limit, at most MAX_REPORT_ROWS);
 * when the evidence reaches that bound the runner cannot prove completeness,
 * so it refuses with driver_evidence_truncated instead of weighing a silent
 * prefix of the inputs.
 */
export async function runDriverReport(input: ReportDriverRunInput): Promise<ReportDriverEvidence> {
  const { orgId, reportDefinitionId, dimensionColumn, valueColumn, actorId } = input;
  if (!actorId) {
    throw new DriverNotAvailableError("report_definition drivers require an actorId");
  }
  if (!(await actorHasPermission(db, orgId, actorId, "reports.read"))) {
    throw new DriverNotAvailableError("actor cannot run reports");
  }
  await ensureReportDefinitions(orgId);
  const def = (await db.execute<{
    report_type: string;
    query: unknown;
    statement: unknown;
  }>(sql`
    select report_type, query, statement from report_definitions
     where id = ${reportDefinitionId} and org_id = ${orgId} limit 1`)).rows[0];
  if (!def) throw new DriverAdminError("not_found", "report definition not found");
  if (def.report_type !== "query" || !def.query || typeof def.query !== "object") {
    throw new DriverAdminError(
      "validation",
      "report_definition drivers need an entity-query definition",
    );
  }
  let plan: ReportCustomQuery;
  try {
    plan = validateCustomQuery(def.query, REPORT_ENTITY_MAP);
  } catch (error) {
    throw new DriverAdminError("validation", error instanceof Error ? error.message : String(error));
  }
  const baseEntity = REPORT_ENTITY_MAP[plan.entity];
  if (!baseEntity) throw new DriverAdminError("validation", `unknown report entity ${plan.entity}`);
  // The driver measures what the actor may see: a restricted actor's ledger
  // sources arrive pre-collapsed per (entry, account, currency) before the
  // driver aggregation, so no allocation base can isolate one employee's pay.
  const entity = payrollRestrictedEntity(baseEntity, await actorHasPermission(db, orgId, actorId, "payroll.read"));
  if (entity.key.startsWith("custom:")) {
    throw new DriverAdminError("validation", "custom report entities are not supported as driver sources");
  }
  if (entity.requiredPermission && !(await actorHasPermission(db, orgId, actorId, entity.requiredPermission))) {
    throw new DriverNotAvailableError("actor cannot run reports on this entity");
  }
  if (entity.featureKey && !(await reportEntityEnabled(orgId, entity.featureKey))) {
    throw new DriverNotAvailableError("the report entity's feature is disabled");
  }
  const subsidiaryIds = await actorAllowedSubsidiaryIds(db, orgId, actorId);
  const { query: contractedQuery, temporal } = applyTemporalContract(entity, plan, input);
  const startMonth = await fiscalStartMonth(orgId);
  const query = await resolvePeriodPresetLeaves(contractedQuery, async (presetId) => {
    const period = resolvePreset(presetId, { startMonth, today: input.to });
    if (!period) {
      throw new DriverAdminError(
        "validation",
        `preset '${presetId}' no longer resolves to a date range — choose a current period preset`,
      );
    }
    return period;
  });
  const compiled = compileCustomQuery(entity, query, orgId, {
    maxRows: MAX_REPORT_ROWS,
    fiscalStartMonth: startMonth,
    asOf: input.to,
    allowedSubsidiaryIds: subsidiaryIds === null ? null : [...subsidiaryIds],
    allowedBookIds: await resolveBookScope(orgId, query),
  });
  const { rows } = await pool.query(compiled.text, compiled.values);
  if (rows.length >= compiled.limit) {
    throw new DriverNotAvailableError(
      `report evidence reached the ${compiled.limit}-row query limit (driver_evidence_truncated); ` +
        `narrow the report so driver inputs are complete`,
      "config.reportDefinitionId",
    );
  }
  assertSingleDenomination(entity, compiled, rows, valueColumn);
  return { rows: projectDriverRows(rows, compiled, dimensionColumn, valueColumn), temporal };
}

/**
 * Enforce the driver's declared temporal contract on the validated plan and
 * describe what was enforced. `period_activity` binds the from..to window on
 * the report's date field (refusing when the report has none — an
 * unwindowed activity weight is exactly the silent mismatch finding 6.2
 * bans); `balance_as_of` keeps the historical snapshot-at-to behavior;
 * `fixed_query` runs the author's scope untouched.
 */
function applyTemporalContract(
  entity: (typeof REPORT_ENTITY_MAP)[string],
  plan: ReportCustomQuery,
  input: ReportDriverRunInput,
): { query: ReportCustomQuery; temporal: ReportDriverTemporal } {
  if (input.temporalMode === "period_activity") {
    const field = resolveReportPeriodField(entity, plan);
    if (!field) {
      throw new DriverNotAvailableError(
        "cannot bind a period_activity window: the report has no date field (driver_window_unbindeable)",
        "config.reportDefinitionId",
      );
    }
    return {
      query: applyReportPeriodWindow(plan, field, { from: input.from, to: input.to }),
      temporal: { mode: "period_activity", from: input.from, to: input.to, field },
    };
  }
  if (input.temporalMode === "fixed_query") {
    return { query: plan, temporal: { mode: "fixed_query", from: null, to: null, field: null } };
  }
  return { query: plan, temporal: { mode: "balance_as_of", from: null, to: input.to, field: null } };
}

/**
 * A driver weight must never add foreign money together. Mirrors the report
 * routes' grand-total guard: a sum over an observably mixed denomination
 * refuses instead of blending. Counts and non-money measures pass through.
 */
function assertSingleDenomination(
  entity: (typeof REPORT_ENTITY_MAP)[string],
  compiled: CompiledReportQuery,
  rows: Record<string, unknown>[],
  valueColumn: string,
): void {
  const measure: ReportMeasure = compiled.mode === "summarize"
    ? (compiled.measures.find((m) => m.column === valueColumn) ??
      (compiled.measures.length === 1 ? compiled.measures[0]! : { fn: "sum" as const, column: valueColumn }))
    : { fn: "sum" as const, column: valueColumn };
  if (measure.fn !== "sum") return;
  const singles = resolveDenominations(
    entity,
    compiled,
    compiled.hasDenominationCensus ? parseDenominationCounts(rows[0]) : {},
  );
  if (isTxnCurrencyMeasure(entity, measure) && !singles.txn) {
    throw new DriverAdminError("validation", "driver measure mixes transaction currencies");
  }
  if (isBaseMoneyMeasure(entity, measure) && !singles.base) {
    throw new DriverAdminError("validation", "driver measure mixes functional currencies");
  }
  if (isMoneyBlendingMeasure(entity, measure) && entity.bookScope && !singles.book) {
    throw new DriverAdminError("validation", "driver measure mixes accounting books");
  }
}

/** Book clamp mirrors the report routes: book-scoped entities default to the primary book. */
async function resolveBookScope(
  orgId: string,
  plan: ReportCustomQuery,
): Promise<readonly string[] | null> {
  const entity = REPORT_ENTITY_MAP[plan.entity];
  if (!entity?.bookScope) return null;
  if (customQueryReferencesBook(plan)) return null;
  const books = (await db.execute<{ id: string }>(sql`
    select id from accounting_books where org_id = ${orgId} and is_primary and is_active`)).rows;
  if (books.length !== 1 || !books[0]) {
    throw new DriverAdminError(
      "validation",
      "this report needs exactly one active primary accounting book",
    );
  }
  return [books[0].id];
}

async function fiscalStartMonth(orgId: string): Promise<number> {
  const r = (await db.execute<{ m: number }>(sql`
    select coalesce((settings->>'fiscalYearStartMonth')::int, 1) as m from orgs where id = ${orgId}`));
  const m = r.rows[0]?.m ?? 1;
  return m >= 1 && m <= 12 ? m : 1;
}

/**
 * The report routes' feature gate, resolved through the authoritative
 * registry (defaults, parent/dependency gates, data-dependent defaults) —
 * never a raw stored-true check, or the runner and the routes disagree
 * about which entities a driver may measure.
 */
async function reportEntityEnabled(orgId: string, key: string): Promise<boolean> {
  const r = (await db.execute<{ f: FeatureState | null }>(sql`
    select settings->'features' as f from orgs where id = ${orgId}`));
  const state = r.rows[0]?.f ?? {};
  if (key === "multiSubsidiary" || key === "multiCurrency") {
    return dataDependentFeatureDefault(db, orgId, key, state);
  }
  return featureEnabled(state, key);
}

/**
 * Project raw compiled rows onto [{dimension, value}]. Rows mode reads the
 * requested column keys; summarize mode reads d{i}/m{i} aliases resolved
 * through the plan's breakouts/measures (exact match, else the unambiguous
 * single candidate, else a loud refusal). Duplicate dimensions sum exactly;
 * null dimensions are meaningless and skipped, null measures count as zero.
 */
export function projectDriverRows(
  rows: Record<string, unknown>[],
  compiled: { mode: "rows" | "summarize"; columns: string[]; breakouts: { column: string }[]; measures: { column?: string }[] },
  dimensionColumn: string,
  valueColumn: string,
): ReportDriverRow[] {
  let dimKey: string;
  let valKey: string;
  if (compiled.mode === "summarize") {
    const dimCols = compiled.breakouts.map((b) => b.column);
    const valCols = compiled.measures.map((m, i) => m.column ?? `measure:${i}`);
    dimKey = `d${dimCols.indexOf(resolveSummarizeKey(dimCols, dimensionColumn, "dimension"))}`;
    valKey = `m${valCols.indexOf(resolveSummarizeKey(valCols, valueColumn, "value"))}`;
  } else {
    if (!compiled.columns.includes(dimensionColumn)) {
      throw new DriverAdminError("validation", `report does not select dimension column ${dimensionColumn}`);
    }
    if (!compiled.columns.includes(valueColumn)) {
      throw new DriverAdminError("validation", `report does not select value column ${valueColumn}`);
    }
    dimKey = dimensionColumn;
    valKey = valueColumn;
  }
  const totals = new Map<string, string>();
  for (const row of rows) {
    const dim = row[dimKey];
    if (dim === null || dim === undefined || dim === "") continue;
    const raw = row[valKey];
    const value = raw === null || raw === undefined ? "0.0000" : canonicalWeight(raw);
    totals.set(String(dim), totals.has(String(dim)) ? add(totals.get(String(dim))!, value) : value);
  }
  return [...totals].map(([dimension, value]) => ({ dimension, value }));
}

function resolveSummarizeKey(candidates: string[], wanted: string, role: string): string {
  if (candidates.includes(wanted)) return wanted;
  if (candidates.length === 1 && candidates[0] !== undefined) return candidates[0];
  throw new DriverAdminError("validation", `report has no unambiguous ${role} column ${wanted}`);
}

function canonicalWeight(raw: unknown): string {
  return normalizeDecimal(String(raw), 4);
}

/** The posting path's composed resolver: every source kind, report-backed included. */
export const postDriverResolver: DriverResolver = createDriverResolver({
  reportRunner: { runReport: runDriverReport } satisfies ReportDriverRunner,
});
