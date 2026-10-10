import { randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'
import { getTranslations } from 'next-intl/server'

/** A typed refusal is safe to show only when its class names the business condition and its status is 4xx. */
/**
 * A typed business refusal: a named error class (never a plain Error) with a
 * 4xx `status` or `statusCode`, or `safeStatus` when it carries neither. Only
 * these are safe to show; anything else is an unexpected failure.
 */
export function typedRefusal(error: unknown, safeStatus?: number): error is Error & { status?: number; statusCode?: number } {
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
    // A typed business refusal's remedy is part of its public result. Keep
    // only its named contract fields; unrelated Error internals stay private.
    // `details` carries structured evidence (never internals): plain objects
    // only, so a stray class instance or circular value cannot leak or crash
    // the serializer.
    const metadata: Record<string, unknown> = {}
    for (const key of ['code', 'remedy', 'field'] as const) {
      const value = (error as Error & { code?: unknown; remedy?: unknown; field?: unknown })[key]
      if (typeof value === 'string' && value.trim() !== '') metadata[key] = value
    }
    const details = (error as Error & { details?: unknown }).details
    if (details !== null && typeof details === 'object' && !Array.isArray(details)) {
      metadata.details = details
    }
    return NextResponse.json({ error: error.message, ...metadata, ...options.details }, { status })
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
