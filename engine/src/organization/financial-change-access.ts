import type { SqlExecutor } from "../platform/db.ts";
import { actorHasPermission } from "./actor-permissions.ts";
import { actorAllowedSubsidiaryIds } from "./actor-subsidiaries.ts";
import { lockAndCheckOrgFeature } from "./org-feature-lock.ts";

/** Recheck current actor, feature and legal-entity scope in the transaction
 * that writes an accounting lifecycle change, not only at the HTTP boundary. */
export async function assertFinancialChangeAccess(
  tx: SqlExecutor,
  args: {
    orgId: string;
    actorId: string;
    subsidiaryIds: string[];
    permission: string;
    feature: string;
  },
): Promise<void> {
  if (
    !args.actorId ||
    !(await actorHasPermission(tx, args.orgId, args.actorId, args.permission))
  )
    throw new Error(`this change requires ${args.permission}`);
  if (!(await lockAndCheckOrgFeature(tx, args.orgId, args.feature)))
    throw new Error(
      "enable the accounting capability on Company Settings → Features before changing this record",
    );
  const allowed = await actorAllowedSubsidiaryIds(tx, args.orgId, args.actorId);
  if (allowed && args.subsidiaryIds.some((id) => !allowed.has(id)))
    throw new Error(
      "this change includes a legal entity outside your authorization",
    );
}
