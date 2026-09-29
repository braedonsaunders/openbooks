import { apiErrorResponse } from '@/lib/api/error-response'
import { parseJsonBody } from "@/lib/api/json";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { parseInternalOrgId, requestHasInternalToken } from '../../../../../lib/internal-token'
import { OverheadPublishError, publishOverheadRates } from '../../../../../lib/overhead-publish'
import { guardProjectsFeature } from '../../../../../lib/projects-gate'
import { unexpectedServerError } from '../../../../../lib/api/unexpected'

export const runtime = 'nodejs'
const publishBody = z.object({
  orgId: z.string().uuid(),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
}).strict()

/**
 * Internal overhead-publish endpoint — the background worker calls this on
 * the scheduled cadence (the True Cost engine lives in web/lib; the worker
 * can't import it). Not a user route: authenticated by the shared internal
 * token, given orgId + effectiveFrom explicitly, and idempotent — publishing
 * twice for the same date replaces the same rows.
 *
 *   POST /api/internal/overhead/publish  { orgId, effectiveFrom }
 */
export const POST = defineRoute({
  public: 'token',
  handler: async ({ request: req }) => {
  // Constant-time compare that fails closed when no token is configured
  // (this route is public + CSRF-exempt: the token is its only control).
  if (!requestHasInternalToken(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const parsedBody = await parseJsonBody(req, publishBody, { status: 400 });
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data
  // The body schema rejects malformed ids before any org-scoped work; this
  // parser canonicalizes valid UUIDs before passing them to the feature gate.
  const orgId = parseInternalOrgId(body.orgId)
  const effectiveFrom = body.effectiveFrom
  if (!orgId) {
    return NextResponse.json({ error: 'orgId (uuid) and effectiveFrom (YYYY-MM-DD) are required' }, { status: 422 })
  }
  const feature = await guardProjectsFeature(orgId)
  if (feature) return feature
  try {
    const result = await publishOverheadRates(orgId, null, effectiveFrom)
    return NextResponse.json({ ok: true, ...result })
  } catch (e) {
    if (e instanceof OverheadPublishError) {
      return apiErrorResponse(e, { safeStatus: 409 })
    }
    return unexpectedServerError('internal/overhead/publish', e)
  }
  },
})
