import { z } from 'zod';
import { defineRoute } from '@/lib/api/route';
import { apiErrorResponse } from '@/lib/api/error-response'
import { NextResponse } from 'next/server'
import {
  AppError,
  deleteApp,
  getAppByKey,
  setAppStatus,
} from '@/lib/apps/store'
import { notFound } from "@/lib/api/responses";
const PATCHBodySchema1 = z.object({ "status": z.string().optional() }).passthrough();



export const runtime = 'nodejs'

/** GET — App details (any user who may use apps). */
export const GET = defineRoute({
  permission: 'apps.use',
  feature: 'apps',
  handler: async ({ request: _req, authz: routeAuthz, params: routeParams }) => {
    const params = Promise.resolve(routeParams as { key: string });
    const gate = routeAuthz;
    const { key } = await params
    const app = await getAppByKey(gate.user.orgId, key)
    if (!app) return notFound("record")
    return NextResponse.json({ app })
  },
});

/** PATCH — enable/disable an App.
 *  {ok:true} only after setAppStatus returns this request's UPDATE row
 *  count and that count is greater than zero. */
export const PATCH = defineRoute({
  permission: 'apps.manage',
  feature: 'apps',
  body: PATCHBodySchema1,
  handler: async ({ request: req, authz: routeAuthz, params: routeParams, body: routeBody }) => {
    const params = Promise.resolve(routeParams as { key: string });
    const gate = routeAuthz;
    const { key } = await params

    const body = routeBody as { status?: string }
    if (body.status !== 'installed' && body.status !== 'disabled') {
        return NextResponse.json(
          { error: 'status must be "installed" or "disabled"' },
          { status: 400 },
        )
      }
    try {
        const written = await setAppStatus(gate.user.orgId, gate.user.id, key, body.status)
        if (!written || written.affectedRows < 1) {
          throw new AppError(
            `App "${key}" status was not changed to ${body.status}. Confirm the app is still visible in this organization and retry.`,
            409,
          )
        }
      } catch (error) {
        if (error instanceof AppError)
          return apiErrorResponse(error)
        throw error
      }
    return NextResponse.json({ ok: true })
  },
});

/** DELETE — uninstall an App (with an append-only evidence snapshot).
 *  {ok:true} only after deleteApp returns this request's UPDATE/DELETE
 *  row count and that count is greater than zero. A history-preserving
 *  uninstall that disables the row is that successful write. */
export const DELETE = defineRoute({
  permission: 'apps.manage',
  feature: 'apps',
  handler: async ({ request: _req, authz: routeAuthz, params: routeParams }) => {
    const params = Promise.resolve(routeParams as { key: string });
    const gate = routeAuthz;
    const { key } = await params
    try {
        const written = await deleteApp(gate.user.orgId, gate.user.id, key)
        if (!written || written.affectedRows < 1) {
          throw new AppError(
            `App "${key}" was not uninstalled. Confirm the app is still visible in this organization and retry.`,
            409,
          )
        }
      } catch (error) {
        if (error instanceof AppError)
          return apiErrorResponse(error)
        throw error
      }
    return NextResponse.json({ ok: true })
  },
});
