import { sql } from "drizzle-orm";
import type { SubsidiaryRestriction } from "@openbooks/schema";
import type { SqlExecutor } from "../platform/db.ts";
import { actorIdentity } from "./actor-permissions.ts";

/**
 * Pure delegation-ceiling comparison over already-resolved subsidiary sets.
 *
 * Explicit null means unrestricted: only a null (unrestricted) ceiling can
 * grant it. A finite list — even one that happens to cover every entity in
 * the org today — is never equivalent to all, because a future entity would
 * fall outside the list but inside `all`. An empty set grants nothing, so it fits any known ceiling.
 * Unknown (undefined) on either side fails closed: it can never be treated
 * as unrestricted.
 */
export function subsidiaryScopeWithinCeiling(
  ceiling: ReadonlySet<string> | null | undefined,
  granted: ReadonlySet<string> | null | undefined,
): boolean {
  if (granted === null) return ceiling === null;
  if (granted === undefined) return false;
  if (ceiling === undefined) return false;
  if (ceiling === null) return true;
  for (const id of granted) {
    if (!ceiling.has(id)) return false;
  }
  return true;
}
/** Shared role visibility policy for HTTP and engine entry points. Identity is resolved
 * across home organizations; role and entity reads retain the caller transaction. */
export async function actorAllowedSubsidiaryIds(
  exec: SqlExecutor, orgId: string, userId: string,
): Promise<Set<string> | null> {
  if (!orgId) throw new Error("Subsidiary authorization requires an organization");
  const user = await actorIdentity(exec, orgId, userId);
  if (!user?.isActive) return new Set();
  if (user.isSuperAdmin) return null;
  const roles = await exec.execute<{ restriction: SubsidiaryRestriction | null }>(sql`
    select r.subsidiary_restriction as restriction
      from role_assignments a join app_roles r on r.id = a.role_id and r.org_id = a.org_id
     where a.user_id = ${userId} and a.org_id = ${orgId}
  `);
  const restrictions = roles.rows.map(row => row.restriction ?? { mode: "all" as const });
  if (restrictions.some(row => row.mode === "all")) return null;
  const subsidiaries = await exec.execute<{ id: string; parentId: string | null }>(sql`
    select id, parent_id as "parentId" from subsidiaries where org_id = ${orgId}
  `);
  const allowed = new Set<string>();
  for (const restriction of restrictions) {
    if (restriction.mode === "list") for (const id of restriction.subsidiaryIds) allowed.add(id);
    if (restriction.mode === "subtree") {
      const subtree = new Set([restriction.subsidiaryId]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const row of subsidiaries.rows) {
          if (row.parentId && subtree.has(row.parentId) && !subtree.has(row.id)) {
            subtree.add(row.id);
            grew = true;
          }
        }
      }
      for (const id of subtree) allowed.add(id);
    }
  }
  return allowed;
}
