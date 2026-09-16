import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "../db.ts";
import type { AllocationRunStatus, AllocationRunTrigger, RunComputation } from "./types.ts";

/**
 * Run + lineage READS for the Runs tab and the lineage drill (A8).
 *
 * A3 (`period-run.ts`) owns the run lifecycle (preview/post/reverse/rerun,
 * `listRuns`); until it lands, the Runs tab reads through this module, which
 * queries only the frozen 0160 schema. When A3 lands, routes rewire to its
 * `listRuns` and this module keeps the lineage-drill read plus the
 * subsidiary-visibility predicate (or is deleted — see the ledger).
 */

export type RunQueryCode = "validation" | "not_found";

export class RunQueryError extends Error {
  readonly code: RunQueryCode;
  readonly status: number;
  constructor(code: RunQueryCode, message: string) {
    super(message);
    this.name = "RunQueryError";
    this.code = code;
    this.status = code === "not_found" ? 404 : 400;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(code: RunQueryCode, message: string): never {
  throw new RunQueryError(code, message);
}

function asUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) fail("validation", `${field} must be a uuid`);
  return value as string;
}

export interface RunSummary {
  id: string;
  ruleId: string;
  ruleKey: string | null;
  ruleName: string | null;
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
  requestedBy: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string | null;
}

export interface RunDetail extends RunSummary {
  fingerprint: string | null;
  error: string | null;
  computation: RunComputation | Record<string, unknown>;
}

export interface ListRunsFilter {
  ruleId?: string;
  periodId?: string;
  bookId?: string;
  status?: AllocationRunStatus;
  subsidiaryId?: string;
  limit?: number;
  offset?: number;
  /** Null = unrestricted; otherwise only runs with a subsidiary in the set. */
  allowedSubsidiaryIds?: ReadonlySet<string> | null;
}

export interface LineageAnchorQuery {
  runId?: string;
  journalEntryId?: string;
  documentId?: string;
}

export interface LineageAnchor {
  kind: "run" | "journalEntry" | "document";
  id: string;
}

/** The drill anchors on exactly one object — never an unfiltered dump. */
export function validateLineageAnchor(query: LineageAnchorQuery): LineageAnchor {
  const present = (["runId", "journalEntryId", "documentId"] as const).filter((k) => query[k] !== undefined);
  if (present.length !== 1) fail("validation", "provide exactly one of runId, journalEntryId, documentId");
  const key = present[0]!;
  const id = asUuid(query[key], key);
  return { kind: key === "runId" ? "run" : key === "journalEntryId" ? "journalEntry" : "document", id };
}

/**
 * Subsidiary visibility for run rows. Org-wide runs (subsidiary null)
 * aggregate subsidiaries the caller may not see, so restricted callers see
 * only runs pinned to a subsidiary in their set.
 */
export function runSubsidiaryVisible(
  allowed: ReadonlySet<string> | null,
  subsidiaryId: string | null,
): boolean {
  if (allowed === null) return true;
  return subsidiaryId !== null && allowed.has(subsidiaryId);
}

export interface LineageRow {
  id: string;
  mode: string;
  ruleId: string;
  ruleKey: string | null;
  versionId: string;
  definitionHash: string;
  runId: string | null;
  documentId: string | null;
  journalEntryId: string | null;
  journalLineId: string | null;
  driverId: string | null;
  driverKey: string | null;
  driverValue: string | null;
  driverTotal: string | null;
  share: string | null;
  amount: string;
  residual: string;
}

function mapRun(row: Record<string, unknown>): RunSummary {
  return {
    id: String(row.id),
    ruleId: String(row.rule_id),
    ruleKey: (row.rule_key as string | null) ?? null,
    ruleName: (row.rule_name as string | null) ?? null,
    versionId: String(row.version_id),
    definitionHash: String(row.definition_hash),
    periodId: String(row.period_id),
    bookId: String(row.book_id),
    subsidiaryId: (row.subsidiary_id as string | null) ?? null,
    status: String(row.status) as AllocationRunStatus,
    triggerKind: String(row.trigger_kind) as AllocationRunTrigger,
    sourceTotal: String(row.source_total),
    allocatedTotal: String(row.allocated_total),
    residual: String(row.residual),
    journalEntryId: (row.journal_entry_id as string | null) ?? null,
    reversalEntryId: (row.reversal_entry_id as string | null) ?? null,
    requestedBy: (row.requested_by as string | null) ?? null,
    startedAt: row.started_at == null ? null : new Date(String(row.started_at)).toISOString(),
    completedAt: row.completed_at == null ? null : new Date(String(row.completed_at)).toISOString(),
    createdAt: row.created_at == null ? null : new Date(String(row.created_at)).toISOString(),
  };
}

const RUN_STATUSES: readonly string[] = ["previewed", "pending_approval", "posted", "reversed", "failed", "superseded"];

export async function listRuns(
  orgId: string,
  filter: ListRunsFilter = {},
  executor?: SqlExecutor,
): Promise<{ runs: RunSummary[]; total: number }> {
  const ex = executor ?? db;
  const limit = filter.limit === undefined ? 25 : filter.limit;
  const offset = filter.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail("validation", "limit must be 1..100");
  if (!Number.isInteger(offset) || offset < 0) fail("validation", "offset must be >= 0");
  const conds: ReturnType<typeof sql>[] = [sql`r.org_id = ${orgId}`];
  if (filter.ruleId !== undefined) conds.push(sql`r.rule_id = ${asUuid(filter.ruleId, "ruleId")}`);
  if (filter.periodId !== undefined) conds.push(sql`r.period_id = ${asUuid(filter.periodId, "periodId")}`);
  if (filter.bookId !== undefined) conds.push(sql`r.book_id = ${asUuid(filter.bookId, "bookId")}`);
  if (filter.subsidiaryId !== undefined) {
    conds.push(sql`r.subsidiary_id = ${asUuid(filter.subsidiaryId, "subsidiaryId")}`);
  }
  if (filter.status !== undefined) {
    if (!RUN_STATUSES.includes(filter.status)) fail("validation", `unknown status: ${filter.status}`);
    conds.push(sql`r.status = ${filter.status}`);
  }
  if (filter.allowedSubsidiaryIds !== undefined && filter.allowedSubsidiaryIds !== null) {
    const ids = [...filter.allowedSubsidiaryIds];
    if (ids.length === 0) return { runs: [], total: 0 };
    conds.push(sql`r.subsidiary_id = any(${`{${ids.join(",")}}`}::uuid[])`);
  }
  const where = sql.join(conds, sql` and `);
  const rows = await ex.execute<Record<string, unknown>>(sql`
    select r.*, rule.key as rule_key, rule.name as rule_name
      from allocation_runs r
      left join allocation_rules rule on rule.org_id = r.org_id and rule.id = r.rule_id
     where ${where}
     order by r.created_at desc
     limit ${limit} offset ${offset}`);
  const counted = await ex.execute<{ n: string }>(sql`
    select count(*) as n from allocation_runs r where ${where}`);
  return { runs: rows.rows.map(mapRun), total: Number(counted.rows[0]?.n ?? 0) };
}

export async function getRun(orgId: string, id: string, executor?: SqlExecutor): Promise<RunDetail> {
  const runId = asUuid(id, "run id");
  const ex = executor ?? db;
  const rows = await ex.execute<Record<string, unknown>>(sql`
    select r.*, rule.key as rule_key, rule.name as rule_name
      from allocation_runs r
      left join allocation_rules rule on rule.org_id = r.org_id and rule.id = r.rule_id
     where r.org_id = ${orgId} and r.id = ${runId}`);
  const row = rows.rows[0];
  if (!row) fail("not_found", "run not found");
  return {
    ...mapRun(row),
    fingerprint: (row.fingerprint as string | null) ?? null,
    error: (row.error as string | null) ?? null,
    computation: (row.computation as RunComputation | Record<string, unknown>) ?? {},
  };
}

export async function queryLineage(
  orgId: string,
  query: LineageAnchorQuery,
  opts?: { limit?: number; executor?: SqlExecutor },
): Promise<{ anchor: LineageAnchor; rows: LineageRow[] }> {
  const anchor = validateLineageAnchor(query);
  const limit = opts?.limit ?? 200;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) fail("validation", "limit must be 1..500");
  const ex = opts?.executor ?? db;
  const anchorCond =
    anchor.kind === "run"
      ? sql`l.run_id = ${anchor.id}`
      : anchor.kind === "journalEntry"
        ? sql`l.journal_entry_id = ${anchor.id}`
        : sql`l.document_id = ${anchor.id}`;
  const rows = await ex.execute<Record<string, unknown>>(sql`
    select l.*,
           rule.key as rule_key,
           driver.key as driver_key
      from allocation_lineage l
      left join allocation_rules rule on rule.org_id = l.org_id and rule.id = l.rule_id
      left join allocation_drivers driver on driver.org_id = l.org_id and driver.id = l.driver_id
     where l.org_id = ${orgId} and ${anchorCond}
     order by l.created_at, l.id
     limit ${limit}`);
  return {
    anchor,
    rows: rows.rows.map((row) => ({
      id: String(row.id),
      mode: String(row.mode),
      ruleId: String(row.rule_id),
      ruleKey: (row.rule_key as string | null) ?? null,
      versionId: String(row.version_id),
      definitionHash: String(row.definition_hash),
      runId: (row.run_id as string | null) ?? null,
      documentId: (row.document_id as string | null) ?? null,
      journalEntryId: (row.journal_entry_id as string | null) ?? null,
      journalLineId: (row.journal_line_id as string | null) ?? null,
      driverId: (row.driver_id as string | null) ?? null,
      driverKey: (row.driver_key as string | null) ?? null,
      driverValue: row.driver_value == null ? null : String(row.driver_value),
      driverTotal: row.driver_total == null ? null : String(row.driver_total),
      share: row.share == null ? null : String(row.share),
      amount: String(row.amount),
      residual: String(row.residual),
    })),
  };
}
