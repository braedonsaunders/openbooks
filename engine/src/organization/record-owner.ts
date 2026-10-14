import { sql, type SQL } from "drizzle-orm";

/**
 * The legal entity that owns a record carrying an optional subsidiary: its
 * own subsidiary when set, otherwise the organization's unique active,
 * non-elimination root. Records created where subsidiaries are not in use
 * carry no subsidiary and belong to that root; with several roots an
 * unassigned record has no owner and the expression is null.
 */
export function recordOwnerSubsidiary(orgId: string, subsidiaryColumn: SQL): SQL {
  return sql`coalesce(${subsidiaryColumn}, (
    select root.id from subsidiaries root
     where root.org_id = ${orgId} and root.is_active and not root.is_elimination and root.parent_id is null
       and not exists (
         select 1 from subsidiaries other
          where other.org_id = root.org_id and other.is_active and not other.is_elimination
            and other.parent_id is null and other.id <> root.id)))`;
}
