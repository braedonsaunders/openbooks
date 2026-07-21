import { NextResponse } from 'next/server'
import { publishOverheadRates } from '../../../../../lib/overhead-publish'

export const runtime = 'nodejs'

/**
 * Internal overhead-publish endpoint — the background worker calls this on
 * the scheduled cadence (the True Cost engine lives in web/lib; the worker
 * can't import it). Not a user route: authenticated by the shared internal
 * token, given orgId + effectiveFrom explicitly, and idempotent — publishing
 * twice for the same date replaces the same rows.
 *
 *   POST /api/internal/overhead/publish  { orgId, effectiveFrom }
 */
export async function POST(req: Request) {
  const expected = process.env.OPENBOOKS_INTERNAL_TOKEN || ''
  const provided = req.headers.get('x-internal-token') || ''
  if (!expected || provided !== expected) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const body = await req.json().catch(() => ({}))
  const { orgId, effectiveFrom } = body
  if (!orgId || !/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom ?? '')) {
    return NextResponse.json({ error: 'orgId and effectiveFrom are required' }, { status: 422 })
  }
  try {
    const result = await publishOverheadRates(orgId, null, effectiveFrom)
    return NextResponse.json({ ok: true, ...result })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
