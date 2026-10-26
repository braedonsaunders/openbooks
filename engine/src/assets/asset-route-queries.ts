import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";

function subsidiaryFence(allowedSubsidiaryIds: ReadonlySet<string> | null) {
  return allowedSubsidiaryIds
    ? sql`and asset.subsidiary_id = any(${`{${[...allowedSubsidiaryIds].join(",")}}`}::uuid[])`
    : sql``;
}

export async function listAssetGroupValuationRouteRows(orgId: string, assetId: string) {
  return db.execute<{
    id: string;
    date: string;
    kind: string;
    amount: string;
    book_name: string;
    group_currency: string;
    subsidiary_id: string;
    elimination_subsidiary_id: string;
    recorded: boolean;
  }>(
    sql`
      select v.id,v.occurred_on::text as date,v.kind,v.amount::text,b.name as book_name,
             t.group_currency,a.subsidiary_id,t.elimination_subsidiary_id,
             exists(select 1 from asset_transfer_measurements m where m.org_id=v.org_id and m.source_event_id=v.id) as recorded
        from fixed_assets a
        join asset_events v on v.org_id=a.org_id and v.asset_id=a.id
        join journal_entries e on e.org_id=v.org_id and e.id=v.journal_entry_id
        join accounting_books b on b.org_id=e.org_id and b.id=e.book_id
        join asset_transfer_bases t on t.org_id=a.org_id and t.receiving_asset_id=a.id and t.book_id=e.book_id
       where a.org_id=${orgId} and a.id=${assetId} and t.reversed_by_change_id is null
         and v.kind in('impaired','revalued') and e.status in('posted','reversed')
         and not exists(select 1 from asset_events r where r.org_id=v.org_id and r.reverses_event_id=v.id)
       order by v.occurred_on,v.created_at,v.id`,
    "objects",
  );
}

export async function findVisibleReversibleAsset(
  orgId: string,
  assetId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
) {
  const rows = await db.execute<{ subsidiary_id: string }>(
    sql`
      select subsidiary_id from fixed_assets asset
       where org_id = ${orgId} and id = ${assetId}
         ${subsidiaryFence(allowedSubsidiaryIds)}`,
    "objects",
  );
  return rows[0] ?? null;
}

export async function listAssetReversibleEventRouteRows(
  orgId: string,
  assetId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
) {
  return db.execute<{
    id: string;
    kind: string;
    occurred_on: string;
    amount: string | null;
    financial_change_id: string | null;
    entry_number: string;
    posting_date: string;
    entry_status: string;
    reversed: boolean;
    later_kind: string | null;
  }>(
    sql`
      select event.id, event.kind, event.occurred_on::text as occurred_on,
             event.amount::text as amount, event.financial_change_id,
             entry.entry_number, entry.posting_date::text as posting_date,
             entry.status as entry_status,
             exists (select 1 from asset_events reversal
                      where reversal.org_id = event.org_id
                        and reversal.reverses_event_id = event.id) as reversed,
             (select later.kind from asset_events later
               where later.org_id = event.org_id
                 and later.asset_id = event.asset_id
                 and later.id <> event.id
                 and later.reverses_event_id is null
                 and later.created_at >= event.created_at
                 and not exists (
                   select 1 from asset_events reversal
                    where reversal.org_id = later.org_id
                      and reversal.reverses_event_id = later.id
                 )
               order by later.created_at
               limit 1) as later_kind
        from asset_events event
        join journal_entries entry
          on entry.id = event.journal_entry_id and entry.org_id = event.org_id
        join fixed_assets asset
          on asset.id = event.asset_id and asset.org_id = event.org_id
       where event.org_id = ${orgId} and event.asset_id = ${assetId}
         ${subsidiaryFence(allowedSubsidiaryIds)}
       order by event.occurred_on desc, event.created_at desc`,
    "objects",
  );
}
