import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { listTaxRegimes, runTaxPool } from '@openbooks/engine/src/tax-returns/pool-run.ts'
import { listTaxYearWindows, resolveTaxYearWindow } from '@openbooks/engine/src/tax-returns/macrs-calendar.ts'
import { isIsoCalendarDate } from '@openbooks/engine/src/platform/business-date.ts'
import { guardFeaturePermission } from '../../../../lib/feature-gates'
import { guardSubsidiaryScope } from '../../../../lib/authz'
import { isUuid } from '../../../../lib/list-params'
import { subsidiaryVisibleFilter } from '../../../../lib/subsidiaries'

export const runtime = 'nodejs'

/** Filing-year label for result filtering, never a source of run dates. */
function isRunnableTaxYear(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && isIsoCalendarDate(`${value}-01-01`)
}

async function primaryBook(orgId: string): Promise<string | null> {
  const r = (await db.execute<{ id: string }>(sql`select id from accounting_books where org_id = ${orgId} and is_primary = true and is_active limit 1`))
  return r.rows[0]?.id ?? null
}
async function rootSubsidiary(orgId: string): Promise<string | null> {
  const r = (await db.execute<{ id: string }>(sql`select id from subsidiaries where org_id = ${orgId} and parent_id is null and is_active and not is_elimination order by created_at limit 1`))
  return r.rows[0]?.id ?? null
}

/** List declared windows, or every computed window with the requested filing label. */
export async function GET(req: Request) {
  const gate = await guardFeaturePermission('assets.read', 'fixedAssets')
  if (gate instanceof NextResponse) return gate
  const p = new URL(req.url).searchParams
  if (p.get('view') === 'windows') {
    const subsidiaryId = p.get('subsidiaryId')
    const regime = p.get('regime')
    if (!subsidiaryId || !isUuid(subsidiaryId)) return NextResponse.json({ error: 'not found' }, { status: 404 })
    const denied = guardSubsidiaryScope(gate, subsidiaryId)
    if (denied) return denied
    const subsidiary = await db.execute<{ id: string }>(sql`
      select id from subsidiaries where org_id=${gate.user.orgId} and id=${subsidiaryId}
        and is_active and not is_elimination limit 1`)
    if (!subsidiary.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })
    const regimes = await listTaxRegimes(gate.user.orgId)
    if (!regime || !regimes.some((row) => row.code === regime)) {
      return NextResponse.json({ error: 'select an enabled tax depreciation regime' }, { status: 422 })
    }
    return NextResponse.json({ windows: await listTaxYearWindows(db, gate.user.orgId, { subsidiaryId, regime }) })
  }
  const taxYear = Number(p.get('taxYear'))
  if (!isRunnableTaxYear(taxYear)) return NextResponse.json({ error: 'taxYear required' }, { status: 422 })
  const r = (await db.execute<Record<string, string>>(sql`
    select tw.filing_year as tax_year, pp.tax_year_window_id, pp.year_start::text, pp.year_end::text,
           tp.subsidiary_id, tp.book_id, tp.class_code, tp.regime,
           pp.opening_balance::text, pp.additions::text, pp.dispositions::text,
           pp.allowance::text, pp.closing_balance::text, pp.recapture::text, pp.terminal_loss::text
      from tax_pool_periods pp
      join tax_depreciation_pools tp on tp.id = pp.pool_id and tp.org_id = pp.org_id
      join tax_year_windows tw on tw.id = pp.tax_year_window_id and tw.org_id = pp.org_id
     where pp.org_id = ${gate.user.orgId} and tw.filing_year = ${taxYear}
       ${subsidiaryVisibleFilter(sql`tp.subsidiary_id`, gate.allowedSubsidiaryIds)}
     order by pp.year_start, tp.subsidiary_id, tp.book_id, tp.class_code`))
  return NextResponse.json({ rows: r.rows })
}

/** Run one registered tax-year window (primary book/root subsidiary remain scoped defaults). */
export async function POST(req: Request) {
  const gate = await guardFeaturePermission('assets.manage', 'fixedAssets')
  if (gate instanceof NextResponse) return gate
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as {
    regime?: string; taxYear?: number; yearStart?: string; yearEnd?: string; bookId?: string; subsidiaryId?: string; taxYearWindowId?: string
  }
  const availableRegimes = await listTaxRegimes(gate.user.orgId)
  const regime = body.regime
  if (!regime || !availableRegimes.some((item) => item.code === regime)) {
    return NextResponse.json({ error: 'tax depreciation regime is not enabled for this company country' }, { status: 422 })
  }
  // Optional legacy facts must agree with the selected registered window;
  // none of them supplies a default or silently overrides its identity.
  if (body.taxYear !== undefined && !isRunnableTaxYear(body.taxYear)) return NextResponse.json({ error: 'taxYear must be a valid filing-year label' }, { status: 422 })
  for (const [label, value] of [['Year start', body.yearStart], ['Year end', body.yearEnd]] as const) {
    if (value !== undefined && !isIsoCalendarDate(value)) {
      return NextResponse.json({ error: `${label} must be a real calendar date (YYYY-MM-DD)` }, { status: 422 })
    }
  }

  let bookId: string | null
  if (body.bookId !== undefined) {
    if (typeof body.bookId !== 'string' || !isUuid(body.bookId)) {
      return NextResponse.json({ error: 'invalid bookId' }, { status: 422 })
    }
    const book = await db.execute<{ id: string }>(sql`
      select id
        from accounting_books
       where id = ${body.bookId} and org_id = ${gate.user.orgId} and is_active
       limit 1`)
    if (!book.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })
    bookId = book.rows[0].id
  } else {
    bookId = await primaryBook(gate.user.orgId)
  }

  // An explicit subsidiary is a write target, not merely a run parameter.
  // Resolve it inside this org before applying the caller's subsidiary scope;
  // otherwise an unrestricted caller could even pass a foreign-org UUID into
  // the engine, while a restricted caller could mutate an entity they cannot
  // see. Omitting the field keeps the established root-subsidiary default, but
  // that root is still subject to the same scope gate.
  if (body.subsidiaryId !== undefined && (typeof body.subsidiaryId !== 'string' || !isUuid(body.subsidiaryId))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  const requestedSubsidiaryId = body.subsidiaryId
  let subsidiaryId: string | null
  if (requestedSubsidiaryId) {
    const requestedDenied = guardSubsidiaryScope(gate, requestedSubsidiaryId)
    if (requestedDenied) return requestedDenied
    const subsidiary = await db.execute<{ id: string }>(sql`
      select id
        from subsidiaries
       where id = ${requestedSubsidiaryId} and org_id = ${gate.user.orgId} and is_active and not is_elimination
       limit 1`)
    if (!subsidiary.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })
    subsidiaryId = subsidiary.rows[0].id
  } else {
    subsidiaryId = await rootSubsidiary(gate.user.orgId)
  }

  if (!bookId || !subsidiaryId) return NextResponse.json({ error: 'no accounting book / subsidiary configured' }, { status: 422 })
  const denied = guardSubsidiaryScope(gate, subsidiaryId)
  if (denied) return denied
  if (!body.taxYearWindowId || typeof body.taxYearWindowId !== 'string' || !isUuid(body.taxYearWindowId)) {
    return NextResponse.json({ error: 'Select a registered tax-year window. Configure its dates in Fixed Assets → Tax depreciation setup → Tax years.' }, { status: 422 })
  }

  try {
    const window = await resolveTaxYearWindow(db, gate.user.orgId, {
      windowId: body.taxYearWindowId, subsidiaryId, regime,
      yearStart: body.yearStart, yearEnd: body.yearEnd,
    })
    if (body.taxYear !== undefined && body.taxYear !== window.filingYear) {
      return NextResponse.json({ error: 'taxYear does not match the selected tax-year window filing label' }, { status: 422 })
    }
    const result = await runTaxPool(gate.user.orgId, bookId, subsidiaryId, regime, window.filingYear, {
      taxYearWindowId: window.id, yearStart: window.yearStart, yearEnd: window.yearEnd, actorId: gate.user.id,
    })
    return NextResponse.json(result)
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'run failed' }, { status: 422 })
  }
}
