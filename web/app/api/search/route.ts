import { defineRoute } from "@/lib/api/route";
import { NextResponse } from 'next/server'
import { getAuthz } from '../../../lib/authz'
import { searchEverything } from '../../../lib/search-all'
import { unexpectedServerError } from '../../../lib/api/unexpected'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Global search endpoint backing the always-on header search bar. Fans out
 * across records, reports, settings and help (see lib/search-all.ts),
 * org-scoped and permission-filtered. Returns grouped, ranked hits for the
 * instant results panel.
 */
async function legacyGET(req: Request) {
  const authz = await getAuthz()
  if (!authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const q = new URL(req.url).searchParams.get('q') ?? ''
  if (!q.trim()) return NextResponse.json({ q: '', groups: [], total: 0 })

  try {
    const result = await searchEverything(authz, q)
    return NextResponse.json(result, { headers: { 'cache-control': 'no-store' } })
  } catch (e) {
    return unexpectedServerError('search', e)
  }
}

export const GET = defineRoute({
  public: "session",
  handler: async ({ request }) => legacyGET(request as never),
});
