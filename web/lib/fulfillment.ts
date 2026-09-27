import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { subsidiaryVisibleFilter } from '@openbooks/engine/src/organization/subsidiary-scope.ts'

/** A carrier a draft shipment may name, with the service levels it offers. */
export interface CarrierOption {
  id: string
  code: string
  name: string
  services: string[]
}

/**
 * The organization's active carriers for the shipment carrier picker. An
 * inactive carrier cannot be chosen on a shipment (the engine refuses it);
 * a shipment that already names one still shows it from its own record.
 */
export async function listActiveCarriers(orgId: string): Promise<CarrierOption[]> {
  const rows = (await db.execute<{ id: string; code: string; name: string; services: string[] | null }>(sql`
    select id, code, name, services
      from carriers
     where org_id = ${orgId} and is_active
     order by name, code`)).rows
  return rows.map((row) => ({ id: row.id, code: row.code, name: row.name, services: row.services ?? [] }))
}

export interface FulfillmentQueueCounts {
  /** Pick lists not voided whose stage is still open. */
  openPickLists: number
  /** Draft shipments: created from a pick list and not yet completed. */
  shipmentsToComplete: number
}

/**
 * The warehouse cockpit's fulfilment work queue, counted inside the caller's
 * visible legal entities — the same population the Pick lists and Shipments
 * lists show under their open-stage filter.
 */
export async function fulfillmentQueueCounts(
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<FulfillmentQueueCounts> {
  const row = (await db.execute<{ open_pick_lists: string; shipments_to_complete: string }>(sql`
    select count(*) filter (where d.kind = 'pick_list')::text as open_pick_lists,
           count(*) filter (where d.kind = 'shipment' and d.status = 'draft')::text as shipments_to_complete
      from documents d
      join fulfillment_documents fd on fd.document_id = d.id and fd.org_id = d.org_id
     where d.org_id = ${orgId}
       and d.kind in ('pick_list', 'shipment')
       and d.status <> 'voided'
       and fd.stage = 'open'${subsidiaryVisibleFilter(sql`d.subsidiary_id`, allowedSubsidiaryIds)}`)).rows[0]
  return {
    openPickLists: Number(row?.open_pick_lists ?? 0),
    shipmentsToComplete: Number(row?.shipments_to_complete ?? 0),
  }
}
