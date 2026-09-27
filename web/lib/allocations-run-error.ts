import type { NextResponse } from 'next/server'
import { AllocationRuleError, AllocationRunError } from '../../engine/src/allocations/index.ts'
import { notFound } from '@/lib/api/responses'
import { apiErrorResponse } from './api/error-response'

/**
 * Uniform record denial for allocation configuration writes: a missing
 * rule/version and an out-of-scope one answer the same bare 404, never an
 * id-bearing message that would confirm the record exists. Every other
 * error keeps the standard mapping.
 */
export async function allocationWriteErrorResponse(error: unknown): Promise<NextResponse> {
  if (error instanceof AllocationRuleError && error.code === 'NOT_FOUND') {
    return notFound('record')
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
    if (error.code === 'NOT_FOUND') return notFound('record')
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
 * Missing runs use the uniform 404 body so their identifiers stay private.
 * Closed-period and lifecycle refusals retain the engine message at 422.
 * Unexpected defects stay a generic 500 so a closed GL period never renders
 * as "posting failed".
 */
export async function allocationRunErrorResponse(error: unknown, _fallback: string): Promise<NextResponse> {
  if (error instanceof AllocationRunError) {
    if (error.code === 'NOT_FOUND') return notFound('record')
    return apiErrorResponse(error, { safeStatus: 422 })
  }
  return apiErrorResponse(error)
}
