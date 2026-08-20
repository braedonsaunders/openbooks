import { NextResponse } from 'next/server'
import { guardFeaturePermission } from '@/lib/feature-gates'
import { listListings, publishApp, installFromListing, AppError } from '@/lib/apps/store'

export const runtime = 'nodejs'

/** GET — browse marketplace listings (deployment-wide). */
export async function GET() {
  const gate = await guardFeaturePermission('apps.manage', 'apps')
  if (gate instanceof NextResponse) return gate
  const { listings, total } = await listListings({ page: 1, perPage: 100 })
  return NextResponse.json({ listings, total, orgId: gate.user.orgId })
}

/**
 * POST — marketplace actions:
 *   { action: 'publish', key }        publish an installed app's active bundle
 *   { action: 'install', listingId }  install a listing into this org
 */
export async function POST(req: Request) {
  const gate = await guardFeaturePermission('apps.manage', 'apps')
  if (gate instanceof NextResponse) return gate
  const body = (await req.json().catch(() => ({}))) as { action?: string; key?: string; listingId?: string }
  try {
    if (body.action === 'publish') {
      if (!body.key) return NextResponse.json({ error: 'key required' }, { status: 400 })
      const { id } = await publishApp(gate.user.orgId, gate.user.id, body.key)
      return NextResponse.json({ ok: true, id })
    }
    if (body.action === 'install') {
      if (!body.listingId) return NextResponse.json({ error: 'listingId required' }, { status: 400 })
      const { key } = await installFromListing(gate.user.orgId, gate.user.id, body.listingId)
      return NextResponse.json({ ok: true, key })
    }
    return NextResponse.json({ error: 'unknown action' }, { status: 400 })
  } catch (e) {
    if (e instanceof AppError) return NextResponse.json({ error: e.message }, { status: e.status })
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
