import 'server-only'

import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { isUuid } from './list-params'

/**
 * Line-level warehouse resolution shared by the order draft writer and the
 * generic document edit writer (F-t07-003 pickers). One reader, two callers:
 * an explicit choice is validated the same way everywhere, and the silent
 * single-location default matches the posting reader's fallback
 * (loadDocumentInventoryLines resolves a blank line to the org's only
 * active location), so what the drawer stores is what posting relieves.
 */

export interface StockLocationOption {
  id: string
  code: string | null
}

/** Active warehouses, code-ordered, for line pickers. */
export async function activeStockLocations(orgId: string): Promise<StockLocationOption[]> {
  return (
    await db.execute<{ id: string; code: string | null }>(sql`
      select id, code from stock_locations where org_id = ${orgId} and is_active order by code`)
  ).rows
}

/** Items carrying a costing profile — the only lines a warehouse applies to. */
export async function profiledItemIds(orgId: string, itemIds: string[]): Promise<Set<string>> {
  const ids = [...new Set(itemIds.filter((id) => isUuid(id)))]
  if (ids.length === 0) return new Set()
  const rows = (
    await db.execute<{ item_id: string }>(sql`
      select item_id from item_inventory_profiles
       where org_id = ${orgId} and item_id = any(${`{${ids.join(',')}}`}::uuid[])`)
  ).rows
  return new Set(rows.map((row) => row.item_id))
}

export interface LineStockLocationScope {
  active: StockLocationOption[]
  profiled: Set<string>
}

export type LineStockLocationResolution = { locationId: string | null } | { error: string }

/**
 * Resolve the warehouse a document line stores. An explicit choice must name
 * an active warehouse of this organization; a blank line for a stocked item
 * silently takes the org's only active location and stays blank when the
 * answer is ambiguous (several locations) or moot (the item is not stocked,
 * so no picker was offered). Never make a caller answer a question with one
 * possible answer.
 */
export function resolveLineStockLocation(
  lineNumber: number,
  itemId: string | null,
  stockLocationId: string | null | undefined,
  scope: LineStockLocationScope,
): LineStockLocationResolution {
  const label = `Line ${lineNumber}`
  if (stockLocationId !== undefined && stockLocationId !== null && stockLocationId !== '') {
    if (!isUuid(stockLocationId)) return { error: `${label}: invalid stock location` }
    const found = scope.active.find((location) => location.id === stockLocationId)
    // Foreign and inactive warehouses share one answer: neither can relieve
    // stock for this line, and the distinction is not the operator's problem.
    if (!found) return { error: `${label}: stock location is not an active warehouse in this organization` }
    return { locationId: stockLocationId }
  }
  if (itemId && scope.profiled.has(itemId) && scope.active.length === 1) {
    return { locationId: scope.active[0]!.id }
  }
  return { locationId: null }
}
