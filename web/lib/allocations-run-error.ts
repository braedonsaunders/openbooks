import { NextResponse } from 'next/server'
import { AllocationRuleError, AllocationRunError } from '../../engine/src/allocations/index.ts'

/**
 * Uniform record denial for allocation configuration writes: a missing
 * rule/version and an out-of-scope one answer the same bare 404, never an
 * id-bearing message that would confirm the record exists. Every other
 * error keeps the standard mapping.
 */
export function allocationWriteErrorResponse(error: unknown): NextResponse {
  if (error instanceof AllocationRuleError && error.code === 'NOT_FOUND') {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  return allocationErrorResponse(error)
}

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

/**
 * Named run refusals (closed period, lifecycle, missing run) stay 404/422
 * with the engine message. Unexpected defects stay a generic 500 so a
 * closed GL period never renders as "posting failed".
 */
export function allocationRunErrorResponse(error: unknown, fallback: string): NextResponse {
  if (error instanceof AllocationRunError) {
    return NextResponse.json(
      { error: error.message },
      { status: error.code === 'NOT_FOUND' ? 404 : 422 },
    )
  }
  console.error(fallback, error)
  return NextResponse.json({ error: fallback }, { status: 500 })
}
