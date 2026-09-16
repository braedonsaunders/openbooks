import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "../db.ts";
import { div } from "../money.ts";
import { getDriver } from "./driver-admin.ts";
import type {
  AllocationDimension,
  AllocationRunTrigger,
  DriverAsOf,
  DriverResolveRequest,
  DriverResolver,
  DriverVector,
  RunComputation,
} from "./types.ts";

/**
 * A8 shims for the not-yet-landed A2 (drivers) and A3 (period-run) engines.
 *
 * DELETE THIS FILE when A2/A3 land: routes rewire to `resolveDriverVector`
 * (`engine/src/allocations/drivers.ts`) and `preview/post/reverse/rerunAllocationRun`
 * (`engine/src/allocations/period-run.ts`), and these tests move to their
 * suites. Every item below is marked REAL (works against the frozen schema)
 * or PENDING (typed `engine_pending` until the owning shard lands).
 *
 *   REAL: manual-kind driver preview vector (+ shares + dimension labels).
 *   PENDING: every other source_kind; the full run lifecycle.
 */

export const ENGINE_PENDING = "engine_pending";

export class EnginePendingError extends Error {
  readonly code = ENGINE_PENDING;
  /** Shard that owns the real implementation (A2 drivers, A3 period runs). */
  readonly ownerShard: string;
  constructor(ownerShard: string, message: string) {
    super(message);
    this.name = "EnginePendingError";
    this.ownerShard = ownerShard;
  }
}

/** Exact display shares (4dp, bigint math) for a preview vector. Zero-safe. */
export function vectorShares(vector: DriverVector): Map<string, string> {
  const shares = new Map<string, string>();
  if (vector.size === 0) return shares;
  let total = "0";
  for (const value of vector.values()) {
    const [whole = "0", fraction = ""] = value.split(".");
    total = addDecimal(total, `${whole}.${(fraction + "0000").slice(0, 4)}`);
  }
  for (const [key, value] of vector) {
    shares.set(key, total === "0.0000" ? "0.0000" : div(value, total));
  }
  return shares;
}

function addDecimal(a: string, b: string): string {
  const parse = (s: string) => {
    const [whole = "0", fraction = ""] = s.split(".");
    return BigInt(whole) * 10000n + BigInt((fraction + "0000").slice(0, 4).padEnd(4, "0"));
  };
  const sum = parse(a) + parse(b);
  const negative = sum < 0n;
  const abs = negative ? -sum : sum;
  return `${negative ? "-" : ""}${abs / 10000n}.${String(abs % 10000n).padStart(4, "0")}`;
}

async function asOfDate(orgId: string, asOf: DriverAsOf, executor: SqlExecutor): Promise<string> {
  if ("date" in asOf) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf.date)) throw new EnginePendingError("A8", `bad as-of date: ${asOf.date}`);
    return asOf.date;
  }
  const rows = await executor.execute<{ ends_on: string }>(sql`
    select ends_on::text as ends_on from accounting_periods
     where org_id = ${orgId} and id = ${asOf.periodId}`);
  const end = rows.rows[0]?.ends_on?.slice(0, 10);
  if (!end) throw new EnginePendingError("A8", "period not found for driver preview");
  return end;
}

/**
 * REAL: resolve a manual-kind driver to its effective-dated values.
 * Any other source_kind throws EnginePendingError (A2 owns those resolvers).
 */
export async function previewManualDriverVector(
  orgId: string,
  driverId: string,
  asOf: DriverAsOf,
  opts?: { include?: string[]; exclude?: string[]; executor?: SqlExecutor },
): Promise<{ vector: DriverVector; date: string }> {
  const ex = opts?.executor ?? db;
  const driver = await getDriver(orgId, driverId, ex);
  if (!driver) throw new EnginePendingError("A8", "driver not found");
  if (driver.sourceKind !== "manual") {
    throw new EnginePendingError("A2", `driver preview for ${driver.sourceKind} lands with A2 (drivers.ts)`);
  }
  const date = await asOfDate(orgId, asOf, ex);
  const include = opts?.include;
  const exclude = new Set(opts?.exclude ?? []);
  const rows = await ex.execute<{ dimension_value_id: string; value: string }>(sql`
    select dimension_value_id::text as dimension_value_id, value::text as value
      from allocation_driver_values
     where org_id = ${orgId} and driver_id = ${driverId}
       and effective_from <= ${date}
       and (effective_to is null or effective_to >= ${date})`);
  const vector: DriverVector = new Map();
  for (const row of rows.rows) {
    if (include !== undefined && !include.includes(row.dimension_value_id)) continue;
    if (exclude.has(row.dimension_value_id)) continue;
    vector.set(row.dimension_value_id, row.value);
  }
  return { vector, date };
}

/** REAL: human labels for dimension values in a preview table. */
export async function getDimensionValueLabels(
  orgId: string,
  dimension: AllocationDimension,
  ids: string[],
  executor?: SqlExecutor,
): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  if (ids.length === 0) return labels;
  const table =
    dimension === "department" ? "departments"
    : dimension === "location" ? "locations"
    : dimension === "class" ? "classes"
    : dimension === "project" ? "projects"
    : dimension === "subsidiary" ? "subsidiaries"
    : null;
  // Custom segments have no fixed label table: the caller falls back to ids.
  if (!table) return labels;
  const ex = executor ?? db;
  const rows = await ex.execute<{ id: string; name: string }>(sql`
    select id::text as id, name from ${sql.raw(table)}
     where org_id = ${orgId} and id = any(${`{${ids.join(",")}}`}::uuid[])`);
  for (const row of rows.rows) labels.set(row.id, row.name);
  return labels;
}

/**
 * PENDING until A3: the run-lifecycle surface the Runs tab calls, shaped
 * exactly like the design §3 `period-run.ts` contract. The default binding
 * throws EnginePendingError; tests inject fakes via setPeriodRunEngine.
 */
export interface PreviewRunInput {
  orgId: string;
  actorId: string;
  ruleId: string;
  periodId: string;
  bookId: string;
  subsidiaryId?: string | null;
  triggerKind?: AllocationRunTrigger;
}

export interface PostRunInput extends PreviewRunInput {
  reason: string;
}

export interface ReverseRunInput {
  orgId: string;
  actorId: string;
  runId: string;
  reason: string;
}

export interface RerunInput {
  orgId: string;
  actorId: string;
  runId: string;
}

export interface PeriodRunEngine {
  preview(input: PreviewRunInput): Promise<RunComputation>;
  post(input: PostRunInput): Promise<{ runId: string; journalEntryId: string | null }>;
  reverse(input: ReverseRunInput): Promise<{ reversalEntryId: string | null }>;
  rerun(input: RerunInput): Promise<{ runId: string }>;
}

const pending = (owner: string, what: string): never => {
  throw new EnginePendingError(owner, `${what} lands with ${owner} (period-run.ts)`);
};

export const pendingPeriodRunEngine: PeriodRunEngine = {
  preview: async () => pending("A3", "previewAllocationRun"),
  post: async () => pending("A3", "postAllocationRun"),
  reverse: async () => pending("A3", "reverseAllocationRun"),
  rerun: async () => pending("A3", "rerunAllocationRun"),
};

let activePeriodRunEngine: PeriodRunEngine = pendingPeriodRunEngine;

/** Seam for routes (default) and tests (fakes). Deleted with this file. */
export function getPeriodRunEngine(): PeriodRunEngine {
  return activePeriodRunEngine;
}

export function setPeriodRunEngine(engine: PeriodRunEngine): void {
  activePeriodRunEngine = engine;
}

/**
 * PENDING until A2: a DriverResolver over the shim. Manual drivers resolve
 * for real; every other kind throws EnginePendingError.
 */
export const shimDriverResolver: DriverResolver = {
  async resolve(request: DriverResolveRequest): Promise<DriverVector> {
    if (request.driver.sourceKind !== "manual") {
      throw new EnginePendingError("A2", `driver preview for ${request.driver.sourceKind} lands with A2 (drivers.ts)`);
    }
    const { vector } = await previewManualDriverVector(request.orgId, request.driver.id, request.asOf, {
      include: request.include,
      exclude: request.exclude,
    });
    return vector;
  },
};
