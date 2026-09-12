import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { guardFeaturePermission } from '@/lib/feature-gates'
import { listListings, publishApp, installFromListing, AppError } from '@/lib/apps/store'
import { can } from '@/lib/authz'
import { isUuid } from '@/lib/list-params'
import { db } from '@openbooks/engine/src/db.ts'
import { sql } from 'drizzle-orm'
import { installModuleFromListing, publishModule, isModuleListingManifest, ModuleMarketplaceError } from '@/lib/modules/marketplace'
import { ModuleInstallError } from '@openbooks/engine/src/modules/installer.ts'
import { ModuleLifecycleError } from '@openbooks/engine/src/modules/lifecycle.ts'

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
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as { action?: string; key?: string; listingId?: string }
  try {
    if (body.action === 'publishModule') {
      if (!can(gate, 'admin.customization.manage')) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
      if (typeof body.key !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(body.key)) return NextResponse.json({ error: 'valid module key required' }, { status: 400 })
      const { id } = await publishModule(gate.user.orgId, gate.user.id, body.key)
      return NextResponse.json({ ok: true, id })
    }
    if (body.action === 'publish') {
      if (!body.key) return NextResponse.json({ error: 'key required' }, { status: 400 })
      const { id } = await publishApp(gate.user.orgId, gate.user.id, body.key)
      return NextResponse.json({ ok: true, id })
    }
    if (body.action === 'install') {
      if (typeof body.listingId !== 'string' || !isUuid(body.listingId)) return NextResponse.json({ error: 'valid listingId required' }, { status: 400 })
      const listing = (await db.execute<{ manifest: unknown }>(sql`select manifest from app_listings where id = ${body.listingId} and is_active`)).rows[0]
      if (!listing) return NextResponse.json({ error: 'listing not found' }, { status: 404 })
      if (isModuleListingManifest(listing.manifest)) {
        if (!can(gate, 'admin.customization.manage')) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
        const result = await installModuleFromListing(gate.user.orgId, gate.user.id, body.listingId, {
          installerEffectivePermissions: [...gate.permissions],
        })
        return NextResponse.json({ ok: true, kind: 'module', ...result }, { status: result.outcome === 'pending-approval' ? 202 : 200 })
      }
      const { key } = await installFromListing(gate.user.orgId, gate.user.id, body.listingId)
      return NextResponse.json({ ok: true, key })
    }
    return NextResponse.json({ error: 'unknown action' }, { status: 400 })
  } catch (e) {
    if (e instanceof AppError || e instanceof ModuleMarketplaceError || e instanceof ModuleInstallError || e instanceof ModuleLifecycleError) return NextResponse.json({ error: e.message }, { status: e.status })
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
