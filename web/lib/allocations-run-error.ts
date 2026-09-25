import type { NextResponse } from 'next/server'
import { AllocationRuleError, AllocationRunError } from '../../engine/src/allocations/index.ts'
import { apiErrorResponse } from './api/error-response'

/**
 * Uniform record denial for allocation configuration writes: a missing
 * rule/version and an out-of-scope one answer the same bare 404, never an
 * id-bearing message that would confirm the record exists. Every other
 * error keeps the standard mapping.
 */
export async function allocationWriteErrorResponse(error: unknown): Promise<NextResponse> {
  if (error instanceof AllocationRuleError && error.code === 'NOT_FOUND') {
    return apiErrorResponse(new AllocationRuleError('NOT_FOUND', 'not found'), { safeStatus: 404 })
  }
  return allocationErrorResponse(error)
}

/**
 * Map A1's service errors to HTTP: NOT_FOUND → 404, STALE → 409 (the drawer
 * reloads on the latest revision), INVALID/FROZEN → 422 with the stable
 * problem codes the drawer renders inline. Unexpected failures stay a
 * generic 500.
 */
export async function allocationErrorResponse(error: unknown): Promise<NextResponse> {
  if (error instanceof AllocationRuleError) {
    if (error.code === 'NOT_FOUND') return apiErrorResponse(error, { safeStatus: 404 })
    if (error.code === 'STALE') {
      return apiErrorResponse(error, { safeStatus: 409, details: { code: 'STALE' } })
    }
    const details: Record<string, unknown> = {
      code: error.code,
    }
    if (error.problems) details.problems = error.problems
    return apiErrorResponse(error, { safeStatus: 422, details })
  }
  return apiErrorResponse(error)
}

/**
 * Named run refusals (closed period, lifecycle, missing run) stay 404/422
 * with the engine message. Unexpected defects stay a generic 500 so a
 * closed GL period never renders as "posting failed".
 */
export async function allocationRunErrorResponse(error: unknown, _fallback: string): Promise<NextResponse> {
  if (error instanceof AllocationRunError) {
    return apiErrorResponse(error, { safeStatus: error.code === 'NOT_FOUND' ? 404 : 422 })
  }
  return apiErrorResponse(error)
}
