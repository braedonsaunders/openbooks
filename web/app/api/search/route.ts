import { NextResponse } from 'next/server'
import { getAuthz } from '../../../lib/authz'
import { globalSearch } from '../../../lib/search'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Global search endpoint backing the always-on header search bar. Fans out
 * across contacts, transactions, accounts, items, and projects (see
 * lib/search.ts), org-scoped and permission-filtered. Returns grouped, ranked
 * hits for the instant results panel.
 */
export async function GET(req: Request) {
  const authz = await getAuthz()
  if (!authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const q = new URL(req.url).searchParams.get('q') ?? ''
  if (!q.trim()) return NextResponse.json({ q: '', groups: [], total: 0 })

  try {
    const result = await globalSearch(authz, q)
    return NextResponse.json(result, { headers: { 'cache-control': 'no-store' } })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message ?? 'search failed' }, { status: 500 })
  }
}
