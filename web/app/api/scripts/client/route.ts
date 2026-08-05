import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { getAuthz } from '@/lib/authz'
import { isFeatureEnabled } from '@/lib/features'

export const runtime = 'nodejs'

/**
 * Client-script delivery: the active 'client' scripts for a document kind
 * (plus kind-agnostic ones). Any signed-in user may fetch them — the scripts
 * validate THEIR form entry, and they execute in an opaque-origin sandbox in
 * the user's own browser, never in the host page.
 */
export async function GET(req: Request) {
  const authz = await getAuthz()
  if (!authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!(await isFeatureEnabled(authz.user.orgId, 'scripts'))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  const url = new URL(req.url)
  const kind = url.searchParams.get('documentKind') ?? ''

  const r = (await db.execute(sql`
    select id, name, source
      from user_scripts
     where org_id = ${authz.user.orgId}
       and trigger_point = 'client'
       and is_active
       and (document_kind is null or document_kind = ${kind})
     order by sort_order, name`)) as unknown as { rows: { id: string; name: string; source: string }[] }

  return NextResponse.json({ scripts: r.rows })
}
