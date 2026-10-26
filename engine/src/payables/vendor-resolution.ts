import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";

/** Case-, accent- and punctuation-insensitive key used to compare vendor names and codes. */
export function vendorMatchKey(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Resolve a captured counterparty to exactly one active vendor party: a
 * unique tax-id match first, then a unique learned alias, then a unique
 * display- or legal-name match. Any ambiguity resolves to null so the
 * reviewer chooses; a near match is never bound.
 */
export async function resolveVendorParty(
  orgId: string,
  input: { name: string | null; taxId?: string | null },
): Promise<string | null> {
  if (input.taxId) {
    const taxKey = vendorMatchKey(input.taxId);
    const tax = await db.execute<{ id: string }>(
      sql`
      select distinct p.id
        from parties p
        join vendor_roles vr on vr.party_id = p.id and vr.org_id = p.org_id and vr.is_active
        cross join lateral jsonb_each_text(coalesce(p.tax_ids, '{}'::jsonb)) tax_id
       where p.org_id = ${orgId} and p.is_active
         and regexp_replace(lower(tax_id.value), '[^a-z0-9]', '', 'g') = ${taxKey}
       limit 2
    `,
      "objects",
    );
    if (tax.length === 1) return tax[0]!.id;
  }
  if (!input.name) return null;
  const alias = vendorMatchKey(input.name);
  if (!alias) return null;
  const learned = await db.execute<{ id: string | null }>(
    sql`
    select output->>'partyId' as id from ap_capture_rules
     where org_id = ${orgId} and rule_kind = 'vendor_alias' and is_active
       and match->>'alias' = ${alias}
     order by confirmation_count desc limit 2
  `,
    "objects",
  );
  if (learned.length === 1 && learned[0]!.id) return learned[0]!.id;
  const exact = await db.execute<{ id: string }>(
    sql`
    select p.id from parties p
    join vendor_roles vr on vr.party_id = p.id and vr.org_id = p.org_id and vr.is_active
    where p.org_id = ${orgId} and p.is_active
      and (
        regexp_replace(lower(p.display_name), '[^a-z0-9]', '', 'g') = ${alias}
        or regexp_replace(lower(coalesce(p.legal_name, '')), '[^a-z0-9]', '', 'g') = ${alias}
      )
    limit 2
  `,
    "objects",
  );
  return exact.length === 1 ? exact[0]!.id : null;
}
