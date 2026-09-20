import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { guardFeaturePermission } from '@/lib/feature-gates'
import {
  listListings,
  publishApp,
  unpublishApp,
  AppError,
} from '@/lib/apps/store'
import { applicationContextFromSession } from '@/lib/application/context'
import { draftExtension } from '@/lib/application/extensions'
import { ApplicationError } from '@/lib/application/errors'
import { jsonObject, parseJsonBody } from '@/lib/api/json'
import { isUuid } from '@/lib/list-params'

export const runtime = 'nodejs'
export async function GET() {
  const gate = await guardFeaturePermission('apps.manage', 'apps')
  if (gate instanceof NextResponse) return gate
  const { listings, total } = await listListings({ page: 1, perPage: 100 })
  return NextResponse.json({ listings, total, orgId: gate.user.orgId })
}
export async function POST(request: Request) {
  const gate = await guardFeaturePermission('apps.manage', 'apps')
  if (gate instanceof NextResponse) return gate
  const parsed = await parseJsonBody(request, jsonObject)
  if (!parsed.ok) return parsed.response
  const body = parsed.data
  try {
    if (body.action === 'unpublish' && typeof body.key === 'string') {
      // unpublishApp locks then returns without UPDATE or audit when the
      // listing is already inactive. A write that matches zero rows is a
      // failure: refuse by name so a second unpublish is not {ok:true}.
      const listing = (
        await db.execute<{ is_active: boolean }>(
          sql`select is_active from app_listings where key=${body.key} and publisher_org_id=${gate.user.orgId}`,
        )
      ).rows[0]
      if (listing && !listing.is_active)
        throw new AppError(
          `Nothing was withdrawn: "${body.key}" is already inactive. Publish it again if you need to withdraw a live listing.`,
          409,
        )
      await unpublishApp(gate.user.orgId, gate.user.id, body.key)
      return NextResponse.json({ ok: true })
    }
    if (body.action === 'publish' && typeof body.key === 'string')
      return NextResponse.json({
        ok: true,
        ...(await publishApp(gate.user.orgId, gate.user.id, body.key)),
      })
    if (
      body.action === 'install' &&
      typeof body.listingId === 'string' &&
      isUuid(body.listingId)
    ) {
      const listing = (
        await db.execute<{ manifest: unknown; files: unknown }>(
          sql`select manifest,files from app_listings where id=${body.listingId} and is_active`,
        )
      ).rows[0]
      if (!listing)
        return NextResponse.json(
          { error: 'App listing not found' },
          { status: 404 },
        )
      const draft = await draftExtension(
        applicationContextFromSession(gate, 'api', crypto.randomUUID()),
        { bundle: listing, reason: 'Review app from library' },
      )
      return NextResponse.json({ ok: true, ...draft })
    }
    return NextResponse.json(
      { error: 'Invalid app library action' },
      { status: 400 },
    )
  } catch (error) {
    if (error instanceof AppError || error instanceof ApplicationError)
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      )
    throw error
  }
}
