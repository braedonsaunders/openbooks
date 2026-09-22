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

export type SubsidiaryTreeNode = {
  id: string;
  parentId: string | null;
};

/**
 * Only an explicit SQL null is legacy-all. An absent (undefined) or
 * malformed row never confers authority — without this, a missing field in
 * a mock or a corrupt row would read as unrestricted.
 */
function isUnrestrictedRestriction(row: SubsidiaryRestriction | null | undefined): boolean {
  if (row === null) return true;
  if (typeof row !== "object") return false;
  return row.mode === "all";
}

/** Canonical subtree expansion: the root plus every descendant. */
export function expandSubsidiarySubtree(
  subsidiaries: readonly SubsidiaryTreeNode[],
  rootId: string,
): Set<string> {
  const subtree = new Set([rootId.toLowerCase()]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of subsidiaries) {
      const id = row.id.toLowerCase();
      const parentId = row.parentId?.toLowerCase() ?? null;
      if (parentId && subtree.has(parentId) && !subtree.has(id)) {
        subtree.add(id);
        grew = true;
      }
    }
  }
  return subtree;
}

/**
 * Canonical resolution of one role restriction against a subsidiary tree.
 * Only an explicit null is legacy-all (exactly as the actor resolver treats
 * it); `{mode:"all"}` is unrestricted (null); list/subtree resolve to
 * explicit id sets. Undefined (absent/unknown) and any malformed shape
 * resolve to undefined so callers fail closed — never guessed, never
 * treated as unrestricted.
 */
export function restrictionSubsidiaryScope(
  restriction: SubsidiaryRestriction | null | undefined,
  subsidiaries: readonly SubsidiaryTreeNode[],
): Set<string> | null | undefined {
  if (restriction === null) return null;
  if (restriction === undefined) return undefined;
  if (restriction.mode === "all") return null;
  if (restriction.mode === "list") {
    if (!Array.isArray(restriction.subsidiaryIds)) return undefined;
    const ids: string[] = [];
    for (const id of restriction.subsidiaryIds) {
      if (typeof id !== "string") return undefined;
      ids.push(id.toLowerCase());
    }
    return new Set(ids);
  }
  if (restriction.mode === "subtree") {
    if (typeof restriction.subsidiaryId !== "string") return undefined;
    return expandSubsidiarySubtree(subsidiaries, restriction.subsidiaryId);
  }
  return undefined;
}

/**
 * Policy-aware scope a restriction edit ADDS beyond what the role already
 * grants. Narrowing (including all → finite) adds nothing. A list target is
 * a closed world, so the addition is the exact enumerated difference. A
 * subtree target is open-ended — future children are granted but not
 * enumerated — so any move to a subtree the previous policy does not
 * already cover (same root, or a root inside the previous subtree) adds an
 * unbounded set (null). Null is a sentinel for "open-ended": the caller
 * must judge the NEXT raw policy against actor coverage, and a covering
 * actor subtree grants it — not only a global admin. In particular list[A]
 * → subtree(A) is widening even when A is a leaf today.
 */
export function restrictionScopeAdditions(
  previous: SubsidiaryRestriction | null | undefined,
  next: SubsidiaryRestriction | undefined,
  subsidiaries: readonly SubsidiaryTreeNode[],
): Set<string> | null | undefined {
  if (previous === undefined || next === undefined) return undefined;
  if (next.mode === "all") {
    if (previous === null || previous.mode === "all") return new Set<string>();
    return null;
  }
  if (previous === null || previous.mode === "all") return new Set<string>();
  if (next.mode === "list") {
    if (!Array.isArray(next.subsidiaryIds)) return undefined;
    const before = restrictionSubsidiaryScope(previous, subsidiaries);
    if (before === undefined) return undefined;
    if (before === null) return new Set<string>();
    const added = new Set<string>();
    for (const id of next.subsidiaryIds) {
      if (typeof id !== "string") return undefined;
      const lower = id.toLowerCase();
      if (!before.has(lower)) added.add(lower);
    }
    return added;
  }
  if (next.mode === "subtree") {
    if (typeof next.subsidiaryId !== "string") return undefined;
    const root = next.subsidiaryId.toLowerCase();
    if (previous.mode === "subtree" && typeof previous.subsidiaryId === "string") {
      const prevRoot = previous.subsidiaryId.toLowerCase();
      if (prevRoot === root) return new Set<string>();
      if (expandSubsidiarySubtree(subsidiaries, prevRoot).has(root)) return new Set<string>();
    }
    return null;
  }
  return undefined;
}

export interface RestrictionEditScopes {
  previous: Set<string> | null | undefined;
  next: Set<string> | null | undefined;
  additions: Set<string> | null | undefined;
}

/**
 * Resolve both sides of a restriction edit plus the policy-aware addition
 * in one subsidiary-tree read, for use inside the caller's transaction.
 */
export async function resolveRestrictionEditScopes(
  exec: SqlExecutor,
  orgId: string,
  previous: SubsidiaryRestriction | null | undefined,
  next: SubsidiaryRestriction | undefined,
): Promise<RestrictionEditScopes> {
  const subsidiaries = await exec.execute<SubsidiaryTreeNode>(sql`
    select id, parent_id as "parentId" from subsidiaries where org_id = ${orgId}
  `);
  return {
    previous: restrictionSubsidiaryScope(previous, subsidiaries.rows),
    next: restrictionSubsidiaryScope(next, subsidiaries.rows),
    additions: restrictionScopeAdditions(previous, next, subsidiaries.rows),
  };
}

export interface RoleGrantPolicy {
  roleId: string;
  permissions: string[];
  restriction: SubsidiaryRestriction | null;
}

/**
 * One-shot load of everything a grant check needs in the caller's
 * transaction: the actor's RAW role restrictions plus the org's subsidiary
 * tree. Raw policies (not just the resolved lens set) are required because
 * a subtree grant is open-ended — future children are granted but never
 * enumerated — so only the actor's own policy portfolio can prove coverage
 * of that future.
 */
export interface SubsidiaryGrantCoverage {
  actorRestrictions: (SubsidiaryRestriction | null)[];
  subsidiaries: SubsidiaryTreeNode[];
}

export async function loadSubsidiaryGrantCoverage(
  exec: SqlExecutor,
  orgId: string,
  userId: string,
): Promise<SubsidiaryGrantCoverage> {
  const roles = await exec.execute<{ restriction: SubsidiaryRestriction | null }>(sql`
    select r.subsidiary_restriction as restriction
      from role_assignments a join app_roles r on r.id = a.role_id and r.org_id = a.org_id
     where a.user_id = ${userId} and a.org_id = ${orgId}
  `);
  const subsidiaries = await exec.execute<SubsidiaryTreeNode>(sql`
    select id, parent_id as "parentId" from subsidiaries where org_id = ${orgId}
  `);
  return { actorRestrictions: roles.rows.map((row) => row.restriction), subsidiaries: subsidiaries.rows };
}

/**
 * Whether a granted RAW restriction sits inside the actor's policy
 * portfolio. `all` (or legacy null) needs an all-row on the actor side — a
 * finite list covering every entity today is never equivalent. A list needs
 * every id inside the actor's enumerated union. A subtree needs actor `all`
 * or an actor subtree covering its root, because the grant's future
 * children are unbounded: a finite-list actor cannot grant an open-ended
 * subtree merely because today's enumeration matches, while a subtree admin
 * delegates freely within its own subtree.
 */
export function grantedRestrictionWithinCoverage(
  coverage: SubsidiaryGrantCoverage,
  granted: SubsidiaryRestriction | null | undefined,
): boolean {
  if (granted === undefined) return false;
  if (granted === null || granted.mode === "all") {
    return coverage.actorRestrictions.some(isUnrestrictedRestriction);
  }
  if (granted.mode === "list") {
    if (!Array.isArray(granted.subsidiaryIds)) return false;
    const ids = new Set<string>();
    for (const id of granted.subsidiaryIds) {
      if (typeof id !== "string") return false;
      ids.add(id.toLowerCase());
    }
    return subsidiaryScopeWithinCeiling(actorCoverageUnion(coverage), ids);
  }
  if (granted.mode === "subtree") {
    if (typeof granted.subsidiaryId !== "string") return false;
    const root = granted.subsidiaryId.toLowerCase();
    for (const row of coverage.actorRestrictions) {
      if (isUnrestrictedRestriction(row)) return true;
      // Absent or malformed actor rows contribute nothing and never crash
      // the check: typeof-guard before touching .mode.
      if (typeof row === "object" && row !== null && row.mode === "subtree" && typeof row.subsidiaryId === "string") {
        if (expandSubsidiarySubtree(coverage.subsidiaries, row.subsidiaryId).has(root)) return true;
      }
    }
    return false;
  }
  return false;
}

/**
 * Whether an already-resolved (enumerated) granted set sits inside the
 * actor's enumerated union. Used for exact list-target additions; unknown
 * on either side fails closed.
 */
export function grantedScopeSetWithinCoverage(
  coverage: SubsidiaryGrantCoverage,
  granted: ReadonlySet<string> | null | undefined,
): boolean {
  return subsidiaryScopeWithinCeiling(actorCoverageUnion(coverage), granted);
}

function actorCoverageUnion(coverage: SubsidiaryGrantCoverage): Set<string> | null | undefined {
  return unionSubsidiaryScopes(
    coverage.actorRestrictions.map((row) =>
      row === null ? null : restrictionSubsidiaryScope(row, coverage.subsidiaries),
    ),
  );
}

/**
 * Canonical grant-policy resolution for a set of stored roles: permissions
 * plus the raw restriction per role, read in the caller's executor so grant
 * checks inside a transaction see a consistent snapshot. Use this — never
 * actorAllowedSubsidiaryIds — for targets whose activation state would
 * corrupt the derivation (it returns empty for inactive identities).
 */
export async function resolveRoleGrantPolicies(
  exec: SqlExecutor,
  orgId: string,
  roleIds: readonly string[],
): Promise<RoleGrantPolicy[]> {
  if (roleIds.length === 0) return [];
  const rows = await exec.execute<{ id: string; permissions: unknown; restriction: SubsidiaryRestriction | null }>(sql`
    select id, permissions, subsidiary_restriction as restriction from app_roles
     where org_id = ${orgId} and id = any(${`{${[...roleIds].join(",")}}`}::uuid[])
  `);
  return rows.rows.map((row) => ({
    roleId: row.id,
    permissions: Array.isArray(row.permissions)
      ? row.permissions.filter((p): p is string => typeof p === "string")
      : [],
    restriction: row.restriction,
  }));
}

/**
 * Union already-resolved scopes. Unknown wins over unrestricted regardless
 * of order ([null, undefined] and [undefined, null] both resolve unknown):
 * an unresolvable member means the union cannot be proven inside any finite
 * ceiling, so callers fail closed. One unrestricted member with no unknown
 * makes the union unrestricted.
 */
export function unionSubsidiaryScopes(
  scopes: ReadonlyArray<ReadonlySet<string> | null | undefined>,
): Set<string> | null | undefined {
  const union = new Set<string>();
  let sawUnrestricted = false;
  let sawUnknown = false;
  for (const scope of scopes) {
    if (scope === null) sawUnrestricted = true;
    else if (scope === undefined) sawUnknown = true;
    else for (const id of scope) union.add(id);
  }
  if (sawUnknown) return undefined;
  if (sawUnrestricted) return null;
  return union;
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
  const restrictions = roles.rows.map(row => row.restriction);
  // Only a stored null is legacy-all, exactly as restrictionSubsidiaryScope
  // treats it; an absent field never confers unrestricted visibility.
  if (restrictions.some(isUnrestrictedRestriction)) return null;
  const subsidiaries = await exec.execute<SubsidiaryTreeNode>(sql`
    select id, parent_id as "parentId" from subsidiaries where org_id = ${orgId}
  `);
  const allowed = new Set<string>();
  for (const restriction of restrictions) {
    const scope = restrictionSubsidiaryScope(restriction, subsidiaries.rows);
    if (scope === undefined) continue;
    if (scope === null) return null;
    for (const id of scope) allowed.add(id);
  }
  return allowed;
}
