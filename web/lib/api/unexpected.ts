import { NextResponse } from 'next/server'

/**
 * The last-resort branch of a route's error boundary.
 *
 * An error that is not a typed domain refusal is an unexpected fault — a
 * driver error, a broken invariant. It is logged server-side and answered with
 * a generic 500, so a PostgreSQL constraint string or an internal identifier is
 * never disclosed to the caller. A route must map every domain refusal to its
 * real status and remedy BEFORE reaching this; this is what remains when it
 * cannot.
 *
 * `scope` is a short route label ("search", "payments/deliver") so the server
 * log identifies the fault without the response naming it.
 */
export function unexpectedServerError(scope: string, error: unknown): NextResponse {
  console.error(`[${scope}] unexpected failure`, error)
  return NextResponse.json(
    { error: 'request failed; retry, and contact support if it persists' },
    { status: 500 },
  )
}