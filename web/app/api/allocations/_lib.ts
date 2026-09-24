import 'server-only'

import { NextResponse } from 'next/server'
import { allocationRunErrorResponse } from '../../../lib/allocations-run-error'
import { isUuid } from '../../../lib/list-params'

export { allocationRunErrorResponse }

/**
 * Map A1's service errors to HTTP: NOT_FOUND → 404, STALE → 409 (the drawer
 * reloads on the latest revision), INVALID/FROZEN → 422 with the stable
 * problem codes the drawer renders inline. Unexpected failures stay a
 * generic 500.
 */
export { allocationErrorResponse, allocationWriteErrorResponse } from '../../../lib/allocations-run-error'

/** UUID path params 404 like the rest of the app's record routes. */
export function requireRuleId(id: string): string | NextResponse {
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return id
}

/** Revision tokens are mandatory on every mutation (A1 skips null — we do not). */
export function requireRevision(body: { expectedRevision?: unknown }): string | NextResponse {
  if (typeof body.expectedRevision !== 'string' || body.expectedRevision === '') {
    return NextResponse.json(
      { error: 'This record changed; reload and review the latest revision before saving.', code: 'STALE' },
      { status: 409 },
    )
  }
  return body.expectedRevision
}
