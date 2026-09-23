import { sql } from "drizzle-orm";
import { InventoryError } from "./contracts.ts";
import type { Runner } from "./contracts.ts";

/**
 * Stock-count observation audit: every counted-quantity change and every
 * recount commits an immutable event on the house audit_log path,
 * atomically with the write it records. The lifecycle in stock-counts.ts
 * calls in here; the trail survives posting and reads per line
 * (table_name 'stock_count_lines', row_id the line id). No new table:
 * actor and time ride the row, before/after/reason ride the changes
 * document.
 */

export interface CountedChangeImage {
  countedQuantity: string | null;
  expectedQuantity: string;
}

/**
 * Append one immutable observation-audit row for a counted-quantity change.
 * Corrections and recounts always carry a reason — supplied, or the factual
 * default resolved by countedChangeReason.
 */
export async function auditCountedChange(
  tx: Runner,
  orgId: string,
  actorId: string | null,
  input: {
    lineId: string;
    countId: string;
    operation: "record" | "recount";
    reason: string | null;
    before: CountedChangeImage;
    after: CountedChangeImage;
  },
): Promise<void> {
  const written = (await tx.execute<{ id: string }>(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'stock_count_lines', ${input.lineId}, 'update',
            ${JSON.stringify({
              operation: input.operation,
              countId: input.countId,
              reason: input.reason,
              before: input.before,
              after: input.after,
            })}::jsonb,
            ${actorId})
    returning id`));
  if (written.rows.length === 0) {
    throw new InventoryError("count observation was not audited — reload the count and try again");
  }
}

/** An explicit reason, or the fallback (null for first records, the factual default for corrections and recounts). */
export function countedChangeReason(explicit: string | null | undefined, fallback: string | null): string | null {
  if (explicit !== undefined && explicit !== null && explicit.trim() !== "") {
    if (explicit.trim().length > 500) {
      throw new InventoryError("count observation reason must be at most 500 characters");
    }
    return explicit.trim();
  }
  return fallback;
}
