import { NextResponse } from 'next/server'
import { AllocationRunError } from '../../engine/src/allocations/index.ts'

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
