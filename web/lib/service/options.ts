import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { subsidiaryVisibleFilter } from "../subsidiaries";
import type { Authz } from "../authz";

export type ServiceOption = { value: string; label: string; hint?: string };

const pattern = (query: string) => `%${query.trim()}%`;

/** Active customers in the caller's legal entities, searched by name. */
export async function customerOptions(authz: Authz, query: string): Promise<ServiceOption[]> {
  return await db.execute<ServiceOption>(
    sql`select p.id as value, p.display_name as label, nullif(btrim(p.email), '') as hint
      from parties p join customer_roles c on c.org_id = p.org_id and c.party_id = p.id and c.is_active
     where p.org_id = ${authz.user.orgId} and p.is_active
       ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, authz.allowedSubsidiaryIds, { orgWideNull: true })}
       and (${query.trim()} = '' or p.display_name ilike ${pattern(query)})
     order by p.display_name, p.id limit 50`,
    "objects",
  );
}

export interface CustomerSites {
  readonly addresses: readonly ServiceOption[];
  readonly contacts: readonly ServiceOption[];
}

/** A customer's addresses and active contacts, for the service location and the person to call. */
export async function customerSites(authz: Authz, customerPartyId: string): Promise<CustomerSites> {
  const orgId = authz.user.orgId;
  const visible = (
    await db.execute(
      sql`select 1 from parties p where p.org_id = ${orgId} and p.id = ${customerPartyId}
    ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, authz.allowedSubsidiaryIds, { orgWideNull: true })}`,
      "objects",
    )
  )[0];
  if (!visible) return { addresses: [], contacts: [] };
  const [addresses, contacts] = await Promise.all([
    db.execute<ServiceOption>(
      sql`select a.id as value,
        coalesce(nullif(btrim(a.label), ''), nullif(concat_ws(', ', a.line1, a.city), ''), '—') as label,
        nullif(concat_ws(', ', a.line1, a.line2, a.city, a.region, a.postal_code), '') as hint
      from addresses a where a.org_id = ${orgId} and a.party_id = ${customerPartyId}
      order by a.is_default_shipping desc, a.label nulls last, a.id`,
      "objects",
    ),
    db.execute<ServiceOption>(
      sql`select c.id as value, c.name as label,
        nullif(concat_ws(' · ', nullif(btrim(c.email), ''), nullif(btrim(coalesce(c.mobile_phone, c.phone)), '')), '') as hint
      from contacts c where c.org_id = ${orgId} and c.party_id = ${customerPartyId} and c.is_active
      order by c.is_primary desc, c.name, c.id`,
      "objects",
    ),
  ]);
  return { addresses, contacts };
}

/** Active qualification types a visit may require. */
export async function qualificationOptions(orgId: string): Promise<ServiceOption[]> {
  return await db.execute<ServiceOption>(
    sql`select id as value, name as label, code as hint from hrm_qualification_types
     where org_id = ${orgId} and is_active order by name, id`,
    "objects",
  );
}

/** Active items for scope lines and labor, searched by code or name. */
export async function itemOptions(orgId: string, query: string): Promise<ServiceOption[]> {
  return await db.execute<ServiceOption>(
    sql`select id as value, case when nullif(code, '') is null then name else code || ' — ' || name end as label, kind as hint
      from items where org_id = ${orgId} and is_active and kind not in ('discount', 'gift_card', 'absence')
       and (${query.trim()} = '' or name ilike ${pattern(query)} or coalesce(code, '') ilike ${pattern(query)})
     order by name, id limit 50`,
    "objects",
  );
}
