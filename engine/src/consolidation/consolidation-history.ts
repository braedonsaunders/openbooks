import { sql } from "drizzle-orm";

/** Include controlled and generic reversal descendants once. The source link
 * belongs to the root generation, not necessarily to its correcting journal. */
export function consolidationHistory(orgId: string) {
  return sql`with recursive history(id,interest_id,subject_id,parent_id,buyer_id,seller_id) as (
 select e.id,c.interest_id,p.subsidiary_id,p.parent_subsidiary_id,null::uuid,null::uuid from ownership_consolidation_entries c join journal_entries e on e.org_id=c.org_id and e.id=c.journal_entry_id join subsidiary_ownership_interests p on p.org_id=c.org_id and p.id=c.interest_id where c.org_id=${orgId} and e.reverses_entry_id is null
 union all select e.id,null::uuid,null::uuid,null::uuid,b.buyer_subsidiary_id,b.seller_subsidiary_id from asset_transfer_consolidation_entries c join asset_transfer_bases b on b.org_id=c.org_id and b.id=c.transfer_id join journal_entries e on e.org_id=c.org_id and e.id=c.journal_entry_id where c.org_id=${orgId} and e.reverses_entry_id is null
 union all select e.id,h.interest_id,h.subject_id,h.parent_id,h.buyer_id,h.seller_id from journal_entries e join history h on e.reverses_entry_id=h.id where e.org_id=${orgId}
)`;
}
