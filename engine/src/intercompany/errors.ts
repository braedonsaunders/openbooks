import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { actorHasPermission } from "../organization/actor-permissions.ts";

/**
 * A refusal from the intercompany services. `status` is the HTTP answer an
 * API boundary gives: 404 for a record that is missing, in another
 * organization or outside the caller's subsidiary scope (indistinguishable
 * on purpose), 409 for a concurrent change or a conflicting open run, 422
 * for every business refusal. `details` carries structured evidence the
 * operator can act on (for example every missing exchange rate at once).
 */
export class IntercompanyError extends Error {
  override readonly name = "IntercompanyError";

  constructor(
    message: string,
    readonly status: 403 | 404 | 409 | 422 = 422,
    readonly details?: Record<string, unknown>,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
  }
}

/** Commands resolve live authority even when invoked outside an HTTP route. */
export async function requireIntercompanyPermission(
  runner: SqlExecutor,
  orgId: string,
  actorId: string,
  permission: "intercompany.manage" | "intercompany.settle" | "intercompany.approve",
): Promise<void> {
  if (!(await actorHasPermission(runner, orgId, actorId, permission))) {
    throw new IntercompanyError(`permission required: ${permission}`, 403);
  }
}

export const INTERCOMPANY_TRANSACTIONS_DISABLED =
  "Intercompany transactions is turned off; turn it on in Company Settings → Features";
export const INTERCOMPANY_NETTING_DISABLED =
  "Intercompany netting is turned off; turn it on in Company Settings → Features";
export const CROSS_SUBSIDIARY_FULFILLMENT_DISABLED =
  "Cross-subsidiary fulfillment is turned off; turn it on in Company Settings → Features";

/** Audit evidence for an intercompany command, written in the caller's transaction. */
export async function auditIntercompany(
  runner: SqlExecutor,
  entry: {
    orgId: string;
    table: string;
    rowId: string;
    action: "insert" | "update";
    actorId: string | null;
    changes: Record<string, unknown>;
  },
): Promise<void> {
  const written = (
    await runner.execute<{ id: string }>(
      sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${entry.orgId}, ${entry.table}, ${entry.rowId}, ${entry.action},
            ${JSON.stringify(entry.changes)}::jsonb, ${entry.actorId})
    returning id`,
      "objects",
    )
  )[0];
  if (!written) throw new IntercompanyError("the audit record could not be written", 409);
}

/** Exactly one row changed, or the command refuses as a concurrent change. */
export function requireOneRow(rows: readonly unknown[], refusal: string): void {
  if (rows.length !== 1) throw new IntercompanyError(refusal, 409);
}
