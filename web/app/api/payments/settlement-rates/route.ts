import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardPermission } from '../../../../lib/authz'

export const runtime = 'nodejs'

/** Tenant-owned spot observations available as immutable settlement evidence. */
export async function GET(req: Request) {
  const url = new URL(req.url)
  const side = url.searchParams.get('side')
  if (side !== 'ap' && side !== 'ar') {
    return NextResponse.json({ error: 'side must be ap or ar' }, { status: 400 })
  }
  const gate = await guardPermission(side === 'ap' ? 'ap.pay' : 'ar.pay')
  if (gate instanceof NextResponse) return gate

  const from = (url.searchParams.get('from') ?? '').toUpperCase()
  const targets = [...new Set((url.searchParams.get('to') ?? '').split(',').map((value) => value.trim().toUpperCase()).filter(Boolean))]
  const date = url.searchParams.get('date') ?? ''
  if (!/^[A-Z]{3}$/.test(from) || !targets.length || targets.some((currency) => !/^[A-Z]{3}$/.test(currency))) {
    return NextResponse.json({ error: 'valid source and target currencies are required' }, { status: 400 })
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: 'valid settlement date is required' }, { status: 400 })
  }

  const result = (await db.execute<{ id: string; toCurrency: string; rate: string; asOf: string; source: string }>(sql`
    select id, to_currency as "toCurrency", rate::text, as_of::text as "asOf", source
      from (
        select r.*,
               row_number() over (partition by r.to_currency order by r.as_of desc, r.imported_at desc nulls last, r.created_at desc) as ordinal
          from fx_rates r
         where r.org_id = ${gate.user.orgId}
           and r.from_currency = ${from}
           and r.to_currency in ${targets}
           and r.rate_type = 'spot'
           and r.as_of <= ${date}::date
      ) ranked
     where ordinal <= 10
     order by "toCurrency", "asOf" desc
  `))

  return NextResponse.json({ rates: result.rows })
}
