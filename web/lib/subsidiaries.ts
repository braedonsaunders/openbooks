import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import type { SubsidiaryRestriction } from "@openbooks/schema";

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
  const r = (await db.execute(sql`
    select id, parent_id as "parentId", name, base_currency as "baseCurrency",
           country, is_elimination as "isElimination", is_active as "isActive"
      from subsidiaries order by name`)) as unknown as {
    rows: Omit<SubsidiaryOption, "depth">[];
  };
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

/** True when the org runs more than one active subsidiary — gates ALL subsidiary UI. */
export async function isMultiSubsidiary(): Promise<boolean> {
  const r = (await db.execute(sql`
    select count(*)::int as n from subsidiaries where is_active and not is_elimination`)) as unknown as {
    rows: { n: number }[];
  };
  return (r.rows[0]?.n ?? 0) > 1;
}

/** The org's root subsidiary id. */
export async function rootSubsidiaryId(): Promise<string> {
  const r = (await db.execute(sql`
    select id from subsidiaries where parent_id is null limit 1`)) as unknown as {
    rows: { id: string }[];
  };
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
 * restrictions (an unrestricted role, no roles at all, or super-admin ⇒ null
 * = everything). Feed the result to list/report WHERE clauses:
 * `and subsidiary_id = any(...)` only when non-null.
 */
export async function allowedSubsidiaryIds(userId: string): Promise<Set<string> | null> {
  const r = (await db.execute(sql`
    select r.subsidiary_restriction as restriction
      from role_assignments a join app_roles r on r.id = a.role_id
     where a.user_id = ${userId}`)) as unknown as {
    rows: { restriction: SubsidiaryRestriction | null }[];
  };
  if (r.rows.length === 0) return null; // legacy-role fallback users see all
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
