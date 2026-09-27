import { defineRoute } from '@/lib/api/route';
import { apiErrorResponse } from '@/lib/api/error-response'
import { NextResponse } from 'next/server'
import { unexpectedServerError } from '@/lib/api/unexpected'
import { getFrontendBundle, AppError } from '@/lib/apps/store'

export const runtime = 'nodejs'

/**
 * GET — the inlined frontend bundle for the AppFrame. Returns the entry HTML
 * plus a path→data:URL map for every asset. Requires apps.use; the AppFrame
 * fetches this same-origin, then renders it into an opaque-origin sandbox.
 */
export const GET = defineRoute({
  permission: 'apps.use',
  feature: 'apps',
  handler: async ({ request: _req, authz: routeAuthz, params: routeParams }) => {
    const params = Promise.resolve(routeParams as { key: string });
    const gate = routeAuthz;
    const { key } = await params
    try {
        const bundle = await getFrontendBundle(gate.user.orgId, key)
        return NextResponse.json(bundle)
      } catch (e) {
        if (e instanceof AppError)
          return apiErrorResponse(e)
        return unexpectedServerError('apps/bundle', e)
      }
  },
});
