import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/platform/db'
import { defineRoute } from '@/lib/api/route'

export const runtime = 'nodejs'

/** Item kinds the register never sells (gift cards are issued in Stored value; discounts are cart-level). */
const UNSELLABLE = ['gift_card', 'discount', 'absence', 'labor']

/**
 * GET /api/pos/items?q= — the register's item lookup. A scanned or typed
 * code that matches an item exactly comes first, so a barcode scanner that
 * types the item code and Enter adds that item; otherwise code and name
 * matches follow.
 */
export const GET = defineRoute({
  permission: 'pos.sell',
  feature: 'posRegister',
  handler: async ({ authz, request }) => {
    const q = (new URL(request.url).searchParams.get('q') ?? '').trim().slice(0, 80)
    if (q === '') return NextResponse.json({ items: [] })
    const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
    const items = (await db.execute<{ id: string; code: string | null; name: string; kind: string; unit: string | null; exact: boolean }>(sql`
      select id, code, name, kind, unit, (lower(code) = lower(${q})) as exact
        from items
       where org_id = ${authz.user.orgId} and is_active
         and kind <> all(${sql.param(UNSELLABLE)}::text[])
         and (lower(code) = lower(${q}) or code ilike ${pattern} or name ilike ${pattern})
       order by (lower(code) = lower(${q})) desc, (code ilike ${`${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`}) desc, name
       limit 24`)).rows
    return NextResponse.json({ items })
  },
})
