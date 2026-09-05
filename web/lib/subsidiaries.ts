import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { db, withBypassContext } from "@openbooks/engine/src/db.ts";
import { actorAllowedSubsidiaryIds } from "@openbooks/engine/src/actor-subsidiaries.ts";
import { subsidiaryFeatureEnabled } from "./features";

/**
 * Web-side subsidiary helpers — the option tree for pickers, the
 * single-subsidiary check that hides all subsidiary UI, and the role-based
 * visibility filter (allowedSubsidiaryIds) every subsidiary-aware query
 * funnels through. Restriction is a visibility POLICY inside the tenant, not
 * a tenancy wall — RLS already pins the request to one org.
 */

export interface SubsidiaryOption {
  id: string;
  parentId: string | null;
  name: string;
  baseCurrency: string;
  country: string;
  isElimination: boolean;
  isActive: boolean;
  /** Root = 0; used for indented pickers. */
  depth: number;
}

/** The org's subsidiaries, depth-first so a flat list renders as a tree. */
export async function subsidiaryOptions(
  includeInactive = false,
  includeElimination = false,
): Promise<SubsidiaryOption[]> {
  const r = (await db.execute<Omit<SubsidiaryOption, "depth">>(sql`
    select id, parent_id as "parentId", name, base_currency as "baseCurrency",
           country, is_elimination as "isElimination", is_active as "isActive"
      from subsidiaries order by name`));
  const rows = r.rows.filter((s) => (includeInactive || s.isActive) && (includeElimination || !s.isElimination));
  const byParent = new Map<string | null, typeof rows>();
  for (const s of rows) {
    const list = byParent.get(s.parentId) ?? [];
    list.push(s);
    byParent.set(s.parentId, list);
  }
  const out: SubsidiaryOption[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const s of byParent.get(parentId) ?? []) {
      out.push({ ...s, depth });
      walk(s.id, depth + 1);
    }
  };
  walk(null, 0);
  // Orphans whose parent is filtered out (inactive) still render, at the end.
  for (const s of rows) if (!out.some((o) => o.id === s.id)) out.push({ ...s, depth: 1 });
  return out;
}

/** The feature flag is the sole gate for ALL subsidiary UI. */
export async function isMultiSubsidiary(orgId: string): Promise<boolean> {
  return subsidiaryFeatureEnabled(orgId);
}

/** Picker options that disappear completely while the feature is disabled. */
export async function subsidiaryUiOptions(
  orgId: string,
  includeInactive = false,
  includeElimination = false,
): Promise<SubsidiaryOption[]> {
  if (!(await subsidiaryFeatureEnabled(orgId))) return [];
  return subsidiaryOptions(includeInactive, includeElimination);
}

/** The org's root subsidiary id. */
export async function rootSubsidiaryId(): Promise<string> {
  const r = (await db.execute<{ id: string }>(sql`
    select id from subsidiaries where parent_id is null limit 1`));
  if (!r.rows[0]) throw new Error("org has no root subsidiary");
  return r.rows[0].id;
}

/** `subId`'s subtree (inclusive) over a preloaded option list. */
export function subtreeIds(all: Pick<SubsidiaryOption, "id" | "parentId">[], subId: string): Set<string> {
  const out = new Set([subId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const s of all) {
      if (s.parentId && out.has(s.parentId) && !out.has(s.id)) {
        out.add(s.id);
        grew = true;
      }
    }
  }
  return out;
}

/**
 * WHERE fragment narrowing a documents-table `column` to the caller's visible
 * subsidiaries — the fail-closed predicate shared by every ad-hoc query that
 * fans out over documents outside the canonical list builders (global search,
 * party sublists, payment-run lists). Unrestricted callers get an empty
 * fragment; an empty set denies everything (`and false`).
 */
export function subsidiaryVisibleFilter(column: SQL, allowed: ReadonlySet<string> | null): SQL {
  if (!allowed) return sql``;
  const ids = [...allowed];
  return ids.length
    ? sql` and ${column} = any(${`{${ids.join(',')}}`}::uuid[])`
    : sql` and false`;
}

/**
 * The subsidiaries this user may SEE, from the union of their roles'
 * restrictions (an unrestricted role or super-admin ⇒ null = everything).
 * A user without a role receives an empty set. Feed the result to list/report WHERE clauses:
 * `and subsidiary_id = any(...)` only when non-null.
 */
export async function allowedSubsidiaryIds(userId: string, orgId: string): Promise<Set<string> | null> {
  return withBypassContext(() => actorAllowedSubsidiaryIds(db, orgId, userId));
}
