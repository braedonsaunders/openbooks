import { NextResponse } from 'next/server'
import { RendererUnavailableError, pdfRendererStatus, type PdfRendererStatus } from '@openbooks/pdf'

/**
 * The PDF renderer outage as a route refusal.
 *
 * A missing Chromium is an operator precondition, never a tenant fault, so
 * every route that renders a PDF must answer it with the named 503 refusal —
 * never the generic unexpected 500, which reads as a transient fault and
 * invites retries of a preview that can never succeed. Call FIRST in the
 * catch of every PDF render route:
 *
 *   } catch (e) {
 *     const refused = rendererUnavailableResponse(e)
 *     if (refused) return refused
 *     ...
 *   }
 *
 * The predicate also matches by error name so the refusal survives boundaries
 * that drop the prototype (a serialized flow error rethrown in a route still
 * carries `name: 'RendererUnavailableError'` and the message).
 */
export function isRendererUnavailable(error: unknown): boolean {
  if (error instanceof RendererUnavailableError) return true
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'RendererUnavailableError'
  )
}

/**
 * The named 503 refusal for a renderer outage, or null when the error is
 * anything else. The body carries the pool's message verbatim: the path it
 * tried and the remedy (install Chromium or set PUPPETEER_EXECUTABLE_PATH).
 */
export function rendererUnavailableResponse(error: unknown): NextResponse | null {
  if (!isRendererUnavailable(error)) return null
  console.error('[pdf] renderer unavailable', error)
  // The message rides on the object, not the prototype: a refusal that
  // crossed a serialization boundary is a plain object, not an Error, and
  // dropping its message would re-hide the path and the remedy.
  const carried =
    typeof error === 'object' && error !== null
      ? (error as { message?: unknown }).message
      : null
  const message =
    typeof carried === 'string' && carried.trim() !== '' ? carried : 'PDF renderer is unavailable'
  return NextResponse.json({ error: message }, { status: 503 })
}

/**
 * The same refusal from a readiness probe, for bulk routes that cannot map a
 * thrown error: emailRunStubs collects per-stub failures into result.failed
 * instead of throwing, so a total outage would otherwise report
 * `{ ok: true, sent: 0 }` with N identical failures. Check BEFORE the bulk
 * call — a verifiably absent executable cannot render, so refusing early is
 * exact, and a present-but-broken binary still surfaces per-item messages.
 */
export function rendererStatusResponse(status: PdfRendererStatus = pdfRendererStatus()): NextResponse | null {
  if (status.available) return null
  console.error('[pdf] renderer unavailable', status.message)
  return NextResponse.json({ error: status.message }, { status: 503 })
}
