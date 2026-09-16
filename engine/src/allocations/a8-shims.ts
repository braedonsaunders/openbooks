import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "../db.ts";
import { div } from "../money.ts";
import type {
  AllocationDimension,
  AllocationRunTrigger,
  DriverVector,
  RunComputation,
} from "./types.ts";

/**
 * A8 shims for the not-yet-landed A3 period-run engine.
 *
 * Driver evaluation landed with A2 (`engine/src/allocations/drivers.ts`):
 * the preview route calls `previewDriverVector` directly and this module
 * keeps only the run-lifecycle seam plus the preview display helpers
 * (exact shares, dimension labels). DELETE the seam when A3's
 * `period-run.ts` lands; the helpers move with the UI that uses them.
 * PENDING items below throw typed `engine_pending` until A3 lands.
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

export interface PostRunInput {
  orgId: string;
  actorId: string;
  runId: string;
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
