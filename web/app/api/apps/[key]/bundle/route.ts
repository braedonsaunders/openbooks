import { apiErrorResponse } from '@/lib/api/error-response'
import { NextResponse } from 'next/server'
import { guardFeaturePermission } from '@/lib/feature-gates'
import { unexpectedServerError } from '@/lib/api/unexpected'
import { getFrontendBundle, AppError } from '@/lib/apps/store'

export const runtime = 'nodejs'

/**
 * GET — the inlined frontend bundle for the AppFrame. Returns the entry HTML
 * plus a path→data:URL map for every asset. Requires apps.use; the AppFrame
 * fetches this same-origin, then renders it into an opaque-origin sandbox.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ key: string }> },
) {
  const gate = await guardFeaturePermission('apps.use', 'apps')
  if (gate instanceof NextResponse) return gate
  const { key } = await params
  try {
    const bundle = await getFrontendBundle(gate.user.orgId, key)
    return NextResponse.json(bundle)
  } catch (e) {
    if (e instanceof AppError)
      return apiErrorResponse(e)
    return unexpectedServerError('apps/bundle', e)
  }
}
