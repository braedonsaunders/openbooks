import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import { orgFeatureEnabled } from "../organization/org-feature-lock.ts";
import { InventoryError } from "./contracts.ts";
import { inspectionHoldReason } from "./inspection-holds.ts";

export type InventoryInquiry =
  "holds" | "consignment" | "cycle_due" | "layers" | "consumptions";
/** Scoped operational inquiry; cost evidence stays linked to native receipts and journals. */
export async function inventoryInquiry(
  orgId: string,
  actorId: string,
  query: {
    view: InventoryInquiry;
    itemId?: string;
    stockLocationId?: string;
    layerId?: string;
    stockId?: string;
    page?: number;
    search?: string;
    includeClosed?: boolean;
  },
) {
  const page = query.page ?? 0;
  if (!Number.isInteger(page) || page < 0 || page > 100000)
    throw new InventoryError("Invalid inquiry page");
  return withOrgTransaction(orgId, async () => {
    const allowed = await lockActorCommandAuthority(
      db,
      orgId,
      actorId,
      null,
      "items.read",
    );
    const scope =
      allowed === null
        ? sql``
        : sql`and subject.subsidiary_id=any(${`{${[...allowed].join(",")}}`}::uuid[])`;
    if (!(await orgFeatureEnabled(orgId, "inventory", db)))
      throw new InventoryError("Inventory is disabled");
    if (
      query.view === "consignment" &&
      !(await orgFeatureEnabled(orgId, "consignment", db))
    )
      throw new InventoryError("Consignment is disabled");
    let source: ReturnType<typeof sql>;
    if (query.view === "holds") {
      source = sql`select distinct subject.subsidiary_id,h.id as subject_id,h.kind||':'||h.id::text||':'||coalesce(subject.subsidiary_id::text,'') as id,h.kind,h.identifier,h.item_id,item.name as item,h.hold_reason as reason,h.expires_on::text as expiry
        from (select org_id,id,item_id,'lot' as kind,lot_number as identifier,coalesce(hold_reason,${inspectionHoldReason(sql`lots.org_id`,sql`lots.id`,sql`null::uuid`)}) as hold_reason,expires_on from lots
          union all select org_id,id,item_id,'serial',serial_number,coalesce(hold_reason,${inspectionHoldReason(sql`serials.org_id`,sql`serials.lot_id`,sql`serials.id`)}),null::date from serials) h
        join items item on item.org_id=h.org_id and item.id=h.item_id
        left join (select org_id,item_id,lot_id,serial_id,subsidiary_id from inventory_movements
          union all select org_id,item_id,lot_id,serial_id,subsidiary_id from consignment_stock) subject on subject.org_id=h.org_id and subject.item_id=h.item_id
          and ((h.kind='lot' and subject.lot_id=h.id) or (h.kind='serial' and subject.serial_id=h.id))
        where h.org_id=${orgId} ${scope} ${query.itemId ? sql`and h.item_id=${query.itemId}` : sql``}`;
    } else if (query.view === "consignment") {
      source = sql`select subject.id,subject.subsidiary_id,subject.item_id,item.name as item,sl.code as location,
        subject.owner_kind as ownership,owner.display_name as owner,subject.remaining_quantity::text as quantity,
        lot.lot_number as lot,serial.serial_number as serial,subject.received_on::text as date
        from consignment_stock subject join items item on item.org_id=subject.org_id and item.id=subject.item_id
        join stock_locations sl on sl.org_id=subject.org_id and sl.id=subject.stock_location_id
        join parties owner on owner.org_id=subject.org_id and owner.id=subject.owner_party_id
        left join lots lot on lot.org_id=subject.org_id and lot.id=subject.lot_id
        left join serials serial on serial.org_id=subject.org_id and serial.id=subject.serial_id
        where subject.org_id=${orgId} ${query.stockId ? sql`and subject.id=${query.stockId}` : sql`and subject.remaining_quantity>0`} ${scope}`;
    } else if (query.view === "cycle_due") {
      source = sql`select subject.id as subsidiary_id,profile.item_id,subject.id::text||':'||profile.item_id::text as id,
        item.name as item,profile.abc_class as class,policy.interval_days as interval,
        policy.variance_tolerance::text as tolerance,last_count.counted_on::text as last_count,
        (last_count.counted_on+policy.interval_days)::text as due_on,
        case when policy.id is null then 'configuration_required' when last_count.counted_on is null
          or last_count.counted_on+policy.interval_days<=current_date then 'due' else 'scheduled' end as status
        from item_inventory_profiles profile join items item on item.org_id=profile.org_id and item.id=profile.item_id
        cross join subsidiaries subject
        left join inventory_count_policies policy on policy.org_id=profile.org_id and policy.subsidiary_id=subject.id
          and policy.abc_class=profile.abc_class and policy.effective_from<=current_date
          and (policy.effective_to is null or policy.effective_to>current_date)
        left join lateral(select max(c.counted_on) as counted_on from stock_counts c
          join stock_count_lines l on l.org_id=c.org_id and l.stock_count_id=c.id
          where c.org_id=profile.org_id and c.subsidiary_id=subject.id and c.status='posted' and l.item_id=profile.item_id) last_count on true
        where profile.org_id=${orgId} and subject.org_id=profile.org_id and subject.is_active and not subject.is_elimination
          and profile.abc_class is not null ${allowed === null ? sql`` : sql`and subject.id=any(${`{${[...allowed].join(",")}}`}::uuid[])`}`;
      // Legal entity identity is projected once; the generic scope above is for stock subject rows.
      source = sql`select * from (${source}) cycle`;
    } else if (query.view === "layers") {
      if (!query.itemId)
        throw new InventoryError("Choose an item for layer inquiry");
      source = sql`select subject.id,subject.item_id,subject.subsidiary_id,sl.code as location,subject.received_at::date::text as date,
        subject.original_quantity::text as received,subject.remaining_quantity::text as remaining,subject.unit_cost::text as unit_cost,
        round(subject.remaining_quantity*subject.unit_cost,4)::text as value,source.kind as source_kind,source.id as source_movement_id,
        source.memo as source_memo,source.journal_entry_id,doc.id as document_id,doc.kind as document_kind,doc.document_number as document,
        lot.lot_number as lot,serial.serial_number as serial
        from cost_layers subject join inventory_movements source on source.org_id=subject.org_id and source.id=subject.source_movement_id
        join stock_locations sl on sl.org_id=subject.org_id and sl.id=subject.stock_location_id
        left join document_lines dl on dl.org_id=source.org_id and dl.id=source.document_line_id
        left join documents doc on doc.org_id=dl.org_id and doc.id=dl.document_id
        left join lots lot on lot.org_id=source.org_id and lot.id=source.lot_id
        left join serials serial on serial.org_id=source.org_id and serial.id=source.serial_id
        where subject.org_id=${orgId} and subject.item_id=${query.itemId} ${scope}
          ${query.includeClosed ? sql`` : sql`and subject.remaining_quantity>0`}
          ${query.stockLocationId ? sql`and subject.stock_location_id=${query.stockLocationId}` : sql``}`;
    } else {
      if (!query.layerId) throw new InventoryError("Choose a cost layer");
      source = sql`select consumption.id,issue.subsidiary_id,issue.id as movement_id,issue.kind,issue.moved_at::date::text as date,
        consumption.quantity::text as quantity,consumption.unit_cost::text as unit_cost,
        consumption.original_cost::text as original_cost,issue.journal_entry_id,doc.id as document_id,doc.kind as document_kind,doc.document_number as document
        from cost_layer_consumptions consumption join cost_layers subject on subject.org_id=consumption.org_id and subject.id=consumption.cost_layer_id
        join inventory_movements issue on issue.org_id=consumption.org_id and issue.id=consumption.issue_movement_id
        left join document_lines dl on dl.org_id=issue.org_id and dl.id=issue.document_line_id
        left join documents doc on doc.org_id=dl.org_id and doc.id=dl.document_id
        where subject.org_id=${orgId} and subject.id=${query.layerId} ${scope}`;
    }
    const filtered = sql`select inquiry.*,(select name from subsidiaries entity where entity.org_id=${orgId} and entity.id=inquiry.subsidiary_id) as entity from (${source}) inquiry ${query.search ? sql`where inquiry::text ilike ${`%${query.search}%`}` : sql``}`;
    const count = (
      await db.execute<{ n: number }>(
        sql`select count(*)::int as n from (${filtered}) counted`,
      )
    ).rows[0]!.n;
    const rows = (
      await db.execute<Record<string, unknown>>(
        sql`${filtered} order by id limit 50 offset ${page * 50}`,
      )
    ).rows;
    return {
      rows,
      totalCount: count,
      page,
      currentPage: page + 1,
      perPage: 50,
      hasMore: (page + 1) * 50 < count,
    };
  });
}
