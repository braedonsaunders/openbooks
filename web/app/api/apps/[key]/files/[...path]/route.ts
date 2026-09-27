import { defineRoute } from '@/lib/api/route';
import { apiErrorResponse } from '@/lib/api/error-response'
import { NextResponse } from 'next/server'
import { readAppFile, AppError } from '@/lib/apps/store'

export const runtime = 'nodejs'

function joined(path: string[]): string {
  return path.map(decodeURIComponent).join('/')
}

/** GET — one file's content (the editor pane). */
export const GET = defineRoute({
  permission: 'apps.manage',
  feature: 'apps',
  handler: async ({ request: _req, authz: routeAuthz, params: routeParams }) => {
    const params = Promise.resolve(routeParams as { key: string; path: string[] });
    const gate = routeAuthz;
    const { key, path } = await params
    try {
        const file = await readAppFile(gate.user.orgId, key, joined(path))
        return NextResponse.json({ file })
      } catch (e) {
        if (e instanceof AppError)
          return apiErrorResponse(e)
        throw e
      }
  },
});
