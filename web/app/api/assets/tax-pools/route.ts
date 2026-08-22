import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { listTaxRegimes, runTaxPool } from '@openbooks/engine/src/tax-pool-run.ts'
import { guardFeaturePermission } from '../../../../lib/feature-gates'

export const runtime = 'nodejs'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

async function primaryBook(orgId: string): Promise<string | null> {
  const r = (await db.execute<{ id: string }>(sql`select id from accounting_books where org_id = ${orgId} and is_primary = true limit 1`))
  return r.rows[0]?.id ?? null
}
async function rootSubsidiary(orgId: string): Promise<string | null> {
  const r = (await db.execute<{ id: string }>(sql`select id from subsidiaries where org_id = ${orgId} and parent_id is null order by created_at limit 1`))
  return r.rows[0]?.id ?? null
}

/** Read a tax year's computed pool results (Schedule 8-style). */
export async function GET(req: Request) {
  const gate = await guardFeaturePermission('assets.read', 'fixedAssets')
  if (gate instanceof NextResponse) return gate
  const p = new URL(req.url).searchParams
  const taxYear = Number(p.get('taxYear'))
  if (!Number.isInteger(taxYear)) return NextResponse.json({ error: 'taxYear required' }, { status: 422 })
  const r = (await db.execute<Record<string, string>>(sql`
    select pp.tax_year, tp.class_code, tp.regime,
           pp.opening_balance::text, pp.additions::text, pp.dispositions::text,
           pp.allowance::text, pp.closing_balance::text, pp.recapture::text, pp.terminal_loss::text
      from tax_pool_periods pp
      join tax_depreciation_pools tp on tp.id = pp.pool_id and tp.org_id = pp.org_id
     where pp.org_id = ${gate.user.orgId} and pp.tax_year = ${taxYear}
     order by tp.class_code`))
  return NextResponse.json({ rows: r.rows })
}

/** Run the tax pools for a year (defaults: primary book, root subsidiary, calendar year). */
export async function POST(req: Request) {
  const gate = await guardFeaturePermission('assets.manage', 'fixedAssets')
  if (gate instanceof NextResponse) return gate
  const body = (await req.json().catch(() => ({}))) as {
    regime?: string; taxYear?: number; yearStart?: string; yearEnd?: string; bookId?: string; subsidiaryId?: string
  }
  const availableRegimes = await listTaxRegimes(gate.user.orgId)
  const regime = body.regime || availableRegimes[0]?.code
  if (!regime || !availableRegimes.some((item) => item.code === regime)) {
    return NextResponse.json({ error: 'tax depreciation regime is not enabled for this company country' }, { status: 422 })
  }
  const taxYear = Number(body.taxYear)
  if (!Number.isInteger(taxYear)) return NextResponse.json({ error: 'taxYear required' }, { status: 422 })
  const yearStart = body.yearStart && DATE_RE.test(body.yearStart) ? body.yearStart : `${taxYear}-01-01`
  const yearEnd = body.yearEnd && DATE_RE.test(body.yearEnd) ? body.yearEnd : `${taxYear}-12-31`

  const bookId = body.bookId || (await primaryBook(gate.user.orgId))
  const subsidiaryId = body.subsidiaryId || (await rootSubsidiary(gate.user.orgId))
  if (!bookId || !subsidiaryId) return NextResponse.json({ error: 'no accounting book / subsidiary configured' }, { status: 422 })

  try {
    const result = await runTaxPool(gate.user.orgId, bookId, subsidiaryId, regime, taxYear, {
      yearStart, yearEnd, actorId: gate.user.id,
    })
    return NextResponse.json(result)
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'run failed' }, { status: 422 })
  }
}
