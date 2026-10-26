import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { documentRevisionCounterSql } from "./revision.ts";

/**
 * Exact purchase-order revision token. Callers compare it as the optimistic
 * concurrency stamp on the next edit; a missing row means the draft is gone.
 */
export async function readPurchaseOrderRevisionToken(
  executor: SqlExecutor,
  orgId: string,
  documentId: string,
): Promise<string | undefined> {
  const rows = await executor.execute<{ updated_at: string }>(
    sql`
    select ${documentRevisionCounterSql(sql`revision_seq`)} as updated_at
      from documents where org_id=${orgId} and id=${documentId} and kind='purchase_order'
  `,
    "objects",
  );
  return rows[0]?.updated_at;
}
