import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";

export interface PartyTaxIdRecord {
  id: string;
  scheme: string;
  value: string;
  status: string;
  checkedAt: string | null;
  consultationNumber: string | null;
  revalidateAfter: string | null;
}

/** List active tax IDs for a party without crossing the organization boundary. */
export async function listPartyTaxIds(
  db: SqlExecutor,
  orgId: string,
  partyId: string,
): Promise<PartyTaxIdRecord[]> {
  return db.execute<PartyTaxIdRecord>(
    sql`
      select id, scheme, value, status, checked_at::text as "checkedAt",
             consultation_number as "consultationNumber", revalidate_after::text as "revalidateAfter"
        from party_tax_ids
       where org_id = ${orgId} and party_id = ${partyId} and is_active
       order by created_at desc`,
    "objects",
  );
}
