import { defineRoute } from '@/lib/api/route';
import { apiErrorResponse } from '@/lib/api/error-response'
import { NextResponse } from 'next/server'
import { db } from '@openbooks/engine/platform/database'
import { computeDistanceTurnover } from '@openbooks/engine/tax'

export const runtime = 'nodejs'

/**
 * Year-to-date distance-sales turnover against the EUR 10,000 Union threshold:
 * posted B2C base excluding VAT, non-euro documents at the ECB spot rate on
 * the last published day on or before the window end. Currencies with no
 * rate are named in `uncoveredCurrencies`, never guessed.
 */
export const GET = defineRoute({
  permission: 'reports.read',
  feature: 'crossBorderTax',
  handler: async ({ authz: routeAuthz, request }) => {
    const raw = new URL(request.url).searchParams.get('year')?.trim()
    const year = raw ? Number(raw) : new Date().getUTCFullYear()
    if (!Number.isInteger(year) || year < 2000 || year > 9999) {
      return NextResponse.json({ error: 'year must be a four-digit calendar year' }, { status: 400 })
    }
    try {
      return NextResponse.json(await computeDistanceTurnover(db, routeAuthz.user.orgId, year))
    } catch (e: unknown) {
      return apiErrorResponse(e, { safeStatus: 422 })
    }
  },
});
