import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { guardFeaturePermission } from '@/lib/feature-gates'
import { getAppByKey } from '@/lib/apps/store'

export const runtime = 'nodejs'
/** Organization-scoped, bounded pages of immutable operational evidence. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ key: string }> },
) {
  const gate = await guardFeaturePermission('apps.manage', 'apps')
  if (gate instanceof NextResponse) return gate
  const { key } = await params
  const app = await getAppByKey(gate.user.orgId, key)
  if (!app)
    return NextResponse.json({ error: 'App not found' }, { status: 404 })
  const query = new URL(request.url).searchParams
  const section = query.get('section') ?? 'versions'
  const page = Number(query.get('page') ?? '1')
  if (!Number.isSafeInteger(page) || page < 1 || page > 1000000)
    return NextResponse.json({ error: 'Invalid page' }, { status: 400 })
  const offset = (page - 1) * 25
  const orgId = gate.user.orgId
  const result =
    section === 'versions'
      ? await db.execute(sql`
    select id, version, status, created_at as at, created_by as actor_id
    from app_versions where org_id=${orgId} and app_id=${app.id} order by created_at desc,id desc limit 26 offset ${offset}`)
      : section === 'runs'
        ? await db.execute(sql`
    select id,version_id,endpoint,status,units,logs,error_message,duration_ms,actor_id,at
    from app_runs where org_id=${orgId} and app_id=${app.id} order by at desc,id desc limit 26 offset ${offset}`)
        : section === 'audit'
          ? await db.execute(sql`
    select id,action,changes,actor_id,at from audit_log where org_id=${orgId} and ((table_name='apps' and row_id=${app.id}) or (table_name='app_listings' and row_id in (select id from app_listings where publisher_org_id=${orgId} and key=${key})) or (table_name='extension_drafts' and row_id in (select id from extension_drafts where org_id=${orgId} and extension_key=${key})))
    order by at desc,id desc limit 26 offset ${offset}`)
          : section === 'storage'
            ? await db.execute(sql`
    select id,namespace,key,value,updated_at as at,updated_by as actor_id from app_storage
    where org_id=${orgId} and app_id=${app.id} order by namespace,key,id limit 26 offset ${offset}`)
            : null
  if (!result)
    return NextResponse.json({ error: 'Invalid section' }, { status: 400 })
  return NextResponse.json(
    {
      rows: result.rows.slice(0, 25),
      hasMore: result.rows.length > 25,
      page,
      activeVersionId: app.activeVersionId,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
