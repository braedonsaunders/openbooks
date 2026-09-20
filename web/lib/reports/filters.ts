import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { segmentRegistry } from "../segments";
import { resolveOrgId } from "../org-scope";

export interface DimFilter {
  departmentId?: string;
  projectId?: string;
  locationId?: string;
  classId?: string;
  /**
   * Subsidiary line filter (resolved ids: one leaf, or a consolidated subtree
   * plus its elimination subsidiaries). These single-currency queries
   * filter without FX translation — amounts stay in functional currency.
   */
  subsidiaryIds?: string[];
  /**
   * Server-set only (never parsed from URL input): the caller is
   * unrestricted AND the viewed entity set contains the org root, so
   * root-owned rows (null subsidiary) must read alongside attributed rows.
   * Restricted callers never receive it — their nulls fail closed.
   */
  includeNullSubsidiary?: boolean;
  segments?: Record<string, string>;
}

export function dimWhere(dims: DimFilter | undefined, alias = sql`l`) {
  let w = sql`true`;
  if (dims?.departmentId) w = sql`${w} and ${alias}.department_id = ${dims.departmentId}`;
  if (dims?.projectId) w = sql`${w} and ${alias}.project_id = ${dims.projectId}`;
  if (dims?.locationId) w = sql`${w} and ${alias}.location_id = ${dims.locationId}`;
  if (dims?.classId) w = sql`${w} and ${alias}.class_id = ${dims.classId}`;
  for (const [key, value] of Object.entries(dims?.segments ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    w = sql`${w} and ${alias}.extra_dims ->> ${key} = ${value}`;
  }
  if (dims?.subsidiaryIds) {
    // The null limb is unrestricted-only (see includeNullSubsidiary) and
    // never widens an empty scope: `= any('{}')` already matches nothing,
    // and an empty caller must read no rows — never the root-owned ones.
    if (dims.subsidiaryIds.length > 0 && dims.includeNullSubsidiary === true)
      w = sql`${w} and (${alias}.subsidiary_id is null or ${alias}.subsidiary_id = any(${`{${dims.subsidiaryIds.join(",")}}`}::uuid[]))`;
    else
      w = sql`${w} and ${alias}.subsidiary_id = any(${`{${dims.subsidiaryIds.join(",")}}`}::uuid[])`;
  }
  return w;
}

export async function dimensionOptions(orgId?: string, selectedProjectId?: string) {
  const resolvedOrgId = await resolveOrgId(orgId);
  const [depts, projects, locations, classes, registry] = await Promise.all([
    db.execute(sql`select id, name from departments where org_id = ${resolvedOrgId} and is_active order by name`),
    db.execute(sql`
      with listed as (
        select p.id, p.name
          from projects p
         where p.org_id = ${resolvedOrgId}
           and exists (select 1 from journal_lines l where l.org_id = ${resolvedOrgId} and l.project_id = p.id)
         order by p.name
         limit 500
      )
      select id, name from listed
      union
      select p.id, p.name
        from projects p
       where p.org_id = ${resolvedOrgId}
         and p.id = ${selectedProjectId ?? null}::uuid
      order by name`),
    db.execute(sql`select id, name from locations where org_id = ${resolvedOrgId} and is_active order by name`),
    db.execute(sql`select id, name from classes where org_id = ${resolvedOrgId} and is_active order by name`),
    segmentRegistry(resolvedOrgId),
  ]);
  return {
    departments: depts.rows as { id: string; name: string }[],
    projects: projects.rows as { id: string; name: string }[],
    locations: locations.rows as { id: string; name: string }[],
    classes: classes.rows as { id: string; name: string }[],
    segments: registry.filter((segment) => segment.sourceKind === 'custom'),
    builtinSegments: registry.filter((segment) => segment.sourceKind === 'builtin'),
  };
}
