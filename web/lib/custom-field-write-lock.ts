import "server-only";
import { lockCustomFieldKeys as lockKeys } from "@openbooks/engine/records/custom-field-write-lock";
import type { SqlExecutor } from "@openbooks/engine/platform/db";

/** App provenance reserves a table/key across kinds. All definition creators
 * share that namespace, acquiring bundle keys in one order to avoid deadlocks. */
export async function lockCustomFieldKeys(
  tx: SqlExecutor,
  orgId: string,
  fields: readonly { targetTable: string; key: string }[],
): Promise<void> {
  await lockKeys(tx, orgId, fields);
}
