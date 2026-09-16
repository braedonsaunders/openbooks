import 'server-only'

import { NextResponse } from 'next/server'
import { AllocationRuleError } from '../../../../engine/src/allocations/index.ts'
import { isUuid } from '../../../lib/list-params'

/**
 * Map A1's service errors to HTTP: NOT_FOUND → 404, STALE → 409 (the drawer
 * reloads on the latest revision), INVALID/FROZEN → 422 with the stable
 * problem codes the drawer renders inline. Unexpected failures stay a
 * generic 500.
 */
export function allocationErrorResponse(error: unknown): NextResponse {
  if (error instanceof AllocationRuleError) {
    if (error.code === 'NOT_FOUND') return NextResponse.json({ error: error.message }, { status: 404 })
    if (error.code === 'STALE') {
      return NextResponse.json(
        { error: error.message, code: 'STALE' },
        { status: 409 },
      )
    }
    const body: { error: string; code: string; problems?: { code: string; message: string }[] } = {
      error: error.message,
      code: error.code,
    }
    if (error.problems) body.problems = error.problems
    return NextResponse.json(body, { status: 422 })
  }
  return NextResponse.json({ error: 'Unable to save the allocation rule.' }, { status: 500 })
}

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
