import 'server-only'
import { NextResponse } from 'next/server'
import { ProjectProgressError } from '@openbooks/engine/src/projects/progress.ts'
import { apiErrorResponse } from './api/error-response'
import { notFound } from './api/responses'

/**
 * API boundary for progress, forecast and earned-value refusals: a missing
 * (or out-of-scope) project or task answers as a bare 404, every other
 * refusal keeps its message, code and remedy; anything else is an
 * unexpected failure.
 */
export function progressErrorResponse(error: unknown): Promise<NextResponse> | NextResponse {
  if (error instanceof ProjectProgressError && error.status === 404) return notFound('record')
  return apiErrorResponse(error)
}
