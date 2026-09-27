import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { ManufacturingError, ManufacturingNotFoundError } from "./errors.ts";

const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/;

export function decimalValue(value: unknown, field: string, remedy: string): string {
  if (typeof value !== "string" || !DECIMAL.test(value)) {
    throw new ManufacturingError(`${field} must be an exact decimal with at most four decimal places.`, {
      code: "invalid_decimal", field, remedy,
    });
  }
  return value;
}

export function compareDecimal(left: string, right: string): number {
  const units = (value: string) => {
    const [whole, fraction = ""] = value.split(".");
    return BigInt(whole!) * 10_000n + BigInt(fraction.padEnd(4, "0"));
  };
  const a = units(left);
  const b = units(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

export function isoDate(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ManufacturingError(`${field} must be a calendar date in YYYY-MM-DD format.`, {
      code: "invalid_date", field, remedy: "Enter a valid calendar date in YYYY-MM-DD format.",
    });
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) {
    throw new ManufacturingError(`${field} must be a valid calendar date.`, {
      code: "invalid_date", field, remedy: "Enter a valid calendar date in YYYY-MM-DD format.",
    });
  }
  return value;
}

export function refused(message: string, code: string, field?: string, remedy?: string): never {
  throw new ManufacturingError(message, { code, field, remedy });
}

export async function auditChange(
  tx: SqlExecutor,
  input: { orgId: string; actorId: string; table: string; rowId: string; action: "insert" | "update" | "delete"; before: unknown; after: unknown; requestId?: string; match?: Record<string, unknown> },
): Promise<void> {
  const changes = { before: input.before, after: input.after, ...(input.match ? { match: input.match } : {}) };
  const result = await tx.execute<{ id: string }>(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
    values (${input.orgId}, ${input.table}, ${input.rowId}, ${input.action},
      ${JSON.stringify(changes)}::jsonb, ${input.actorId}, ${input.requestId ?? null})
    returning id`);
  if (result.rows.length !== 1) {
    throw new ManufacturingError("The manufacturing change could not be recorded in the audit history.", {
      code: "audit_write_failed", remedy: "Retry the change; contact an administrator if it continues.",
    });
  }
}

export function notFound(): never {
  throw new ManufacturingNotFoundError();
}

export function storageCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}
