import "server-only";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "@openbooks/engine/src/db.ts";
import type { SubsidiaryRestriction } from "@openbooks/schema";
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
 * The subsidiaries this user may SEE, from the union of their roles'
 * restrictions (an unrestricted role or super-admin ⇒ null = everything).
 * A user without a role receives an empty set. Feed the result to list/report WHERE clauses:
 * `and subsidiary_id = any(...)` only when non-null.
 */
export async function allowedSubsidiaryIds(userId: string): Promise<Set<string> | null> {
  // Identity-layer lookup: the user's assignments and super-admin flag live in
  // their HOME org, which is invisible under another org's RLS context when a
  // member is acting cross-org (org switch). Read them with the identity
  // bypass, exactly like the auth bootstrap — otherwise a cross-org actor
  // resolves an empty set and every list filters to nothing.
  const identity = await withBypassContext(async () => {
    const su = (await db.execute<{ is_super_admin: boolean }>(sql`
      select is_super_admin from users where id = ${userId}`));
    const assignments = (await db.execute<{ restriction: SubsidiaryRestriction | null }>(sql`
      select r.subsidiary_restriction as restriction
        from role_assignments a join app_roles r on r.id = a.role_id and r.org_id = a.org_id
       where a.user_id = ${userId}`));
    return { superAdmin: su.rows[0]?.is_super_admin === true, rows: assignments.rows as { restriction: SubsidiaryRestriction | null }[] };
  });
  if (identity.superAdmin) return null;
  const r = identity;
  if (r.rows.length === 0) return new Set();
  const restrictions = r.rows.map((row) => row.restriction ?? { mode: "all" as const });
  if (restrictions.some((x) => x.mode === "all")) return null;

  const all = await subsidiaryOptions(true, true);
  const allowed = new Set<string>();
  for (const x of restrictions) {
    if (x.mode === "subtree") for (const id of subtreeIds(all, x.subsidiaryId)) allowed.add(id);
    if (x.mode === "list") for (const id of x.subsidiaryIds) allowed.add(id);
  }
  return allowed;
}
