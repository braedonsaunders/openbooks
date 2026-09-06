import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { parseInternalOrgId, requestHasInternalToken } from '../../../../../lib/internal-token'
import { publishOverheadRates } from '../../../../../lib/overhead-publish'
import { guardProjectsFeature } from '../../../../../lib/projects-gate'

export const runtime = 'nodejs'

/**
 * Internal overhead-publish endpoint — the background worker calls this on
 * the scheduled cadence (the True Cost engine lives in web/lib; the worker
 * can't import it). Not a user route: authenticated by the shared internal
 * token, given orgId + effectiveFrom explicitly, and idempotent — publishing
 * twice for the same date replaces the same rows.
 *
 *   POST /api/internal/overhead/publish  { orgId, effectiveFrom }
 */
export async function POST(req: Request) {
  // Constant-time compare that fails closed when no token is configured
  // (this route is public + CSRF-exempt: the token is its only control).
  if (!requestHasInternalToken(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data
  // Validate the org id BEFORE any org-scoped work (feature gate, RLS scope):
  // an unparsable id must be a 422 here, never a Postgres cast error later.
  const orgId = parseInternalOrgId(body.orgId)
  const effectiveFrom = typeof body.effectiveFrom === 'string' ? body.effectiveFrom : ''
  if (!orgId || !/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) {
    return NextResponse.json({ error: 'orgId (uuid) and effectiveFrom (YYYY-MM-DD) are required' }, { status: 422 })
  }
  const feature = await guardProjectsFeature(orgId)
  if (feature) return feature
  try {
    const result = await publishOverheadRates(orgId, null, effectiveFrom)
    return NextResponse.json({ ok: true, ...result })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
