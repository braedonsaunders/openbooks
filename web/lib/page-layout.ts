import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import type { PageLayoutPrefs } from '@openbooks/schema'

/**
 * Per-user page layout preferences (user_page_layouts) — reorder + show/hide
 * for cockpit/module-home panels. Pages read with this and save through
 * /api/me/page-layout. Absent row = product default layout.
 */
export async function userPageLayout(userId: string, page: string): Promise<PageLayoutPrefs> {
  const r = (await db.execute<{ layout: PageLayoutPrefs }>(sql`
    select layout from user_page_layouts where user_id = ${userId} and page = ${page} limit 1
  `))
  const layout = r.rows[0]?.layout
  return layout && typeof layout === 'object' ? layout : {}
}
