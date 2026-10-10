import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { subsidiaryScopeAllows, subsidiaryVisibleFilter } from "./subsidiary-scope.ts";

export interface InternalPersonPin {
  id: string;
  subsidiaryId: string | null;
}

/**
 * Pin an internal person of the org: an active `person` party, or an
 * active `employee` party holding an active `employee_roles` row. A
 * `parties` row alone proves nothing — customers, vendors, and companies
 * all live there — so anyone outside those two shapes refuses, as does a
 * party from another org or an inactive one. Partners and owner-admins
 * serve as `person` parties without an employment; payroll admits only
 * employments, so their hours never reach a pay run. Reads fail closed
 * the same way — an inactive or unscoped party resolves to no pin rather
 * than to a neighboring org's row.
 */
export async function pinInternalPerson(
  runner: SqlExecutor,
  orgId: string,
  partyId: string,
  allowedSubsidiaryIds?: ReadonlySet<string> | null,
): Promise<InternalPersonPin | null> {
  const owned = (await runner.execute<{ id: string; subsidiary_id: string | null }>(sql`
    select id, subsidiary_id from parties
     where org_id = ${orgId} and id = ${partyId}
       and is_active
       and kind in ('person', 'employee')
       and (
         kind = 'person'
         or exists (
           select 1 from employee_roles r
            where r.org_id = parties.org_id
              and r.party_id = parties.id
              and r.is_active
         )
       )
     limit 1`));
  const row = owned.rows[0];
  if (!row) return null;
  // An employee party is a single-subsidiary record. A restricted caller
  // must not reach a person by guessing their UUID; null also fails closed
  // because it cannot be resolved to a legal entity here.
  if (
    allowedSubsidiaryIds !== undefined &&
    !subsidiaryScopeAllows(allowedSubsidiaryIds, row.subsidiary_id)
  ) {
    return null;
  }
  return { id: row.id, subsidiaryId: row.subsidiary_id };
}

export interface InternalPersonOption {
  id: string;
  display_name: string;
  subsidiary_id: string | null;
  kind: string;
}

/**
 * Picker options for project roles and any other surface that names an
 * internal person: every admissible party the caller may see, ordered for
 * display. The same predicate as the write pin, so a picker choice can
 * never be refused at save and a refused party never appears as a choice.
 */
export async function listInternalPersonOptions(
  runner: SqlExecutor,
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<InternalPersonOption[]> {
  const result = await runner.execute<InternalPersonOption>(sql`
    select p.id, p.display_name, p.subsidiary_id, p.kind
      from parties p
     where p.org_id = ${orgId}
       and p.is_active
       and p.kind in ('person', 'employee')
       and (
         p.kind = 'person'
         or exists (
           select 1 from employee_roles r
            where r.org_id = p.org_id
              and r.party_id = p.id
              and r.is_active
         )
       )
       ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, allowedSubsidiaryIds, { orgWideNull: true })}
     order by p.display_name, p.id
     limit 2000
  `);
  return result.rows;
}
