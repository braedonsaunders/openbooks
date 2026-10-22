import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/platform/db'
import { subsidiaryVisibleFilter } from '@openbooks/engine/organization/scope'
import { defineRoute } from '@/lib/api/route'

export const runtime = 'nodejs'

/** GET /api/pos/customers?q= — find a customer for the sale among the native customer parties. */
export const GET = defineRoute({
  permission: 'pos.sell',
  feature: 'posRegister',
  handler: async ({ authz, request }) => {
    const q = (new URL(request.url).searchParams.get('q') ?? '').trim().slice(0, 80)
    if (q.length < 2) return NextResponse.json({ customers: [] })
    const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
    const customers = await db.execute<{ id: string; name: string; email: string | null; phone: string | null }>(sql`
      select p.id, p.display_name as name, p.email, p.phone
        from parties p
        join customer_roles c on c.org_id = p.org_id and c.party_id = p.id and c.is_active
       where p.org_id = ${authz.user.orgId} and p.is_active
         and (p.display_name ilike ${pattern} or p.email ilike ${pattern} or p.phone ilike ${pattern})
         ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, authz.allowedSubsidiaryIds ?? null, { orgWideNull: true })}
       order by p.display_name
       limit 20`, 'objects')
    return NextResponse.json({ customers })
  },
})
