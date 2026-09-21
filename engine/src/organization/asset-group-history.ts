import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import type { GroupAssetValuation } from "../money/asset-group-plan.ts";
/** Ordered group workpapers. Corrected disposals disappear from the effective
 * history through their approved reversal, while their rows remain immutable. */
export async function assetGroupHistory(
  tx: SqlExecutor,
  orgId: string,
  transferId: string,
  cutoff: string,
): Promise<GroupAssetValuation[]> {
  const rows = await tx.execute<{ measurement: GroupAssetValuation }>(sql`
 select measurement from (
 select m.measurement,m.effective_on,m.created_at,m.ordinal,'valuation' as kind from asset_transfer_measurements m join asset_events v on v.org_id=m.org_id and v.id=m.source_event_id join journal_entries e on e.org_id=v.org_id and e.id=v.journal_entry_id where m.org_id=${orgId} and m.transfer_id=${transferId} and m.effective_on<=${cutoff} and e.status in('posted','reversed') and not exists(select 1 from asset_events r where r.org_id=v.org_id and r.reverses_event_id=v.id and r.occurred_on<=${cutoff})
 union all
 select x.group_component,x.effective_on,x.created_at,x.ordinal,'component' from asset_basis_changes x join asset_transfer_bases t on t.org_id=x.org_id and t.receiving_asset_id=x.asset_id and t.book_id=x.book_id where t.org_id=${orgId} and t.id=${transferId} and x.group_component is not null and x.effective_on<=${cutoff} and not exists(select 1 from financial_changes f where f.org_id=x.org_id and f.domain='asset' and f.operation='reversal' and f.payload->>'sourceChangeId'=x.change_id::text and f.status='applied' and f.effective_on<=${cutoff})
 ) evidence order by effective_on,created_at,kind,ordinal`);
  return rows.rows.map((r) => r.measurement);
}
