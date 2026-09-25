import { randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'
import { getTranslations } from 'next-intl/server'

/** A typed refusal is safe to show only when its class names the business condition and its status is 4xx. */
function typedRefusal(error: unknown, safeStatus?: number): error is Error & { status?: number; statusCode?: number } {
  if (!(error instanceof Error) || error.constructor === Error) return false
  const status = 'status' in error ? error.status : 'statusCode' in error ? error.statusCode : safeStatus
  return typeof status === 'number' && Number.isInteger(status) && status >= 400 && status < 500
}

/** Shared API boundary for typed business refusals and unexpected failures. */
export async function apiErrorResponse(
  error: unknown,
  options: { request?: Request; safeStatus?: number; details?: Record<string, unknown> } = {},
): Promise<NextResponse> {
  if (typedRefusal(error, options.safeStatus)) {
    const status = ('status' in error ? error.status : 'statusCode' in error ? error.statusCode : options.safeStatus) as number
    return NextResponse.json({ error: error.message, ...options.details }, { status })
  }

  const requestId = randomUUID()
  console.error('Unhandled API error', { requestId, error, path: options.request ? new URL(options.request.url).pathname : undefined })
  let message = `An unexpected error occurred. Please try again. If the problem continues, contact support with request ID ${requestId}.`
  try {
    const t = await getTranslations('apiErrors')
    message = t('internalError', { requestId })
  } catch {
    // The fallback is used by route contexts that do not carry an intl request store.
  }
  return NextResponse.json(
    { error: message, requestId },
    { status: 500, headers: { 'x-request-id': requestId } },
  )
}
