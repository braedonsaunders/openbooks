import { sql } from "drizzle-orm";
import { InventoryError, type Runner } from "./contracts.ts";

export interface ItemActiveMessages {
  /** Refusal suffix after the em dash; must name the remedy. */
  inactiveRemedy: string;
  /** Full error when a subject row is missing from this organization. */
  outsideOrganization: string;
}

/**
 * INV-ACTIVE fence shared by every movement-creating path (receipts, issues,
 * adjustments via delegation, transfers, assembly builds, purchase receipts,
 * sales fulfilment, stock-count posts).
 *
 * Locks each subject items row FOR SHARE and holds it through posting, then
 * refuses inactive items by name before any movement, layer, or journal
 * write. The item PATCH takes FOR UPDATE on the same row, so a deactivation
 * racing a posting serializes against it either way: the posting re-reads
 * the committed state (and refuses), or the deactivation waits for the
 * in-flight posting. Share locks stay compatible across concurrent postings.
 *
 * Controlled unwinds are deliberately NOT fenced: reverseInventoryMovement,
 * reverseAssemblyBuild, and the source-tied vendor/customer credit returns
 * restore exact prior state rather than minting new positions. Deactivation
 * must not strand history that can no longer be corrected — physical returns
 * still happen after an item is discontinued, and the books must record them.
 */
export async function assertItemsActive(
  tx: Runner,
  orgId: string,
  itemIds: string[],
  messages: ItemActiveMessages,
): Promise<Map<string, string>> {
  const ids = [...new Set(itemIds)].sort();
  const names = new Map<string, string>();
  if (ids.length === 0) return names;
  const rows = (await tx.execute<{
    id: string;
    name: string | null;
    is_active: boolean;
  }>(sql`
    select id, name, is_active
      from items
     where org_id = ${orgId}
       and id in (${sql.join(
         ids.map((itemId) => sql`${itemId}::uuid`),
         sql`, `,
       )})
     order by id
     for share`));
  // A write that matches zero rows is a failure, not a success: under RLS an
  // unscoped read resolves to nothing, so a short count refuses here rather
  // than posting against an item resolution cannot see.
  if (rows.rows.length !== ids.length) {
    throw new InventoryError(messages.outsideOrganization);
  }
  for (const row of rows.rows) names.set(row.id, row.name ?? row.id);
  for (const row of rows.rows) {
    if (!row.is_active) {
      throw new InventoryError(
        `${names.get(row.id)} is inactive — ${messages.inactiveRemedy}`,
      );
    }
  }
  return names;
}
