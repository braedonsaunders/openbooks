import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";

/** Ownership and source classification for an inventory reversal target. */
export async function inventoryMovementReversalScope(
  orgId: string,
  movementId: string,
): Promise<{ subsidiary_id: string | null; kind: string | null; origin: string | null } | null> {
  const rows = await db.execute<{
    subsidiary_id: string | null;
    kind: string | null;
    origin: string | null;
  }>(
    sql`
      select movement.subsidiary_id, movement.kind, entry.origin
        from inventory_movements movement
        left join journal_entries entry
          on entry.org_id = movement.org_id and entry.id = movement.journal_entry_id
       where movement.id = ${movementId} and movement.org_id = ${orgId}
    `,
    "objects",
  );
  return rows[0] ?? null;
}
