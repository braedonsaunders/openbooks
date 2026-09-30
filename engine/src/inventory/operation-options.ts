import { sql } from 'drizzle-orm'
import { db, withOrgTransaction } from '../platform/db.ts'
import { isUuid } from '../platform/uuid.ts'
import { lockActorCommandAuthority } from '../organization/actor-command-authority.ts'
import { InventoryError } from './contracts.ts'
import { assertInventoryFeature } from './profile-policy.ts'

export type InventoryOperationOption = {
  id: string
  item: string
  location: string
  subsidiary: string
  date: string
  quantity: string
  kind: string
}
/** Scoped, searched and cursor-paged choices for the native movement editor.
 * Every eligible historical source remains reachable; the command independently
 * rechecks availability, provenance and authority under its write locks. */
export async function listInventoryOperationOptions(orgId: string, actorId: string, query: {
  operation: 'disassemble' | 'reverse'; q?: string; cursor?: string | null; limit?: number
}) {
  if (!['disassemble', 'reverse'].includes(query.operation)) throw new InventoryError('Choose disassembly or controlled reversal')
  const limit = query.limit ?? 50
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new InventoryError('Movement page size must be between 1 and 100')
  if (query.cursor && !isUuid(query.cursor)) throw new InventoryError('The movement page cursor is invalid — restart the search')
  return withOrgTransaction(orgId, async () => {
    const allowed = await lockActorCommandAuthority(db, orgId, actorId, null, query.operation === 'disassemble' ? 'items.post' : 'items.reverse')
    await assertInventoryFeature(db, orgId)
    const scope = allowed === null ? sql`` : allowed.size ? sql`and m.subsidiary_id in (${sql.join([...allowed].map(id => sql`${id}::uuid`),sql`, `)})` : sql`and false`
    const after = query.cursor ? (await db.execute<{ moved_at: string; id: string }>(sql`select m.moved_at::text,m.id from inventory_movements m
      where m.org_id=${orgId} and m.id=${query.cursor} ${scope}`)).rows[0] : null
    if (query.cursor && !after) throw new InventoryError('The movement page cursor is unavailable — restart the search')
    const text = query.q?.trim() ?? ''
    if (text.length > 200) throw new InventoryError('Use at most 200 characters to search movements')
    const kinds = query.operation === 'disassemble' ? ['assembly_build'] : ['receipt','issue','transfer_out','transfer_in','assembly_build','assembly_consume','assembly_disassembly','assembly_recovery']
    const joins = sql`join items item on item.org_id=m.org_id and item.id=m.item_id
      join stock_locations location on location.org_id=m.org_id and location.id=m.stock_location_id
      join subsidiaries subsidiary on subsidiary.org_id=m.org_id and subsidiary.id=m.subsidiary_id
      left join journal_entries entry on entry.org_id=m.org_id and entry.id=m.journal_entry_id
      left join assembly_disassemblies operation on operation.org_id=m.org_id and operation.id=m.assembly_disassembly_id`
    const where = sql`m.org_id=${orgId} ${scope} and m.status='posted'
      and ((entry.origin='inventory' and entry.status='posted') or (operation.id is not null and operation.journal_entry_id is null))
      and m.kind in (${sql.join(kinds.map(kind => sql`${kind}`),sql`, `)})
      and not exists(select 1 from inventory_movements reverse where reverse.org_id=m.org_id and reverse.reverses_movement_id=m.id)
      ${query.operation === 'disassemble' ? sql`and entry.custom ? 'assemblyBuild'
        and exists(select 1 from cost_layers layer where layer.org_id=m.org_id and layer.source_movement_id=m.id and layer.remaining_quantity>0)` : sql``}
      ${text ? sql`and concat_ws(' ',item.code,item.name,location.code,subsidiary.name,m.id::text,m.moved_at::date::text) ilike ${`%${text}%`}` : sql``}`
    const count = (await db.execute<{ count: number }>(sql`select count(*)::int as count from inventory_movements m ${joins} where ${where}`)).rows[0]!.count
    const rows = (await db.execute<InventoryOperationOption>(sql`select m.id,concat_ws(' — ',item.code,item.name) as item,
      location.code as location,subsidiary.name as subsidiary,m.moved_at::date::text as date,m.quantity::text,m.kind
      from inventory_movements m ${joins} where ${where}
      ${after ? sql`and (m.moved_at,m.id)<(${after.moved_at}::timestamptz,${after.id}::uuid)` : sql``}
      order by m.moved_at desc,m.id desc limit ${limit+1}`)).rows
    const hasMore = rows.length > limit
    const options = rows.slice(0,limit)
    return { options, totalCount: count, nextCursor: hasMore ? options.at(-1)!.id : null }
  })
}
