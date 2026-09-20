import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { listStockCounts } from '@openbooks/engine/src/inventory/stock-count-queries.ts'
import { PageHeader } from '@openbooks/ui'
import { can, requirePermission } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import { CountsList } from './CountsList'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('inventory')
  return { title: t('counts.title') }
}

/**
 * Cycle counts — the physical-inventory workflow over stock_counts. Server
 * shell in the house chrome (PageHeader with a back link to Inventory);
 * the list, drawers, and postings are the client CountsList island built on
 * the shared PagedTable + UrlDrawer, exactly like the PDF templates list.
 */
export default async function StockCountsPage() {
  const t = await getTranslations('inventory')
  const authz = await requirePermission('items.read')
  await requireFeatureEnabled(authz.user.orgId, 'inventory')
  const canPost = can(authz, 'items.post')
  const orgId = authz.user.orgId

  const [counts, locations, subsidiaries, items, stockLocations, lots] = await Promise.all([
    listStockCounts(orgId),
    db.execute<{ id: string; name: string | null }>(
      sql`select id, name from locations where org_id = ${orgId} and is_active order by name`,
    ),
    db.execute<{ id: string; name: string | null }>(
      sql`select id, name from subsidiaries where org_id = ${orgId} order by created_at, id`,
    ),
    db.execute<{ id: string; code: string | null; name: string | null }>(sql`
      select it.id, it.code, it.name from items it
        join item_inventory_profiles p on p.item_id = it.id and p.org_id = it.org_id
       where it.org_id = ${orgId} and it.is_active order by it.name`),
    db.execute<{ id: string; code: string | null }>(
      sql`select id, code from stock_locations where org_id = ${orgId} and is_active order by code`,
    ),
    db.execute<{ id: string; item_id: string; lot_number: string }>(
      sql`select id, item_id, lot_number from lots where org_id = ${orgId} order by lot_number`,
    ),
  ])

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('counts.title')}
        description={t('counts.description')}
        back={{ href: '/inventory', label: t('list.title') }}
      />
      <CountsList
        counts={counts}
        locations={locations.rows}
        subsidiaries={subsidiaries.rows}
        items={items.rows}
        stockLocations={stockLocations.rows}
        lots={lots.rows}
        canPost={canPost}
      />
    </div>
  )
}
