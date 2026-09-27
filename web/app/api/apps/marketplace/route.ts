import { notFound } from '@/lib/api/responses';
import { z } from 'zod';
import { defineRoute } from '@/lib/api/route';
import { apiErrorResponse } from '@/lib/api/error-response'
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import {
  listListings,
  publishApp,
  unpublishApp,
  AppError,
} from '@/lib/apps/store'
import { applicationContextFromSession } from '@/lib/application/context'
import { draftExtension } from '@/lib/application/extensions'
import { ApplicationError } from '@/lib/application/errors'
import { isUuid } from '@/lib/list-params'
const POSTBodySchema1 = z.object({ "action": z.unknown().optional(), "key": z.string().optional(), "listingId": z.string().optional() }).passthrough();


export const runtime = 'nodejs'
export const GET = defineRoute({
  permission: 'apps.manage',
  feature: 'apps',
  handler: async ({ authz: routeAuthz }) => {
    const gate = routeAuthz;
    const { listings, total } = await listListings({ page: 1, perPage: 100 })
    return NextResponse.json({ listings, total, orgId: gate.user.orgId })
  },
});
export const POST = defineRoute({
  permission: 'apps.manage',
  feature: 'apps',
  body: POSTBodySchema1,
  handler: async ({ request: request, authz: routeAuthz, body: routeBody }) => {
    const gate = routeAuthz;

    const body = routeBody
    try {
        if (body.action === 'unpublish' && typeof body.key === 'string') {
          // unpublishApp holds FOR UPDATE and throws when the listing is
          // already inactive, so a concurrent second withdraw cannot report
          // {ok:true} after this read. The route still names the key here
          // so a sequential second unpublish refuses before calling the helper.
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
            return notFound('record')
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
          return apiErrorResponse(error)
        throw error
      }
  },
});
